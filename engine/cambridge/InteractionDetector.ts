import type { Frame, Locator } from "playwright";
import { CambridgeSelectors } from "./selectors.js";
import type { InteractionType } from "./types.js";

export class InteractionDetector {
  async activeScreen(frame: Frame): Promise<Locator | undefined> {
    const screen = frame.locator(CambridgeSelectors.activeScreen).first();
    return await screen.count() ? screen : undefined;
  }

  async detect(screen: Locator): Promise<InteractionType> {
    if (await screen.locator(CambridgeSelectors.radioInteraction).count()) return "SINGLE_CHOICE";
    if (await screen.locator(CambridgeSelectors.checkboxInteraction).count()) return "MULTIPLE_CHOICE";
    if (await screen.locator(CambridgeSelectors.dropdownInteraction).count()) return "DROPDOWN";
    if (await screen.locator(CambridgeSelectors.gapMatchInteraction).count()) return "GAP_MATCH";
    if (await screen.locator(CambridgeSelectors.textInputInteraction).count()) return "TEXT_INPUT";
    return "UNSUPPORTED";
  }
}
