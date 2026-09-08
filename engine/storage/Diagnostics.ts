import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Frame } from "playwright";

export async function captureDiagnostic(frame: Frame, dataDirectory: string, screen: number | null, reason: string): Promise<string | undefined> {
  try {
    const directory = join(dataDirectory, "Diagnostics");
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const safeReason = reason.replace(/[^A-Z0-9_]/gi, "_").slice(0, 48);
    const path = join(directory, `${timestamp}_screen-${screen ?? "unknown"}_${safeReason}.png`);
    await frame.page().screenshot({ path, fullPage: true });
    return path;
  } catch { return undefined; }
}
