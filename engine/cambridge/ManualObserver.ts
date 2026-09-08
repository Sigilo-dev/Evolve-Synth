import type { Frame, Locator } from "playwright";
import type { BrowserSessionManager } from "../browser/BrowserSessionManager.js";
import { AutomationLimits } from "../config.js";
import type { ActivityRepository, RunSummary } from "../storage/ActivityRepository.js";
import { resolveActiveCambridgeContext } from "./activityFrame.js";
import { CurrentScreenService } from "./CurrentScreenService.js";
import { FeedbackParser, type FeedbackResult } from "./FeedbackParser.js";
import { CambridgeSelectors } from "./selectors.js";
import type { ScreenAnalysis } from "./types.js";

type Status = (state: "OBSERVING" | "FINISHED" | "ERROR", message: string, details?: Record<string, unknown>) => void;
type Observation = {
  analysis: ScreenAnalysis;
  feedbackRecorded: boolean;
  feedbackPendingLogged: boolean;
};
type FeedbackSnapshot = {
  fingerprint: string;
  screenNumber: number | null;
  analysis: ScreenAnalysis;
  result: FeedbackResult["result"];
  correctAnswers: string[];
  textPrefixes: Array<{ slotNumber: number | null; answerPrefix: string }>;
};
export type CorrectScreen = {
  screenNumber: number | null;
  question: string;
  answers: string[];
  // `""` is meaningful: the learner starts with no letters and must copy the
  // whole answer. `null` means this was not a text-gap interaction.
  answerPrefixes: Array<string | null>;
};
type ObserverStatus = { state: "OBSERVING" | "FINISHED"; message: string; details: Record<string, unknown> };

export function retainCorrectFeedback(feedback: FeedbackResult): FeedbackResult {
  // When Cambridge exposes a "Correct answer(s)" panel, it is the only
  // source retained. It contains the complete authoritative list, whereas
  // DOM answer state also includes the user's selections.
  const textGapSources = feedback.answers
    .filter(answer => answer.answerPrefix !== null)
    .map(answer => ({ ...answer, wasSelected: false, wasCorrect: null }));
  const answers = feedback.correctAnswers.length > 0
    // Keep only harmless text-gap prefix metadata. The learner's submitted
    // value is deliberately not treated as a correct answer.
    ? textGapSources
    : feedback.result === "CORRECT"
      ? feedback.answers.filter(answer => answer.wasSelected).map(answer => ({ ...answer, wasCorrect: true }))
      : feedback.answers.filter(answer => answer.wasCorrect === true);
  return { ...feedback, feedback: "", answers };
}

export function displayAnswerPrefixes(feedback: FeedbackResult): Array<string | null> {
  const displayed = displayCorrectAnswerTexts(feedback);
  const sources = feedback.answers.filter(answer => answer.answerPrefix !== null);
  return displayed.map((value, index) => {
    const numbered = value.match(/^(\d+)\s*[.:-]?\s+(.+)$/);
    const slotNumber = numbered ? Number(numbered[1]) : null;
    const bySlot = slotNumber === null ? undefined : sources.find(answer => answer.slotNumber === slotNumber);
    const byPosition = sources.length === displayed.length ? sources[index] : undefined;
    const onlySource = sources.length === 1 ? sources[0] : undefined;
    return bySlot?.answerPrefix ?? byPosition?.answerPrefix ?? onlySource?.answerPrefix ?? null;
  });
}

