import type { Frame, Locator } from "playwright";
import { CambridgeSelectors } from "./selectors.js";
import { AutomationLimits } from "../config.js";

const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

export async function findCheckButton(frame: Frame): Promise<Locator | undefined> {
  const specific = frame.locator(CambridgeSelectors.checkButtons);
  for (let index = 0; index < await specific.count(); index += 1) {
    const button = specific.nth(index);
    if (await button.isVisible() && normalize((await button.getAttribute("title")) ?? await button.innerText()) === "check") return button;
  }
  const controls = frame.locator(".controls-wrapper a, .controls-wrapper button");
  for (let index = 0; index < await controls.count(); index += 1) {
    const button = controls.nth(index);
    if (await button.isVisible() && normalize(await button.innerText()) === "check") return button;
  }
  return undefined;
}

/** Cambridge renders activity content in an iframe but can render controls in its parent page. */
export async function findCheckButtonInScopes(primary: Frame, fallback?: Frame): Promise<Locator | undefined> {
  const scopes = [...new Set([primary, fallback].filter((value): value is Frame => Boolean(value)))];
  for (const scope of scopes) {
    const check = await findCheckButton(scope);
    if (check) return check;
  }
  // Checkbox activities update the parent controls after the final selection.
  // Wait on the known Check selector rather than sleeping or clicking a green button by guesswork.
  for (const scope of scopes) {
    try {
      await scope.locator(CambridgeSelectors.checkButtons).first().waitFor({ state: "visible", timeout: AutomationLimits.normalTimeoutMs });
      const check = await findCheckButton(scope);
      if (check) return check;
    } catch { /* Try the other known Cambridge scope. */ }
  }
  return undefined;
}

export async function findSafeNextButton(frame: Frame): Promise<Locator | undefined> {
  const buttons = frame.locator(CambridgeSelectors.nextButtons);
  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index);
    if (!await button.isVisible()) continue;
    const text = normalize(await button.innerText());
    const title = normalize((await button.getAttribute("title")) ?? "");
    if (text === "next" || title === "next") return button;
  }
  return undefined;
}

export async function findSafeNextButtonInScopes(primary: Frame, fallback?: Frame): Promise<Locator | undefined> {
  for (const scope of [...new Set([primary, fallback].filter((value): value is Frame => Boolean(value)))]) {
    const next = await findSafeNextButton(scope);
    if (next) return next;
  }
  return undefined;
}

export async function detectActivityEnd(frame: Frame): Promise<{ ended: boolean; score: number | null; maximumScore: number | null; reason?: string }> {
  const endNodes = frame.locator(CambridgeSelectors.resultScreen);
  for (let index = 0; index < await endNodes.count(); index += 1) {
    if (await endNodes.nth(index).isVisible()) return { ended: true, ...await score(frame), reason: "Result screen detected" };
  }
  const body = normalize(await frame.locator("body").innerText().catch(() => ""));
  if (/\b(start again|next activity|you have finished the activity)\b/.test(body)) return { ended: true, ...await score(frame), reason: "Activity completion text detected" };
  return { ended: false, score: null, maximumScore: null };
}

async function score(frame: Frame): Promise<{ score: number | null; maximumScore: number | null }> {
  const text = await frame.locator(".result-screen-wrapper, body").first().innerText().catch(() => "");
  const match = text.match(/you scored\s+(\d+)\s+out of\s+(\d+)/i);
  return match ? { score: Number(match[1]), maximumScore: Number(match[2]) } : { score: null, maximumScore: null };
}
