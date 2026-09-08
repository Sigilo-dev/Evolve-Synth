import type { Frame, Locator } from "playwright";
import { resolveActiveCambridgeContext } from "./activityFrame.js";
import { CurrentScreenService } from "./CurrentScreenService.js";
import { FeedbackParser } from "./FeedbackParser.js";
import { findCheckButtonInScopes, findSafeNextButtonInScopes, detectActivityEnd } from "./activityControls.js";
import { InteractionDetector } from "./InteractionDetector.js";
import { ActivityRepository, type RunSummary } from "../storage/ActivityRepository.js";
import type { BrowserSessionManager } from "../browser/BrowserSessionManager.js";
import { AutomationLimits } from "../config.js";
import { captureDiagnostic } from "../storage/Diagnostics.js";
import { currentScreenNumber } from "./screenReader.js";

export type EngineRunState = "RUNNING" | "DETECTING_SCREEN" | "ANSWERING" | "VERIFYING" | "CHECKING" | "RECORDING" | "ADVANCING" | "FINISHED" | "STOPPED" | "ERROR" | "UNSUPPORTED";
type Status = (state: EngineRunState, message: string, details?: Record<string, unknown>) => void;
type Trace = (message: string) => void;

export class ActivityRunner {
  private cancelled = false;
  private starting = false;
  private activeRunId: number | undefined;
  private readonly detector = new InteractionDetector();
  private readonly screenService = new CurrentScreenService();
  private readonly feedback = new FeedbackParser();
  constructor(private readonly browser: BrowserSessionManager, private readonly repository: ActivityRepository, private readonly emit: Status, private readonly dataDirectory: string, private readonly trace: Trace = () => undefined) {}

  get isRunning(): boolean { return this.starting || this.activeRunId !== undefined; }
  stop(): void { this.cancelled = true; }
  async run(): Promise<RunSummary | undefined> {
    if (this.isRunning) throw new Error("An activity run is already in progress.");
    this.starting = true;
    this.cancelled = false;
    try {
      const context = await resolveActiveCambridgeContext(this.browser.getPages(), this.trace);
      if (!context) { this.emit("ERROR", "ACTIVITY_NOT_FOUND"); return undefined; }
      if (this.cancelled) { this.emit("STOPPED", "Stopped by user"); return undefined; }
      const frame = context.frame;
      const controlsFrame = context.page.mainFrame();
      const metadata = await this.activityMetadata(frame);
      const runId = this.repository.startRun(metadata.name, metadata.url);
      this.activeRunId = runId;
      this.repository.recordEvent(runId, "INFO", "RUN_STARTED", metadata.name);
      this.emit("RUNNING", "Activity running", { runId, activityName: metadata.name, screenNumber: context.screenNumber });
      let processed = 0;
      while (!this.cancelled) {
        if (processed >= AutomationLimits.maxScreensPerRun) return this.finish(runId, "ERROR", "MAX_SCREENS_PER_RUN", null, null, frame, null);
        const end = await detectActivityEnd(frame);
        if (end.ended) return this.finish(runId, "FINISHED", end.reason!, end.score, end.maximumScore);
        this.emit("DETECTING_SCREEN", "Detecting current screen");
        const screen = await this.detector.activeScreen(frame);
        if (!screen) return this.finish(runId, "ERROR", "ACTIVE_SCREEN_NOT_FOUND", null, null, frame, null);
        if (await this.isPresentationScreen(screen)) {
          const screenNumber = await currentScreenNumber(frame);
          const text = await screen.innerText().catch(() => "");
          if (/\byou have scored\b/i.test(text)) return this.finish(runId, "FINISHED", "Result text detected", null, null);
          this.emit("ADVANCING", "Skipping information screen", { screenNumber });
          const next = await findSafeNextButtonInScopes(controlsFrame, frame);
          if (!next) return this.finish(runId, "ERROR", "NEXT_BUTTON_NOT_FOUND", null, null, frame, screenNumber);
          if (this.cancelled) break;
          await next.click();
          this.trace(`INFORMATION_SCREEN_SKIPPED screen=${screenNumber ?? "unknown"}`);
          await this.waitForScreenChange(frame, screenNumber);
          processed += 1;
          continue;
        }
        if (await this.screenAlreadyEvaluated(frame, screen)) return this.finish(runId, "ERROR", "SCREEN_ALREADY_EVALUATED", null, null, frame, null);
        const analysis = await this.screenService.analyze(frame);
        if (analysis.outcome === "UNSUPPORTED_INTERACTION") return this.finish(runId, "UNSUPPORTED", "UNSUPPORTED_INTERACTION", null, null, frame, analysis.screenNumber);
        const totalScreens = await frame.locator("li.step").count();
        this.trace(`ANSWER_STARTED screen=${analysis.screenNumber ?? "unknown"} type=${analysis.interactionType}`);
        this.emit("ANSWERING", `Answering screen ${analysis.screenNumber ?? "?"}`, { screenNumber: analysis.screenNumber, totalScreens, interactionType: analysis.interactionType });
        const answer = await this.screenService.answerWithFirstOption(frame);
        if (answer.outcome === "UNSUPPORTED_INTERACTION") return this.finish(runId, "UNSUPPORTED", "UNSUPPORTED_INTERACTION", null, null, frame, answer.screenNumber);
        if (answer.outcome === "FAILED") {
          this.trace(`ANSWER_FAILED screen=${answer.screenNumber ?? "unknown"} reason=${answer.message}`);
          return this.finish(runId, "ERROR", this.errorCode(answer.message), null, null, frame, answer.screenNumber);
        }
        if (this.cancelled) break;
        this.emit("VERIFYING", "Selection verified", { screenNumber: answer.screenNumber, totalScreens, interactionType: answer.interactionType });
        this.trace(`ANSWER_VERIFIED screen=${answer.screenNumber ?? "unknown"}`);
        const submitted = await this.feedback.captureSubmitted(screen);
        const screenId = this.repository.recordScreen(runId, answer, submitted);
        this.repository.recordEvent(runId, "INFO", "ANSWER_SELECTED", `Screen ${answer.screenNumber ?? "?"}: ${submitted.length} selections`);
        this.emit("CHECKING", `Checking screen ${answer.screenNumber ?? "?"}`, { screenNumber: answer.screenNumber, interactionType: answer.interactionType });
        const check = await findCheckButtonInScopes(controlsFrame, frame);
        if (!check) return this.finish(runId, "ERROR", "CHECK_BUTTON_NOT_FOUND", null, null, frame, answer.screenNumber);
        if (this.cancelled) break;
        await check.click();
        this.trace(`CHECK_CLICKED screen=${answer.screenNumber ?? "unknown"}`);
        const result = await this.feedback.waitAndParse(frame, screen);
        this.trace(`FEEDBACK_RECEIVED screen=${answer.screenNumber ?? "unknown"} result=${result.result}`);
        this.emit("RECORDING", "Recording Cambridge feedback", { screen: answer.screenNumber, result: result.result });
        this.repository.completeScreen(screenId, result);
        this.repository.recordEvent(runId, "INFO", "FEEDBACK_PARSED", `Screen ${answer.screenNumber ?? "?"}: ${result.result}`);
        if (this.cancelled) break;
        const afterCheckEnd = await detectActivityEnd(frame);
        if (afterCheckEnd.ended) return this.finish(runId, "FINISHED", afterCheckEnd.reason!, afterCheckEnd.score, afterCheckEnd.maximumScore);
        this.emit("ADVANCING", "Advancing to next screen", { screen: answer.screenNumber });
        const next = await findSafeNextButtonInScopes(controlsFrame, frame);
        if (!next) return this.finish(runId, "ERROR", "NEXT_BUTTON_NOT_FOUND", null, null, frame, answer.screenNumber);
        if (this.cancelled) break;
        await next.click();
        this.trace(`NEXT_CLICKED screen=${answer.screenNumber ?? "unknown"}`);
        await this.waitForScreenChange(frame, answer.screenNumber);
        processed += 1;
      }
      return this.finish(runId, "STOPPED", "Stopped by user", null, null);
    } catch (error) {
      const message = this.errorCode(error instanceof Error ? error.message : String(error));
      if (this.activeRunId !== undefined) return this.finish(this.activeRunId, "ERROR", message, null, null);
      this.emit("ERROR", message);
      return undefined;
    } finally { this.activeRunId = undefined; this.starting = false; }
  }