export function displayCorrectAnswerTexts(feedback: FeedbackResult): string[] {
  // Do not collapse repeated values: "1 True" and "3 True" are two
  // different correct answers in separate slots.
  const values = feedback.correctAnswers.length > 0
    ? feedback.correctAnswers
    : feedback.answers.map(answer => answer.answerText);
  return values
    .map(answer => answer.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function screenKey(analysis: ScreenAnalysis): string {
  // Cambridge's step number is the stable identity for one activity screen.
  // Question text can change after evaluation (or include feedback), so it is
  // deliberately only a fallback when the activity omits a current step.
  if (analysis.screenNumber !== null && Number.isFinite(analysis.screenNumber)) return `screen:${analysis.screenNumber}`;
  return `question:${analysis.questionText.replace(/\s+/g, " ").trim().toLocaleLowerCase()}`;
}

/** Watches a user-driven Cambridge session. It never clicks or fills an answer. */
export class ManualObserver {
  private runId: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private capturePromise: Promise<void> | undefined;
  private readonly screens = new Map<string, Observation>();
  private readonly correctScreens = new Map<string, CorrectScreen>();
  private readonly currentScreen = new CurrentScreenService();
  private readonly feedback = new FeedbackParser();
  private lastSaved: ObserverStatus | undefined;
  private activityFrame: Frame | undefined;

  constructor(private readonly browser: BrowserSessionManager, private readonly repository: ActivityRepository, private readonly emit: Status, private readonly trace: (message: string) => void) {}

  get isObserving(): boolean { return this.runId !== undefined; }
  get currentStatus(): ObserverStatus | undefined {
    return this.runId === undefined ? undefined : {
      state: "OBSERVING",
      message: "Recording correct answers — Ctrl+Shift+O stops and saves",
      details: this.statusDetails(this.runId)
    };
  }
  get lastSavedStatus(): ObserverStatus | undefined { return this.lastSaved; }

  async toggle(): Promise<RunSummary | undefined> { return this.isObserving ? this.stop() : this.start(); }

  private async start(): Promise<undefined> {
    if (!this.browser.isOpen()) { this.emit("ERROR", "BROWSER_NOT_CONNECTED"); return undefined; }
    const context = await resolveActiveCambridgeContext(this.browser.getPages(), this.trace);
    if (!context) { this.emit("ERROR", "ACTIVITY_NOT_FOUND"); return undefined; }
    this.activityFrame = context.frame;
    this.screens.clear();
    this.correctScreens.clear();
    this.lastSaved = undefined;
    this.runId = this.repository.startRun("Cambridge Correct Answers", context.page.url().split("?")[0]);
    this.repository.recordEvent(this.runId, "INFO", "OBSERVATION_STARTED", "Correct-answer recording started");
    this.emit("OBSERVING", "Recording correct answers — Ctrl+Shift+O stops and saves", this.statusDetails(this.runId, context.screenNumber, context.interactionType));
    try {
      await this.resetFeedbackMonitor(context.frame);
      await this.installFeedbackMonitor(context.frame);
      await this.capture();
    } catch (error) {
      this.reportCaptureFailure(error);
    }
    this.timer = setInterval(() => this.scheduleCapture(), AutomationLimits.observationPollMs);
    return undefined;
  }

  private async stop(): Promise<RunSummary | undefined> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.capturePromise;
    try {
      await this.capture();
    } catch (error) {
      this.reportCaptureFailure(error);
    }
    const runId = this.runId;
    if (!runId) return undefined;
    this.runId = undefined;
    this.repository.recordEvent(runId, "INFO", "OBSERVATION_STOPPED", "Correct-answer recording stopped");
    const summary = this.repository.finishRun(runId, "FINISHED", "Correct-answer recording saved", null, null);
    if (this.activityFrame) await this.resetFeedbackMonitor(this.activityFrame);
    this.activityFrame = undefined;
    this.lastSaved = {
      state: "FINISHED",
      message: "Correct answers saved",
      details: { summary, correctScreens: [...this.correctScreens.values()] }
    };
    this.emit(this.lastSaved.state, this.lastSaved.message, this.lastSaved.details);
    return summary;
  }

  private scheduleCapture(): void {
    if (this.capturePromise || !this.isObserving) return;
    this.capturePromise = this.capture()
      .catch(error => this.reportCaptureFailure(error))
      .finally(() => { this.capturePromise = undefined; });
  }

  private reportCaptureFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const runId = this.runId;
    this.trace(`OBSERVATION_CAPTURE_FAILED reason=${message}`);
    if (runId !== undefined) {
      this.repository.recordEvent(runId, "WARN", "OBSERVATION_CAPTURE_FAILED", message);
    }
  }

  private async capture(): Promise<void> {
    const runId = this.runId;
    if (!runId || !this.browser.isOpen()) return;
    const frame = await this.resolveObservationFrame();
    if (!frame) return;
    await this.installFeedbackMonitor(frame);
    await this.captureFeedbackSnapshots(frame, runId);
    const analysis = await this.currentScreen.analyze(frame);
    const screen = await this.activeScreen(frame);
    if (!screen) return;
    const key = screenKey(analysis);
    let observation = this.screens.get(key);
    if (!observation) {
      // No answer text is retained before Cambridge confirms correctness.
      observation = {
        analysis,
        feedbackRecorded: false,
        feedbackPendingLogged: false,
      };
      this.screens.set(key, observation);
      this.repository.recordEvent(runId, "INFO", "SCREEN_OBSERVED", `Screen ${analysis.screenNumber ?? "?"}: awaiting feedback`);
    }
    if (!observation.feedbackRecorded && await this.isEvaluated(frame, screen)) {
      const feedback = await this.feedback.parse(frame, screen);
      const correctFeedback = retainCorrectFeedback(feedback);
      const answers = displayCorrectAnswerTexts(correctFeedback);
      const answerPrefixes = displayAnswerPrefixes(correctFeedback);
      // Cambridge creates the feedback panel before it has applied the
      // checked-* classes or inserted "Correct answers". Do not permanently
      // mark this screen as read until there is actual correct-answer data.
      if (answers.length === 0) {
        if (!observation.feedbackPendingLogged) {
          observation.feedbackPendingLogged = true;
          this.repository.recordEvent(runId, "INFO", "FEEDBACK_PENDING", `Screen ${analysis.screenNumber ?? "?"}: evaluation visible, waiting for correct-answer details`);
          this.trace(`OBSERVATION_FEEDBACK_PENDING screen=${analysis.screenNumber ?? "unknown"} result=${feedback.result}`);
        }
        return;
      }
      if (answers.length) {
        const screenId = this.repository.recordScreen(runId, observation.analysis);
        this.repository.completeScreen(screenId, correctFeedback);
        this.correctScreens.set(key, { screenNumber: analysis.screenNumber, question: analysis.questionText, answers, answerPrefixes });
      }
      observation.feedbackRecorded = true;
      this.repository.recordEvent(runId, "INFO", "FEEDBACK_OBSERVED", `Screen ${analysis.screenNumber ?? "?"}: ${feedback.result}; correct answers=${answers.length}`);
      this.trace(`OBSERVATION_FEEDBACK_CAPTURED screen=${analysis.screenNumber ?? "unknown"} result=${feedback.result} correctAnswers=${answers.length}`);
      this.emit("OBSERVING", "Recording correct answers — Ctrl+Shift+O stops and saves", this.statusDetails(runId, analysis.screenNumber, analysis.interactionType));
    }
  }

  /**
   * Feedback can disappear as soon as the learner presses Next. The observer
   * below runs in the Cambridge document and copies the evaluated answer list
   * at mutation time. It does not alter the page or interact with controls.
   */
  private async installFeedbackMonitor(frame: Frame): Promise<void> {
    await frame.evaluate(() => {
      type Snapshot = {
        fingerprint: string;
        screenNumber: number | null;
        analysis: ScreenAnalysis;
        result: FeedbackResult["result"];
        correctAnswers: string[];
        textPrefixes: Array<{ slotNumber: number | null; answerPrefix: string }>;
      };
      type MonitorHost = Window & typeof globalThis & {
        __evolveSynthFeedbackMonitor?: { snapshots: Snapshot[]; fingerprints: Set<string>; observer: MutationObserver };
      };
      const host = window as MonitorHost;
      if (host.__evolveSynthFeedbackMonitor) return;

      const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const withCategories = (lines: string[]) => {
        let category = "";
        return lines.flatMap(line => {
          if (/^[^\d][^:]{1,80}:$/.test(line)) { category = line.slice(0, -1).trim(); return []; }
          return [category ? `${category}: ${line}` : line];
        });
      };
      const answerText = (element: Element) => clean(element.textContent) || [...element.querySelectorAll("img[alt]")]
        .map(image => clean(image.getAttribute("alt")))
        .filter(Boolean)
        .join("; ");
      const activeScreen = () => document.querySelector(".content-wrap:not(.activity--hidden)");
      const screenNumber = () => {
        const direct = Number.parseInt(clean(document.querySelector("li.step.current .step-number")?.textContent), 10);
        if (Number.isFinite(direct)) return direct;
        const current = document.querySelector("li.step.current");
        return current?.parentElement ? [...current.parentElement.querySelectorAll("li.step")].indexOf(current) + 1 || null : null;
      };
      const interactionType = (interaction: Element | null): ScreenAnalysis["interactionType"] => {
        if (!interaction) return "UNSUPPORTED";
        if (interaction.matches(".is-radiobutton")) return "SINGLE_CHOICE";
        if (interaction.matches(".is-checkbox")) return "MULTIPLE_CHOICE";
        if (interaction.matches(".is-dropdown")) return "DROPDOWN";
        if (interaction.matches(".drag-drop")) return "GAP_MATCH";
        if (interaction.matches(".ic-text-gap")) return "TEXT_INPUT";
        return "UNSUPPORTED";
      };
      const readSnapshot = (): Snapshot | undefined => {
        const panel = document.querySelector("#feedback-panel");
        const screen = activeScreen();
        if (!(panel instanceof HTMLElement) || !(screen instanceof HTMLElement)) return undefined;
        // offsetParent is null for valid fixed-position Cambridge feedback panels.
        // Use the CSS state rather than layout parentage to reject only hidden panels.
        const panelStyle = getComputedStyle(panel);
        if (panelStyle.display === "none" || panelStyle.visibility === "hidden" || panelStyle.visibility === "collapse" || Number(panelStyle.opacity) === 0) return undefined;
        const heading = [...panel.querySelectorAll("strong")].find(node => /correct answers?:/i.test(node.textContent ?? ""));
        const answerContainer = heading?.closest("p") ?? heading?.parentElement;
        const textAnswers = answerContainer ? (() => {
          const answerClone = answerContainer.cloneNode(true) as HTMLElement;
          answerClone.querySelectorAll("br").forEach(lineBreak => lineBreak.replaceWith("\n"));
          return (answerClone.textContent || "").replace(/correct answers?:/i, "").split(/\n|\s{2,}/).map(clean).filter(Boolean);
        })() : [];
        const explicitAnswers = textAnswers.length
          ? withCategories(textAnswers)
          : answerContainer ? [...answerContainer.querySelectorAll("img[alt]")].map(image => clean(image.getAttribute("alt"))).filter(Boolean) : [];
        const result: FeedbackResult["result"] = panel.classList.contains("all-correct")
          ? "CORRECT" : panel.classList.contains("some-errors") ? "SOME_ERRORS" : "UNKNOWN";
        const interaction = screen.querySelector(".interaction");
        const clone = interaction?.cloneNode(true) as HTMLElement | undefined;
        clone?.querySelectorAll('[role="radio"], [role="checkbox"], [role="combobox"], [role="option"], .wordpool, button, [class*="feedback"], .check').forEach(node => node.remove());
        const selected = result === "CORRECT" ? [
          ...screen.querySelectorAll('[role="radio"][aria-checked="true"], [role="checkbox"][aria-checked="true"], [role="option"][aria-selected="true"], .drop_area.gap_match_gap_view, .input-text input[type="text"], input[type="text"]')
        ].map(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? clean(element.value) : answerText(element)).filter(Boolean) : [];
        const correctAnswers = explicitAnswers.length ? explicitAnswers : selected;
        if (!correctAnswers.length) return undefined;
        const textPrefixes = [...screen.querySelectorAll(".input-text input[type='text'], .input-text textarea, input[type='text'], textarea")]
          .map(input => {
            const label = input.getAttribute("aria-label") ?? "";
            const gap = label.match(/Gap\s+(\d+)/i);
            return {
              slotNumber: gap ? Number(gap[1]) : null,
              answerPrefix: clean((input.getAttribute("placeholder") ?? "").split("_")[0])
            };
          });
        const analysis: ScreenAnalysis = {
          screenNumber: screenNumber(),
          interactionType: interactionType(interaction),
          questionText: clean(clone?.innerText),
          options: [],
          externalModelIds: [],
          selectedAnswers: []
        };
        const fingerprint = `${analysis.screenNumber ?? "unknown"}|${result}|${correctAnswers.join("\\u001f")}|${analysis.questionText}`;
        return { fingerprint, screenNumber: analysis.screenNumber, analysis, result, correctAnswers, textPrefixes };
      };
      const snapshots: Snapshot[] = [];
      const fingerprints = new Set<string>();
      const capture = () => {
        const snapshot = readSnapshot();
        if (snapshot && !fingerprints.has(snapshot.fingerprint)) {
          fingerprints.add(snapshot.fingerprint);
          snapshots.push(snapshot);
        }
      };
      const observer = new MutationObserver(capture);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "aria-checked", "aria-selected"] });
      host.__evolveSynthFeedbackMonitor = { snapshots, fingerprints, observer };
      capture();
    }).catch(error => this.trace(`OBSERVATION_MONITOR_INSTALL_FAILED reason=${error instanceof Error ? error.message : String(error)}`));
  }

  private async resetFeedbackMonitor(frame: Frame): Promise<void> {
    await frame.evaluate(() => {
      type MonitorHost = Window & typeof globalThis & {
        __evolveSynthFeedbackMonitor?: { observer: MutationObserver };
      };
      const host = window as MonitorHost;
      host.__evolveSynthFeedbackMonitor?.observer.disconnect();
      delete host.__evolveSynthFeedbackMonitor;
    }).catch(() => undefined);
  }

  private async captureFeedbackSnapshots(frame: Frame, runId: number): Promise<void> {
    const snapshots = await frame.evaluate(() => {
      type MonitorHost = Window & typeof globalThis & { __evolveSynthFeedbackMonitor?: { snapshots: FeedbackSnapshot[] } };
      const monitor = (window as MonitorHost).__evolveSynthFeedbackMonitor;
      return monitor?.snapshots.splice(0) ?? [];
    }).catch(() => [] as FeedbackSnapshot[]);
    for (const snapshot of snapshots) {
      const snapshotKey = screenKey(snapshot.analysis);
      const existing = this.screens.get(snapshotKey);
      const analysis = existing?.analysis ?? snapshot.analysis;
      const key = screenKey(analysis);
      const observation = existing ?? { analysis, feedbackRecorded: false, feedbackPendingLogged: false };
      if (observation.feedbackRecorded) continue;
      this.screens.set(key, observation);
      const feedback = retainCorrectFeedback({
        result: snapshot.result,
        feedback: "",
        correctAnswers: snapshot.correctAnswers,
        answers: snapshot.textPrefixes.map(source => ({
          externalModelId: null,
          slotNumber: source.slotNumber,
          answerText: source.answerPrefix,
          answerPrefix: source.answerPrefix,
          wasSelected: false,
          wasCorrect: null
        }))
      });
      const answers = displayCorrectAnswerTexts(feedback);
      const answerPrefixes = displayAnswerPrefixes(feedback);
      if (!answers.length) continue;
      const screenId = this.repository.recordScreen(runId, analysis);
      this.repository.completeScreen(screenId, feedback);
      this.correctScreens.set(key, { screenNumber: analysis.screenNumber, question: analysis.questionText, answers, answerPrefixes });
      observation.feedbackRecorded = true;
      this.repository.recordEvent(runId, "INFO", "FEEDBACK_SNAPSHOT_CAPTURED", `Screen ${analysis.screenNumber ?? "?"}: ${snapshot.result}; correct answers=${answers.length}`);
      this.trace(`OBSERVATION_FEEDBACK_SNAPSHOT_CAPTURED screen=${analysis.screenNumber ?? "unknown"} result=${snapshot.result} correctAnswers=${answers.length}`);
      this.emit("OBSERVING", "Recording correct answers — Ctrl+Shift+O stops and saves", this.statusDetails(runId, analysis.screenNumber, analysis.interactionType));
    }
  }

  private statusDetails(runId: number, screenNumber?: number | null, interactionType?: string): Record<string, unknown> {
    return {
      runId,
      ...(screenNumber === undefined ? {} : { screenNumber }),
      ...(interactionType === undefined ? {} : { interactionType }),
      correctScreens: [...this.correctScreens.values()]
    };
  }
  private async resolveObservationFrame(): Promise<Frame | undefined> {
    if (this.activityFrame) {
      try {
        if (await this.activityFrame.locator(CambridgeSelectors.activityRoot).count()) return this.activityFrame;
      } catch {
        // A navigation can detach a frame; use the full resolver only then.
      }
      this.activityFrame = undefined;
    }
    const context = await resolveActiveCambridgeContext(this.browser.getPages());
    this.activityFrame = context?.frame;
    return this.activityFrame;
  }
  private async activeScreen(frame: Frame): Promise<Locator | undefined> {
    const screen = frame.locator(CambridgeSelectors.activeScreen).first();
    return await screen.count() ? screen : undefined;
  }
  private async isEvaluated(frame: Frame, screen: Locator): Promise<boolean> {
    const panel = frame.locator(CambridgeSelectors.feedbackPanel).first();
    return Boolean(await panel.count() && await panel.isVisible().catch(() => false))
      || await screen.locator(".checked-correct, .checked-incorrect, .checked-empty").count() > 0;
  }
}
