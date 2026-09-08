import type { Page } from "playwright";
import { findActivityFrame } from "./activityFrame.js";

export async function findCompatibleActivity(pages: Page[]): Promise<boolean> {
  return Boolean(await findActivityFrame(pages));
}
