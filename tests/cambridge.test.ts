import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractionDetector } from "../engine/cambridge/InteractionDetector.js";
import { CurrentScreenService } from "../engine/cambridge/CurrentScreenService.js";
import { RadioHandler, CheckboxHandler, DropdownHandler, GapMatchHandler } from "../engine/cambridge/handlers.js";
import { FeedbackParser, type FeedbackResult } from "../engine/cambridge/FeedbackParser.js";
import { detectActivityEnd } from "../engine/cambridge/activityControls.js";
import { findCheckButtonInScopes } from "../engine/cambridge/activityControls.js";
import { resolveActiveCambridgeContext } from "../engine/cambridge/activityFrame.js";
import { displayAnswerPrefixes, displayCorrectAnswerTexts, retainCorrectFeedback, screenKey } from "../engine/cambridge/ManualObserver.js";
import { RunJob } from "../engine/RunJob.js";
import { ActivityRepository } from "../engine/storage/ActivityRepository.js";

const edge = ["C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
let browser: Browser; let page: Page;
beforeAll(async () => { browser = await chromium.launch({ executablePath: edge, headless: true }); page = await browser.newPage(); });
afterAll(async () => browser?.close());
const screen = () => page.locator(".content-wrap:not(.activity--hidden)");

describe("Cambridge interaction handlers", () => {
  it("detects only the active interaction", async () => { await page.setContent('<div class="content-wrap"><div class="interaction is-radiobutton"></div></div><div class="content-wrap activity--hidden"><div class="interaction is-checkbox"></div></div>'); expect(await new InteractionDetector().detect(screen())).toBe("SINGLE_CHOICE"); });
  it("reads an unsupported visible screen without waiting for a missing interaction", async () => { await page.setContent('<ul><li class="step current"><span class="step-number">4</span></li></ul><div class="content-wrap">Read this recommendation before continuing.</div>'); const result = await new CurrentScreenService().analyze(page); expect(result).toMatchObject({ screenNumber: 4, interactionType: "UNSUPPORTED", questionText: "Read this recommendation before continuing." }); });
  it("detects a Cambridge text-input screen for manual recording", async () => { await page.setContent('<div class="content-wrap"><div class="interaction ic-text-gap"><div class="input-text"><input type="text" aria-label="Gap 1"></div></div></div>'); expect(await new InteractionDetector().detect(screen())).toBe("TEXT_INPUT"); });
  it("selects and verifies a radio option", async () => { await page.setContent('<div class="content-wrap"><div class="interaction is-radiobutton"><div role="radio" aria-checked="false" onclick="this.setAttribute(\'aria-checked\',\'true\')">First</div></div></div>'); expect(await new RadioHandler().answerWithFirstOption(screen())).toEqual(["First"]); });
  it("selects checkboxes until Cambridge exposes its limit", async () => { await page.setContent('<div class="content-wrap"><div class="interaction is-checkbox"><div class="choice_interaction"><div role="checkbox" aria-checked="false" onclick="this.setAttribute(\'aria-checked\',\'true\'); this.parentElement.classList.add(\'no-more-choices\')">First</div></div></div></div>'); expect(await new CheckboxHandler().answerWithFirstOption(screen())).toEqual(["First"]); });
  it("selects the first valid dropdown option", async () => { await page.setContent('<div class="content-wrap"><div class="interaction is-dropdown"><button role="combobox">Choose</button><div role="option" onclick="this.setAttribute(\'aria-selected\',\'true\')">First</div></div></div>'); expect(await new DropdownHandler().answerWithFirstOption(screen())).toEqual(["First"]); });
  it("assigns a real pool response and ignores measurement clones", async () => { await page.setContent('<div class="content-wrap"><div class="interaction drag-drop"><div class="wordpool"><ul><li class="gap_match_gap_text_view has_drag"><div class="drag_element" onclick="window.selected=this">teacher</div></li></ul><div class="width-measure"><div class="drag_element">clone</div></div></div><div class="drop_area gap_match_gap_view" aria-label="Gap 1" style="min-height:20px;min-width:100px" onclick="this.classList.add(\'has_drag\');this.innerHTML=window.selected.outerHTML"></div></div></div>'); expect(await new GapMatchHandler().answerWithFirstOption(screen())).toEqual(["teacher"]); });
  it("verifies a gap when Cambridge changes its content without has_drag", async () => { await page.setContent('<div class="content-wrap"><div class="interaction drag-drop"><div class="wordpool"><ul><li class="gap_match_gap_text_view has_drag"><div class="drag_element" onclick="window.selected=this">teacher</div></li></ul></div><div class="drop_area gap_match_gap_view" aria-label="Gap 1" style="min-height:20px;min-width:100px" onclick="this.textContent=window.selected.textContent"></div></div></div>'); expect(await new GapMatchHandler().answerWithFirstOption(screen())).toEqual(["teacher"]); });
  it("waits for Cambridge to render a dropped gap answer", async () => { await page.setContent('<div class="content-wrap"><div class="interaction drag-drop"><div class="wordpool"><ul><li class="gap_match_gap_text_view has_drag"><div class="drag_element" onclick="window.selected=this">teacher</div></li></ul></div><div class="drop_area gap_match_gap_view" aria-label="Gap 1" style="min-height:20px;min-width:100px" onclick="setTimeout(() => this.textContent=window.selected.textContent, 30)"></div></div></div>'); expect(await new GapMatchHandler().answerWithFirstOption(screen())).toEqual(["teacher"]); });
  it("does not overwrite a target Cambridge has already filled without has_drag", async () => { await page.setContent('<div class="content-wrap"><div class="interaction drag-drop"><div class="wordpool"><ul><li class="gap_match_gap_text_view has_drag"><div class="drag_element" onclick="window.selected=this">teacher</div></li></ul></div><div class="drop_area gap_match_gap_view" aria-label="Gap 1"><div class="droppable drag_holder" style="min-height:20px">already assigned</div></div><div class="drop_area gap_match_gap_view" aria-label="Gap 2"><div class="droppable drag_holder" style="min-height:20px" onclick="this.textContent=window.selected.textContent"></div></div></div></div>'); expect(await new GapMatchHandler().answerWithFirstOption(screen())).toEqual(["teacher"]); });
});

describe("feedback and end detection", () => {
  it("uses the Cambridge screen number to prevent duplicate capture cards", () => {
    expect(screenKey({ screenNumber: 9, interactionType: "SINGLE_CHOICE", questionText: "Question before feedback", options: [], externalModelIds: [], selectedAnswers: [] }))
      .toBe(screenKey({ screenNumber: 9, interactionType: "SINGLE_CHOICE", questionText: "Question after feedback changed its text", options: [], externalModelIds: [], selectedAnswers: [] }));
  });
  it("keeps all numbered panel answers, including repeated answer text", () => {
    const feedback: FeedbackResult = {
      result: "SOME_ERRORS",
      feedback: "Correct answers: 1 True 2 False 3 True",
      correctAnswers: ["1 True", "2 False", "3 True"],
      answers: [{ externalModelId: "wrong", slotNumber: 2, answerText: "True", answerPrefix: null, wasSelected: true, wasCorrect: false }],
    };
    const retained = retainCorrectFeedback(feedback);
    expect(retained.answers).toEqual([]);
    expect(displayCorrectAnswerTexts(retained)).toEqual(["1 True", "2 False", "3 True"]);
  });
  it("parses structured correct answers and checked states", async () => { await page.setContent('<div class="content-wrap"><div class="interaction"><div role="radio" class="checked-correct" aria-checked="true" data-model-id="1">First</div></div></div><div id="feedback-panel" class="all-correct"><p><strong>Correct!</strong></p></div>'); const result = await new FeedbackParser().parse(page, screen()); expect(result.result).toBe("CORRECT"); expect(result.answers[0].wasCorrect).toBe(true); });
  it("extracts every numbered correct answer Cambridge lists after an error", async () => { await page.setContent('<div class="content-wrap"><div class="interaction"><div role="checkbox" class="checked-incorrect" aria-checked="true">Wrong</div><div role="checkbox" class="checked-correct" aria-checked="true">Right</div></div></div><div id="feedback-panel" class="some-errors"><p><strong>Correct answers:</strong><br>1 True<br>2 False<br>3 True</p></div>'); const result = await new FeedbackParser().parse(page, screen()); expect(result.correctAnswers).toEqual(["1 True", "2 False", "3 True"]); expect(result.answers.filter(answer => answer.wasCorrect).map(answer => answer.answerText)).toEqual(["Right"]); });
  it("keeps sortable answers and their categories without saving category labels", async () => {
    await page.setContent('<div class="content-wrap"><div class="interaction os-sorting drag-drop"><div class="wordpool">items</div></div></div><div id="feedback-panel" class="some-errors"><p><strong>Correct answers:</strong><br><strong>Positive meaning:</strong><br>constructive<br>strength<br><br><strong>Negative meaning:</strong><br>destructive<br>weakness</p></div>');
    const result = await new FeedbackParser().parse(page, screen());
    expect(result.correctAnswers).toEqual(["Positive meaning: constructive", "Positive meaning: strength", "Negative meaning: destructive", "Negative meaning: weakness"]);
  });
  it("reads a singular Cambridge correct answer without saving feedback explanation text", async () => {
    await page.setContent('<div class="content-wrap"><div class="interaction is-dropdown"></div></div><div id="feedback-panel" class="some-errors all-incorrect"><p><strong>Correct answer:</strong><br>is someone who</p><p>An extrovert <strong>is someone who</strong> likes to socialize.</p><p>The relative pronoun <strong>who</strong> is for people.</p></div>');
    const result = await new FeedbackParser().parse(page, screen());
    expect(result.correctAnswers).toEqual(["is someone who"]);
  });
  it("uses image alt text for a correct image answer and ignores video controls", async () => {
    await page.setContent('<div class="content-wrap"><button aria-selected="true">captions off, selected</button><div class="interaction is-radiobutton"><div role="radio" aria-checked="true"><img alt="a chimpanzee holding a toy"></div></div></div><div id="feedback-panel" class="some-errors"><p><strong>Correct answer:</strong><br><img alt="a chimpanzee holding a toy"></p></div>');
    const result = await new FeedbackParser().parse(page, screen());
    expect(result.correctAnswers).toEqual(["a chimpanzee holding a toy"]);
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]?.answerText).toBe("a chimpanzee holding a toy");
  });
  it("captures a correct option Cambridge marks even when the user did not select it", async () => {
    await page.setContent('<div class="content-wrap"><div class="interaction is-radiobutton"><div role="radio" class="checked-incorrect" aria-checked="true">Wrong</div><div role="radio" class="checked-correct" aria-checked="false">Right</div></div></div><div id="feedback-panel" class="some-errors">Incorrect</div>');
    const result = await new FeedbackParser().parse(page, screen());
    expect(result.answers).toContainEqual(expect.objectContaining({ answerText: "Right", wasSelected: false, wasCorrect: true }));
  });
  it("reads Cambridge text-input answers and their evaluated state", async () => { await page.setContent('<div class="content-wrap"><div class="interaction ic-text-gap"><div class="input-text checked-correct" data-model-id="gap-1"><input type="text" value="when" aria-label="Gap 1 with 4 possible answers"></div><div class="input-text checked-incorrect" data-model-id="gap-2"><input type="text" value="which" aria-label="Gap 2 with 4 possible answers"></div></div></div><div id="feedback-panel" class="some-errors"><p><strong>Correct answers:</strong><br>1 when<br>2 that</p></div>'); const result = await new FeedbackParser().parse(page, screen()); expect(result.answers).toMatchObject([{ externalModelId: "gap-1", slotNumber: 1, answerText: "when", wasCorrect: true }, { externalModelId: "gap-2", slotNumber: 2, answerText: "which", wasCorrect: false }]); expect(result.correctAnswers).toEqual(["1 when", "2 that"]); });
  it("retains text-gap prefixes so copy only contains the letters still missing", async () => {
    await page.setContent('<div class="content-wrap"><div class="interaction ic-text-gap"><div class="input-text"><input type="text" placeholder="unr________" value="unr" aria-label="Gap 1"></div><div class="input-text"><input type="text" placeholder="u______" value="u" aria-label="Gap 2"></div><div class="input-text"><input type="text" placeholder="_______" value="" aria-label="Gap 3"></div></div></div><div id="feedback-panel" class="some-errors"><p><strong>Correct answers:</strong><br>1 unreasonable<br>2 useful<br>3 complete</p></div>');
    const retained = retainCorrectFeedback(await new FeedbackParser().parse(page, screen()));
    expect(displayAnswerPrefixes(retained)).toEqual(["unr", "u", ""]);
    expect(displayCorrectAnswerTexts(retained)).toEqual(["1 unreasonable", "2 useful", "3 complete"]);
  });
  it("persists text-gap prefixes alongside the authoritative correct answers", () => {
    const directory = mkdtempSync(join(tmpdir(), "evolve-synth-prefix-"));
    let repository: ActivityRepository | undefined;
    try {
      repository = new ActivityRepository(directory);
      const runId = repository.startRun("test", "https://example.test");
      const screenId = repository.recordScreen(runId, { screenNumber: 1, interactionType: "TEXT_INPUT", questionText: "Fill the gaps", options: [], externalModelIds: [], selectedAnswers: [] });
      repository.completeScreen(screenId, {
        result: "SOME_ERRORS",
        feedback: "",
        correctAnswers: ["1 unreasonable", "2 useful", "3 complete"],
        answers: [
          { externalModelId: "gap-1", slotNumber: 1, answerText: "unr", answerPrefix: "unr", wasSelected: false, wasCorrect: null },
          { externalModelId: "gap-2", slotNumber: 2, answerText: "u", answerPrefix: "u", wasSelected: false, wasCorrect: null },
          { externalModelId: "gap-3", slotNumber: 3, answerText: "", answerPrefix: "", wasSelected: false, wasCorrect: null },
        ]
      });
      const report = repository.exportRun(runId) as { screens: Array<{ correct_answers: string[]; correct_answer_prefixes: Array<string | null> }> };
      expect(report.screens[0]).toMatchObject({ correct_answers: ["unreasonable", "useful", "complete"], correct_answer_prefixes: ["unr", "u", ""] });
    } finally {
      repository?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("captures a manual gap answer even when Cambridge omits has_drag", async () => { await page.setContent('<div class="content-wrap"><div class="interaction drag-drop"><div class="drop_area gap_match_gap_view" aria-label="Gap 1">teacher</div></div></div>'); const answers = await new FeedbackParser().captureSubmitted(screen()); expect(answers).toMatchObject([{ slotNumber: 1, answerText: "teacher", wasSelected: true }]); });
  it("detects a final result screen without clicking it", async () => { await page.setContent('<div class="result-screen-wrapper">You scored 9 out of 17 <button class="tryAgain-btn">Start again</button></div>'); expect(await detectActivityEnd(page)).toMatchObject({ ended: true, score: 9, maximumScore: 17 }); });
  it("finds Cambridge Check in the parent page while activity remains in an iframe", async () => { await page.setContent('<div class="controls-wrapper button-visible"><div class="controls-container"><a href="javascript:void(0);" class="btn green-btn" title="Check">Check</a></div></div><iframe title="Activity: practice" srcdoc="<div id=activity></div>"></iframe>'); const child = page.frames().find(frame => frame !== page.mainFrame())!; const check = await findCheckButtonInScopes(page.mainFrame(), child); expect(await check?.getAttribute("title")).toBe("Check"); });
  it("waits for Check after a checkbox activity updates parent controls", async () => { await page.setContent('<div class="controls-wrapper"><a class="btn green-btn" title="Check" hidden>Check</a></div><script>setTimeout(() => document.querySelector("[title=Check]").removeAttribute("hidden"), 20)</script>'); const check = await findCheckButtonInScopes(page.mainFrame()); expect(await check?.isVisible()).toBe(true); });
});

describe("Cambridge context resolution", () => {
  it("finds Cambridge directly in the main frame", async () => {
    await page.setContent('<div id="activity"><div class="progress-bar"></div><ul><li class="step current"><span class="step-number">1</span></li></ul><div class="content-wrap"><div class="interaction drag-drop"></div></div></div>');
    const context = await resolveActiveCambridgeContext([page]);
    expect(context?.frame).toBe(page.mainFrame());
    expect(context?.interactionType).toBe("GAP_MATCH");
  });

  it("finds Cambridge inside an activity iframe", async () => {
    const document = '<div id="activity"><div class="progress-bar"></div><ul><li class="step current"><span class="step-number">2</span></li></ul><div class="content-wrap"><div class="interaction is-radiobutton"></div></div></div>';
    await page.setContent(`<iframe title="Activity: practice" srcdoc="${document.replace(/"/g, "&quot;")}"></iframe>`);
    await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.body?.children.length === 1);
    const context = await resolveActiveCambridgeContext([page]);
    expect(context?.frame).not.toBe(page.mainFrame());
    expect(context?.interactionType).toBe("SINGLE_CHOICE");
  });
});

describe("Run activity protocol", () => {
  it("accepts a run in under one second while its task remains active", async () => {
    const job = new RunJob();
    const started = performance.now();
    const accepted = job.start(async () => new Promise<void>(() => undefined));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(accepted.state).toBe("RUNNING");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(job.status?.state).toBe("RUNNING");
  });
});
