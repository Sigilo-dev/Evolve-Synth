export type RunJobState = "RUNNING" | "DETECTING_SCREEN" | "ANSWERING" | "VERIFYING" | "CHECKING" | "RECORDING" | "ADVANCING" | "FINISHED" | "STOPPED" | "ERROR" | "UNSUPPORTED";
export type RunJobStatus = { runId: string; state: RunJobState; screenNumber?: number | null; totalScreens?: number; message: string; reason?: string };

const terminal = new Set<RunJobState>(["FINISHED", "STOPPED", "ERROR", "UNSUPPORTED"]);

/** Keeps the JSONL request short while the browser work executes on a later turn. */
export class RunJob {
  private current: RunJobStatus | undefined;
  private stopRequested = false;

  get active(): boolean { return Boolean(this.current && !terminal.has(this.current.state)); }
  get status(): RunJobStatus | undefined { return this.current ? { ...this.current } : undefined; }

  start(task: () => Promise<void>): RunJobStatus {
    if (this.active) throw new Error("An activity run is already in progress.");
    this.stopRequested = false;
    this.current = { runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, state: "RUNNING", message: "RUN_STARTED" };
    const accepted = this.status!;
    setTimeout(() => { void task().catch(error => this.update("ERROR", error instanceof Error ? error.message : String(error))); }, 0);
    return accepted;
  }

  requestStop(): void { this.stopRequested = true; }
  get cancellationRequested(): boolean { return this.stopRequested; }

  update(state: RunJobState, message: string, details?: Record<string, unknown>): RunJobStatus | undefined {
    if (!this.current) return undefined;
    this.current = {
      ...this.current,
      state,
      message,
      ...(typeof details?.screenNumber === "number" || details?.screenNumber === null ? { screenNumber: details.screenNumber as number | null } : {}),
      ...(typeof details?.totalScreens === "number" ? { totalScreens: details.totalScreens } : {}),
      ...(state === "ERROR" || state === "UNSUPPORTED" ? { reason: message } : {})
    };
    return this.status;
  }
}