  private async finish(runId: number, state: "FINISHED" | "STOPPED" | "ERROR" | "UNSUPPORTED", reason: string, score: number | null, maximumScore: number | null, frame?: Frame, screen?: number | null): Promise<RunSummary> {
    const screenshot = state === "ERROR" && frame ? await captureDiagnostic(frame, this.dataDirectory, screen ?? null, reason) : undefined;
    this.repository.recordEvent(runId, state === "ERROR" ? "ERROR" : "INFO", "RUN_FINISHED", reason);
    const summary = this.repository.finishRun(runId, state, reason, score, maximumScore);
    this.emit(state, state === "FINISHED" ? "Activity completed" : reason, { summary, ...(screenshot ? { diagnosticScreenshot: screenshot } : {}) });
    return summary;
  }
  private async activityMetadata(frame: Frame): Promise<{ name: string; url: string }> {
    const title = frame.locator("h1, .activity-title, [data-activity-title]").first();
    // Do not let an optional title delay the run: this frame commonly has no h1.
    const name = await title.count()
      ? ((await title.innerText({ timeout: AutomationLimits.shortTimeoutMs }).catch(() => "")).replace(/\s+/g, " ").trim())
      : "";
    return { name: name || "Cambridge Activity", url: frame.url() };
  }
  private async waitForScreenChange(frame: Frame, previous: number | null): Promise<void> {
    await frame.waitForFunction(({ numberSelector, previousNumber }) => {
      const text = document.querySelector(numberSelector)?.textContent?.trim();
      return text ? Number(text) !== previousNumber : document.querySelector(".content-wrap:not(.activity--hidden)") !== null;
    }, { numberSelector: "li.step.current .step-number", previousNumber: previous }, { timeout: AutomationLimits.normalTimeoutMs });
  }
  private async screenAlreadyEvaluated(frame: Frame, screen: Locator): Promise<boolean> {
    const feedback = frame.locator("#feedback-panel").first();
    if (await feedback.count() && await feedback.isVisible().catch(() => false)) return true;
    return await screen.locator(".checked-correct, .checked-incorrect, .checked-empty").count() > 0;
  }
  private async isPresentationScreen(screen: Locator): Promise<boolean> {
    return await screen.locator(".interaction.pp-present").count() > 0 || await screen.locator(".interaction").count() === 0;
  }
  private errorCode(message: string): string {
    if (/timed out waiting for cambridge evaluation/i.test(message)) return "FEEDBACK_TIMEOUT";
    if (/frame|navigation|target closed/i.test(message)) return "ACTIVITY_FRAME_UNAVAILABLE";
    if (/checkbox|radio|dropdown|gap/i.test(message)) return "SELECTION_VERIFICATION_FAILED";
    return "UNEXPECTED_AUTOMATION_ERROR";
  }
}
