import type { Frame, Locator, Page } from "playwright";
import { InteractionDetector } from "./InteractionDetector.js";
import { CambridgeSelectors } from "./selectors.js";
import { currentScreenNumber } from "./screenReader.js";
import type { InteractionType } from "./types.js";

export type CambridgeContext = {
  page: Page;
  frame: Frame;
  activityRoot: Locator;
  screenNumber: number | null;
  interactionType: InteractionType;
};

type Trace = (message: string) => void;
const noTrace: Trace = () => undefined;
function diagnosticUrl(value: string): string {
  if (value === "about:blank") return value;
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
  catch { return "unavailable"; }
}

/** Finds the active Cambridge document whether it is the page itself or an iframe. */
export async function resolveActiveCambridgeContext(pages: Page[], trace: Trace = noTrace): Promise<CambridgeContext | undefined> {
  const detector = new InteractionDetector();
  trace(`PAGES_FOUND=${pages.length}`);
  for (const page of pages) {
    trace(`PAGE_SCAN url=${diagnosticUrl(page.url())}`);
    const frames = [...new Set([page.mainFrame(), ...page.frames()])];
    for (const frame of frames) {
      try {
        const hasActivity = await frame.locator(CambridgeSelectors.activityRoot).count() > 0;
        const activeScreen = await detector.activeScreen(frame);
        const hasCurrentContent = Boolean(activeScreen);
        const hasProgressBar = await frame.locator(CambridgeSelectors.progressBar).count() > 0;
        const hasCurrentStep = await frame.locator(CambridgeSelectors.currentStep).count() > 0;
        const interactionType = activeScreen ? await detector.detect(activeScreen) : "UNSUPPORTED";
        const isMainFrame = frame === page.mainFrame();
        trace(`FRAME_SCAN url=${diagnosticUrl(frame.url())} isMainFrame=${isMainFrame} hasActivity=${hasActivity} hasCurrentContent=${hasCurrentContent} hasProgressBar=${hasProgressBar} hasCurrentStep=${hasCurrentStep} interactionType=${interactionType}`);
        const compatible = hasActivity || (hasCurrentContent && (hasProgressBar || hasCurrentStep || interactionType !== "UNSUPPORTED"));
        if (compatible) {
          const activityRoot = hasActivity ? frame.locator(CambridgeSelectors.activityRoot).first() : activeScreen!;
          const screenNumber = await currentScreenNumber(frame);
          trace(`ACTIVITY_FOUND pageUrl=${diagnosticUrl(page.url())} frameUrl=${diagnosticUrl(frame.url())} isMainFrame=${isMainFrame}`);
          trace(`SCREEN_DETECTED screen=${screenNumber ?? "unknown"} type=${interactionType}`);
          return { page, frame, activityRoot, screenNumber, interactionType };
        }
      } catch (error) {
        trace(`FRAME_SCAN_FAILED url=${diagnosticUrl(frame.url())} reason=${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  trace("ACTIVITY_NOT_FOUND");
  return undefined;
}

export async function findActivityFrame(pages: Page[], trace?: Trace): Promise<Frame | undefined> {
  return (await resolveActiveCambridgeContext(pages, trace))?.frame;
}
