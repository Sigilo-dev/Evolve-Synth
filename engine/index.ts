import readline from "node:readline";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserSessionManager } from "./browser/BrowserSessionManager.js";
import { resolveActiveCambridgeContext } from "./cambridge/activityFrame.js";
import { CurrentScreenService } from "./cambridge/CurrentScreenService.js";
import { ActivityRunner, type EngineRunState } from "./cambridge/ActivityRunner.js";
import { ManualObserver } from "./cambridge/ManualObserver.js";
import { ActivityRepository } from "./storage/ActivityRepository.js";
import { writeTechnicalLog } from "./storage/Logger.js";
import { RunJob, type RunJobState } from "./RunJob.js";

type Command = {
  id: string;
  action: "openPlatform" | "findCompatibleActivity" | "analyzeCurrentScreen" | "answerCurrentScreen" | "runActivity" | "getRunStatus" | "toggleObservation" | "stopActivity" | "exportRun" | "listRuns" | "getRun" | "clearRuns" | "shutdown";
  url?: string;
  payload?: { runId?: number; browserPreference?: string };
};
type State = "IDLE" | "BROWSER_READY" | "ACTIVITY_DETECTED" | "OBSERVING" | EngineRunState;

const dataDirectory = process.env.EVOLVE_SYNTH_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? process.cwd(), "EvolveSynth");
const browser = new BrowserSessionManager(dataDirectory);
const repository = new ActivityRepository(dataDirectory);
const currentScreen = new CurrentScreenService();
const runJob = new RunJob();
let state: State = "IDLE";

function send(payload: unknown): void { process.stdout.write(`${JSON.stringify(payload)}\n`); }
function status(next: State, message: string, details?: Record<string, unknown>) {
  state = next;
  writeTechnicalLog(dataDirectory, next === "ERROR" ? "ERROR" : "INFO", next, message);
  const result = { state, message, ...(details ? { details } : {}) };
  send({ type: "status", ...result });
  return result;
}
function validUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}
const trace = (message: string) => writeTechnicalLog(dataDirectory, "INFO", "CAMBRIDGE", message);
const runner = new ActivityRunner(browser, repository, (next, message, details) => {
  runJob.update(next as RunJobState, message, details);
  status(next, message, { ...(runJob.status ?? {}), ...(details ?? {}) });
}, dataDirectory, trace);
const observer = new ManualObserver(browser, repository, (next, message, details) => status(next, message, details), trace);

async function handle(command: Command) {
  if (command.action === "openPlatform") {
    if (!validUrl(command.url)) throw new Error("La URL debe usar HTTP o HTTPS.");
    browser.setPreference(command.payload?.browserPreference);
    await browser.open(command.url!);
    return status("BROWSER_READY", "Browser: Connected");
  }
  if (command.action === "findCompatibleActivity") {
    if (!browser.isOpen()) return status("IDLE", "Browser: Waiting");
    const context = await resolveActiveCambridgeContext(browser.getPages(), trace);
    return context
      ? status("ACTIVITY_DETECTED", "Compatible activity detected", { activityName: "Cambridge Activity", screenNumber: context.screenNumber, interactionType: context.interactionType })
      : status("BROWSER_READY", "No compatible activity found");
  }
  if (command.action === "analyzeCurrentScreen" || command.action === "answerCurrentScreen") {
    if (!browser.isOpen()) return status("IDLE", "Browser: Waiting");
    const context = await resolveActiveCambridgeContext(browser.getPages(), trace);
    if (!context) return status("BROWSER_READY", "No compatible activity found");
    const result = command.action === "analyzeCurrentScreen"
      ? await currentScreen.analyze(context.frame)
      : await currentScreen.answerWithFirstOption(context.frame);
    return status(result.outcome === "FAILED" ? "ERROR" : result.outcome === "UNSUPPORTED_INTERACTION" ? "UNSUPPORTED" : "ACTIVITY_DETECTED", result.message, { ...result, activityName: "Cambridge Activity" } as unknown as Record<string, unknown>);
  }
  if (command.action === "runActivity") {
    if (!browser.isOpen()) return status("IDLE", "Browser: Waiting");
    if (observer.isObserving) return status("ERROR", "CORRECT_ANSWER_RECORDING_IN_PROGRESS");
    if (runner.isRunning || runJob.active) return status("RUNNING", "Activity is already running", runJob.status as unknown as Record<string, unknown>);
    trace("RUN_REQUEST_RECEIVED");
    const job = runJob.start(async () => {
      if (runJob.cancellationRequested) {
        runJob.update("STOPPED", "Stopped by user");
        status("STOPPED", "Stopped by user", runJob.status as unknown as Record<string, unknown>);
        return;
      }
      await runner.run();
    });
    trace(`RUN_STARTED runId=${job.runId}`);
    return status("RUNNING", "RUN_STARTED", job as unknown as Record<string, unknown>);
  }
  if (command.action === "getRunStatus") {
    const observation = observer.currentStatus;
    if (observation) return observation;
    const job = runJob.status;
    return job ? { state: job.state, message: job.message, details: job as unknown as Record<string, unknown> } : { state, message: "No activity run has been started" };
  }
  if (command.action === "toggleObservation") {
    if (runner.isRunning || runJob.active) return status("ERROR", "AUTOMATION_RUN_IN_PROGRESS");
    await observer.toggle();
    return observer.currentStatus ?? observer.lastSavedStatus ?? { state, message: "Correct answers saved" };
  }
  if (command.action === "stopActivity") {
    if (observer.isObserving) {
      await observer.toggle();
      return observer.lastSavedStatus ?? { state, message: "Correct answers saved" };
    }
    if (!runner.isRunning && !runJob.active) return status(state, "No activity is running");
    runJob.requestStop();
    runner.stop();
    runJob.update("RUNNING", "Stop requested; waiting for current safe action");
    return status("RUNNING", "Stop requested; waiting for current safe action");
  }
  if (command.action === "exportRun") {
    const runId = command.payload?.runId;
    if (!runId) throw new Error("A run ID is required for export.");
    const exportPath = join(dataDirectory, "data", `activity-run-${runId}.json`);
    await writeFile(exportPath, JSON.stringify(repository.exportRun(runId), null, 2), "utf8");
    return status(state, "Run exported", { exportPath, summary: repository.summary(runId) as unknown as Record<string, unknown> });
  }
  if (command.action === "listRuns") return { state, message: "History refreshed", details: { runs: repository.recentRuns() as unknown as Record<string, unknown> } };
  if (command.action === "getRun") {
    const runId = command.payload?.runId;
    if (!runId) throw new Error("A run ID is required.");
    return { state, message: "Run loaded", details: { report: repository.exportRun(runId) } };
  }
  if (command.action === "clearRuns") {
    if (observer.isObserving || runner.isRunning || runJob.active) throw new Error("CANNOT_CLEAR_HISTORY_WHILE_RECORDING");
    repository.clearRuns();
    return { state, message: "History cleared", details: { runs: [] } };
  }
  if (observer.isObserving) await observer.toggle();
  await browser.close();
  return status("IDLE", "Browser: Closed");
}

readline.createInterface({ input: process.stdin }).on("line", async line => {
  let command: Command | undefined;
  try {
    command = JSON.parse(line) as Command;
    send({ type: "response", id: command.id, ok: true, result: await handle(command) });
    if (command.action === "shutdown") process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ type: "response", id: command?.id ?? "unknown", ok: false, error: message });
    status("ERROR", message);
  }
});
