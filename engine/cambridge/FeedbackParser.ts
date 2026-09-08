import type { Frame, Locator } from "playwright";
import { CambridgeSelectors } from "./selectors.js";
import { AutomationLimits } from "../config.js";

export type SubmittedAnswer = { externalModelId: string | null; slotNumber: number | null; answerText: string; answerPrefix: string | null; wasSelected: boolean; wasCorrect: boolean | null };
export type FeedbackResult = { result: "CORRECT" | "SOME_ERRORS" | "UNKNOWN"; feedback: string; correctAnswers: string[]; answers: SubmittedAnswer[] };

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

function addCategoryContext(lines: string[]): string[] {
  let category = "";
  return lines.flatMap(line => {
    // Sorting activities put category titles in the same paragraph as the
    // correct items. Retain the item, with its category as useful context,
    // rather than saving the title as if it were an answer.
    if (/^[^\d][^:]{1,80}:$/.test(line)) {
      category = line.slice(0, -1).trim();
      return [];
    }
    return [category ? `${category}: ${line}` : line];
  });
}

export class FeedbackParser {
  async waitAndParse(frame: Frame, screen: Locator): Promise<FeedbackResult> {
    const panel = frame.locator(CambridgeSelectors.feedbackPanel);
    try { await panel.waitFor({ state: "visible", timeout: AutomationLimits.normalTimeoutMs }); }
    catch {
      if (!await screen.locator(CambridgeSelectors.corrected).count()) throw new Error("Timed out waiting for Cambridge evaluation.");
    }
    return this.parse(frame, screen);
  }

  async parse(frame: Frame, screen: Locator): Promise<FeedbackResult> {
    const panel = frame.locator(CambridgeSelectors.feedbackPanel).first();
    const panelClass = (await panel.getAttribute("class").catch(() => "")) ?? "";
    const feedback = clean(await panel.innerText().catch(() => ""));
    const result = panelClass.includes("all-correct") ? "CORRECT" : panelClass.includes("some-errors") ? "SOME_ERRORS" : /\bcorrect!\b/i.test(feedback) ? "CORRECT" : "UNKNOWN";
    return { result, feedback, correctAnswers: await this.correctAnswers(panel, feedback), answers: await this.readAnswerStates(screen) };
  }
  async captureSubmitted(screen: Locator): Promise<SubmittedAnswer[]> { return this.readAnswerStates(screen); }

  private async correctAnswers(panel: Locator, feedback: string): Promise<string[]> {
    const structured = await panel.evaluate(element => {
      // Cambridge uses both "Correct answer:" and "Correct answers:".
      // The enclosing <p> contains the answer; subsequent <p>s are only
      // explanatory feedback and must never be persisted as answers.
      const strong = [...element.querySelectorAll("strong")].find(node => /correct answers?:/i.test(node.textContent ?? ""));
      if (!strong?.parentElement) return [];
      const answerContainer = strong.closest("p") ?? strong.parentElement;
      const answerClone = answerContainer.cloneNode(true) as HTMLElement;
      answerClone.querySelectorAll("br").forEach(lineBreak => lineBreak.replaceWith("\n"));
      const textAnswers = (answerClone.textContent || "")
        .replace(/correct answers?:/i, "")
        .split(/\n|\s{2,}/)
        .map(value => value.trim())
        .filter(Boolean);
      if (textAnswers.length) return textAnswers;

      // Image-only choices have no innerText. Cambridge gives those images a
      // useful alt attribute, which is the readable answer for the report.
      return [...answerContainer.querySelectorAll("img[alt]")]
        .map(image => image.getAttribute("alt")?.trim() ?? "")
        .filter(Boolean);
    }).catch(() => [] as string[]);
    if (structured.length) return addCategoryContext(structured);
    const match = feedback.match(/correct answers?:\s*(.+)/i);
    return match ? match[1].split(/\s*[,;]\s*/).filter(Boolean) : [];
  }

  private async readAnswerStates(screen: Locator): Promise<SubmittedAnswer[]> {
    return screen.locator(`${CambridgeSelectors.evaluatedChoice}, .drop_area.gap_match_gap_view, ${CambridgeSelectors.textInputs}`).evaluateAll(elements => {
      const seen = new Set<string>();
      // Functions passed to Playwright run in Cambridge's document, not in
      // Node. Keep text-gap parsing here so it is available in that context.
      const textGapPrefix = (placeholder: string) => placeholder.split("_")[0]?.trim() ?? "";
      const completeTextAnswer = (prefix: string, inputValue: string) => {
        const value = inputValue.replace(/\s+/g, " ").trim();
        if (!prefix || !value || value.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) return value || prefix;
        return `${prefix}${value}`;
      };

      return elements.flatMap(element => {
      const isTextInput = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
      const container = isTextInput ? element.closest(".input-text, [data-model-id]") ?? element : element;
      const classes = [element.className || "", container.className || "", container.parentElement?.className || ""].join(" ");
      const drag = element.querySelector(".drag_element");
      const source = drag ?? element;
      const imageAlt = [...source.querySelectorAll("img[alt]")]
        .map(image => image.getAttribute("alt")?.trim() ?? "")
        .filter(Boolean)
        .join("; ");
      const answerPrefix = isTextInput ? textGapPrefix(element.getAttribute("placeholder") ?? "") : null;
      const answerText = isTextInput
        ? completeTextAnswer(answerPrefix ?? "", element.value)
        : (source.textContent ?? "").replace(/\s+/g, " ").trim() || imageAlt;
      // Cambridge can render a dropped answer without has_drag or drag_element.
      if (element.matches(".drop_area") && !answerText) return [];
      // A blank text gap can still have an empty initial prefix. Keep that
      // source so a later correct answer can expose the copyable missing part.
      if (isTextInput && !answerText && answerPrefix === null) return [];
      const label = element.getAttribute("aria-label") ?? "";
      const gap = label.match(/Gap\s+(\d+)/i);
      const slotNumber = gap ? Number(gap[1]) : null;
      const externalModelId = source.getAttribute("data-model-id")
        ?? container.getAttribute("data-model-id")
        ?? element.getAttribute("data-model-id");
      const check = container.querySelector(".check");
      const checkClass = check?.className ?? "";
      const wasSelected = isTextInput
        || element.getAttribute("aria-checked") === "true"
        || element.getAttribute("aria-selected") === "true"
        || element.matches(".drop_area");
      const wasCorrect = /checked-correct/.test(classes) || /\bcorrect\b/.test(checkClass) || /checked-correct/.test(source.className || "") ? true : /checked-incorrect/.test(classes) || /\bincorrect\b/.test(checkClass) || /checked-incorrect/.test(source.className || "") ? false : null;
      const key = `${slotNumber ?? ""}|${answerText.toLocaleLowerCase()}|${externalModelId ?? ""}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        externalModelId,
        slotNumber,
        answerText,
        answerPrefix,
        wasSelected,
        wasCorrect
      }];
      });
    });
  }
}
