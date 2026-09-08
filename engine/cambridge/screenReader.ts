import type { Frame, Locator } from "playwright";
import { CambridgeSelectors } from "./selectors.js";
import type { InteractionType, ScreenAnalysis } from "./types.js";

async function visibleText(locator: Locator): Promise<string[]> {
  // Locator innerText() can wait for Playwright's 30-second default while
  // Cambridge replaces a screen. Recording must skip that transient DOM,
  // not block all subsequent feedback captures.
  return locator.evaluateAll(elements => elements
    .filter(element => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    })
    .map(element => (element.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
  ).catch(() => []);
}

export async function currentScreenNumber(frame: Frame): Promise<number | null> {
  const number = frame.locator(CambridgeSelectors.currentStepNumber).first();
  if (await number.count()) {
    const parsed = Number.parseInt(((await number.textContent().catch(() => "")) ?? "").trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const current = frame.locator(CambridgeSelectors.currentStep).first();
  if (!await current.count()) return null;
  return current.evaluate((element, selector) => [...element.parentElement!.querySelectorAll(selector)].indexOf(element) + 1, CambridgeSelectors.allSteps).catch(() => null);
}

export async function readScreen(frame: Frame, screen: Locator, interactionType: InteractionType): Promise<ScreenAnalysis> {
  const interaction = screen.locator(CambridgeSelectors.interaction).first();
  if (!await interaction.count()) {
    const questionText = ((await screen.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    return { screenNumber: await currentScreenNumber(frame), interactionType, questionText, options: [], externalModelIds: [], selectedAnswers: [] };
  }
  const optionSelector = interactionType === "SINGLE_CHOICE" ? CambridgeSelectors.radios
    : interactionType === "MULTIPLE_CHOICE" ? CambridgeSelectors.checkboxes
    : interactionType === "DROPDOWN" ? CambridgeSelectors.options
    : interactionType === "GAP_MATCH" ? CambridgeSelectors.gapTargets
    : interactionType === "TEXT_INPUT" ? CambridgeSelectors.textInputs : "";
  const optionLocators = optionSelector ? interaction.locator(optionSelector) : interaction.locator(":scope");
  const options = await visibleText(optionLocators);
  const selectedAnswers = await visibleText(interaction.locator(CambridgeSelectors.selected));
  const externalModelIds = await interaction.locator("[data-model-id]").evaluateAll(elements => [...new Set(elements.map(element => element.getAttribute("data-model-id")).filter((id): id is string => Boolean(id)))]);
  const questionText = await interaction.evaluate(element => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[role="radio"], [role="checkbox"], [role="combobox"], [role="option"], .wordpool, button, [class*="feedback"], .check').forEach(node => node.remove());
    return (clone.innerText || "").replace(/\s+/g, " ").trim();
  });
  return { screenNumber: await currentScreenNumber(frame), interactionType, questionText, options, externalModelIds, selectedAnswers };
}
