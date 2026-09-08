import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export class BrowserSessionManager {
  private context?: BrowserContext;
  private preference: "chrome-first" | "edge-first" = "chrome-first";
  constructor(private readonly dataDirectory: string) {}

  async open(url: string): Promise<void> {
    if (!this.context) this.context = await this.launch();
    const page = this.context.pages()[0] ?? await this.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }
  getPages(): Page[] { return this.context?.pages() ?? []; }
  setPreference(preference?: string): void { this.preference = preference === "edge-first" ? "edge-first" : "chrome-first"; }
  isOpen(): boolean { return Boolean(this.context); }
  async close(): Promise<void> { await this.context?.close(); this.context = undefined; }

  private async launch(): Promise<BrowserContext> {
    const profile = join(this.dataDirectory, "BrowserProfile");
    await mkdir(profile, { recursive: true });
    const chromeCandidates = [
      join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe")
    ];
    const edgeCandidates = [
      join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")
    ];
    const executableCandidates = (this.preference === "edge-first" ? [...edgeCandidates, ...chromeCandidates] : [...chromeCandidates, ...edgeCandidates]).filter(existsSync);
    const base = { headless: false, viewport: null as null, args: ["--start-maximized"] };
    for (const executablePath of executableCandidates) {
      try { return await chromium.launchPersistentContext(profile, { ...base, executablePath }); }
      catch { /* Try the next supported browser. */ }
    }
    throw new Error("NO_SUPPORTED_BROWSER: Install Google Chrome or Microsoft Edge to use Evolve Synth. Playwright Chromium is not bundled in this demo.");
  }
}
