import type { Locator } from "playwright";
import { CambridgeSelectors } from "./selectors.js";
import { AutomationLimits } from "../config.js";

export type AnswerHandler = { answerWithFirstOption(screen: Locator): Promise<string[]> };

async function usable(locator: Locator): Promise<boolean> {
  return await locator.isVisible() && await locator.getAttribute("aria-disabled") !== "true" && !await locator.isDisabled().catch(() => false);
}
async function textOf(locator: Locator): Promise<string> { return (await locator.innerText()).replace(/\s+/g, " ").trim(); }
async function waitForAttribute(locator: Locator, attribute: string, value: string): Promise<boolean> {
  for (let attempt = 0; attempt < AutomationLimits.maxRetries * 4; attempt += 1) {
    if (await locator.getAttribute(attribute) === value) return true;
    await new Promise(resolve => setTimeout(resolve, AutomationLimits.selectionPollMs));
  }
  return false;
}

export class RadioHandler implements AnswerHandler {
  async answerWithFirstOption(screen: Locator): Promise<string[]> {
    const options = screen.locator(`${CambridgeSelectors.radioInteraction} ${CambridgeSelectors.radios}`);
    for (let index = 0; index < await options.count(); index += 1) {
      const option = options.nth(index);
      if (!await usable(option)) continue;
      await option.click();
      if (!await waitForAttribute(option, "aria-checked", "true")) throw new Error("Radio selection was not verified.");
      return [await textOf(option)];
    }
    throw new Error("No enabled radio option is available.");
  }
}

export class CheckboxHandler implements AnswerHandler {
  async answerWithFirstOption(screen: Locator): Promise<string[]> {
    const interaction = screen.locator(CambridgeSelectors.checkboxInteraction).first();
    const options = interaction.locator(CambridgeSelectors.checkboxes);
    const selected: string[] = [];
    const optionCount = Math.min(await options.count(), AutomationLimits.maxCheckboxSelections);
    for (let index = 0; index < optionCount; index += 1) {
      if (await interaction.locator(CambridgeSelectors.noMoreChoices).count()) return selected;
      const option = options.nth(index);
      if (!await usable(option) || await option.getAttribute("aria-checked") === "true") continue;
      await option.click();
      if (!await waitForAttribute(option, "aria-checked", "true")) throw new Error("Checkbox selection was not verified.");
      selected.push(await textOf(option));
      if (await interaction.locator(CambridgeSelectors.noMoreChoices).count()) return selected;
    }
    throw new Error("UNSUPPORTED: no-more-choices was not reached after all checkbox options were tried.");
  }
}

function placeholder(value: string): boolean { return !value.trim() || /^(choose|select|please choose|please select)\b/i.test(value.trim()); }
export class DropdownHandler implements AnswerHandler {
  async answerWithFirstOption(screen: Locator): Promise<string[]> {
    const selected: string[] = [];
    const comboboxes = screen.locator(`${CambridgeSelectors.dropdownInteraction} ${CambridgeSelectors.comboboxes}`);
    for (let index = 0; index < await comboboxes.count(); index += 1) {
      const combobox = comboboxes.nth(index);
      if (!await usable(combobox)) throw new Error("An enabled combobox is required.");
      await combobox.click();
      const options = screen.locator(CambridgeSelectors.options);
      let selectedOption: Locator | undefined;
      for (let optionIndex = 0; optionIndex < await options.count(); optionIndex += 1) {
        const option = options.nth(optionIndex);
        if (await usable(option) && !placeholder(await textOf(option))) { selectedOption = option; break; }
      }
      if (!selectedOption) throw new Error("No valid dropdown option is available.");
      await selectedOption.click();
      const verified = await screen.locator(`${CambridgeSelectors.options}[aria-selected="true"]`).count();
      if (!verified) throw new Error("Dropdown selection was not verified.");
      selected.push(await textOf(selectedOption));
    }
    if (!selected.length) throw new Error("No combobox was found.");
    return selected;
  }
}

