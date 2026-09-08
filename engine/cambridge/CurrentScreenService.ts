import type { Frame } from "playwright";
import { InteractionDetector } from "./InteractionDetector.js";
import { CheckboxHandler, DropdownHandler, GapMatchHandler, RadioHandler, type AnswerHandler } from "./handlers.js";
import { readScreen } from "./screenReader.js";
import type { InteractionType, ScreenResult } from "./types.js";

export class CurrentScreenService {
  private readonly detector = new InteractionDetector();
  private readonly handlers: Partial<Record<InteractionType, AnswerHandler>> = {
    SINGLE_CHOICE: new RadioHandler(),
    MULTIPLE_CHOICE: new CheckboxHandler(),
    DROPDOWN: new DropdownHandler(),
    GAP_MATCH: new GapMatchHandler()
  };

  async analyze(frame: Frame): Promise<ScreenResult> {
    const screen = await this.detector.activeScreen(frame);
    if (!screen) return this.noScreenResult();
    const type = await this.detector.detect(screen);
    const analysis = await readScreen(frame, screen, type);
    return type === "UNSUPPORTED"
      ? { ...analysis, outcome: "UNSUPPORTED_INTERACTION", message: "Unsupported interaction. Automation stopped safely.", selectionVerified: false }
      : { ...analysis, outcome: "ANALYZED", message: "Current screen analyzed. No answer was submitted.", selectionVerified: false };
  }

  async answerWithFirstOption(frame: Frame): Promise<ScreenResult> {
    const screen = await this.detector.activeScreen(frame);
    if (!screen) return this.noScreenResult();
    const type = await this.detector.detect(screen);
    const before = await readScreen(frame, screen, type);
    const handler = this.handlers[type];
    if (!handler) return { ...before, outcome: "UNSUPPORTED_INTERACTION", message: "Unsupported interaction. Automation stopped safely.", selectionVerified: false };
    try {
      await handler.answerWithFirstOption(screen);
      const after = await readScreen(frame, screen, type);
      return { ...after, outcome: "ANSWERED", message: "FirstOptionStrategy completed. Selection verified.", selectionVerified: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("UNSUPPORTED:")) {
        return { ...before, outcome: "UNSUPPORTED_INTERACTION", message: "Unsupported interaction. Automation stopped safely.", selectionVerified: false };
      }
      return { ...before, outcome: "FAILED", message, selectionVerified: false };
    }
  }

  private noScreenResult(): ScreenResult {
    return { screenNumber: null, interactionType: "UNSUPPORTED", questionText: "", options: [], externalModelIds: [], selectedAnswers: [], outcome: "UNSUPPORTED_INTERACTION", message: "No active Cambridge screen was found. Automation stopped safely.", selectionVerified: false };
  }
}