export class GapMatchHandler implements AnswerHandler {
  async answerWithFirstOption(screen: Locator): Promise<string[]> {
    const targets = screen.locator(`${CambridgeSelectors.gapMatchInteraction} ${CambridgeSelectors.gapTargets}`);
    const assigned: string[] = [];
    const usedResponses = new Set<string>();
    for (let index = 0; index < await targets.count(); index += 1) {
      const target = targets.nth(index);
      // A completed Cambridge target is not always marked with `has_drag`.
      // Some activity variants only render the chosen text in the droppable
      // child, so treating it as blank would overwrite it on a later attempt.
      if (!await target.isVisible() || await this.isAlreadyFilled(target)) continue;
      const source = await this.firstPoolResponse(screen, usedResponses);
      if (!source) throw new Error("No unused pool response is available for this gap.");
      const responseText = await textOf(source);
      const sourceKey = await this.responseKey(source, responseText);
      const before = await this.targetSnapshot(target);
      const dropTarget = await this.dropTarget(target);
      await source.click();
      await dropTarget.click();
      // Click-to-drop normally updates synchronously. Keep this short so a
      // failed target does not make the whole screen look stalled.
      if (!await this.waitForFilled(target, before, AutomationLimits.shortTimeoutMs)) {
        await source.dragTo(dropTarget);
        if (!await this.waitForFilled(target, before, AutomationLimits.normalTimeoutMs)) {
          throw new Error(`Gap ${index + 1} assignment was not verified after click-to-drop and drag fallback.`);
        }
      }
      usedResponses.add(sourceKey);
      assigned.push(responseText);
    }
    if (!assigned.length) throw new Error("No unfilled gap is available.");
    return assigned;
  }
  private async firstPoolResponse(screen: Locator, usedResponses: Set<string>): Promise<Locator | undefined> {
    const responses = screen.locator(CambridgeSelectors.poolResponses);
    for (let index = 0; index < await responses.count(); index += 1) {
      const response = responses.nth(index);
      if (!await usable(response) || !await response.evaluate(element => !element.closest(".width-measure"))) continue;
      const responseText = await textOf(response);
      if (!responseText) continue;
      const key = await this.responseKey(response, responseText);
      if (!usedResponses.has(key)) return response;
    }
    return undefined;
  }
  private async responseKey(source: Locator, text: string): Promise<string> {
    return await source.evaluate((element, fallback) => {
      const model = element.getAttribute("data-model-id") ?? element.closest("[data-model-id]")?.getAttribute("data-model-id");
      return model ? `model:${model}` : `text:${fallback}`;
    }, text);
  }
  private async targetSnapshot(target: Locator): Promise<string> {
    return target.evaluate(element => `${element.className}|${element.innerHTML}|${element.textContent ?? ""}`);
  }
  private async isAlreadyFilled(target: Locator): Promise<boolean> {
    return target.evaluate(element => {
      if (element.classList.contains("has_drag") || element.querySelector(".has_drag, .drag_element")) return true;
      const copy = element.cloneNode(true) as HTMLElement;
      copy.querySelectorAll(".width-measure, .droppable__placeholder, .place_holder").forEach(node => node.remove());
      const input = copy.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
      return Boolean(input?.value.trim() || copy.textContent?.replace(/\s+/g, " ").trim());
    });
  }
  private async dropTarget(target: Locator): Promise<Locator> {
    const droppable = target.locator(".droppable.drag_holder").first();
    return await droppable.count() ? droppable : target;
  }
  private async isFilled(target: Locator, before: string): Promise<boolean> {
    return target.evaluate((element, previous) => element.classList.contains("has_drag")
      || Boolean(element.querySelector(".has_drag, .drag_element"))
      || `${element.className}|${element.innerHTML}|${element.textContent ?? ""}` !== previous, before);
  }
  private async waitForFilled(target: Locator, before: string, timeoutMs: number): Promise<boolean> {
    const attempts = Math.ceil(timeoutMs / AutomationLimits.selectionPollMs);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.isFilled(target, before)) return true;
      await new Promise(resolve => setTimeout(resolve, AutomationLimits.selectionPollMs));
    }
    return false;
  }
}
