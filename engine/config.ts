export const AutomationLimits = {
  shortTimeoutMs: 1_000,
  selectionPollMs: 100,
  // Manual users may advance quickly after reviewing Cambridge feedback.
  // Capture frequently, but serialize work in ManualObserver to avoid overlap.
  observationPollMs: 20,
  normalTimeoutMs: 7_000,
  longTimeoutMs: 15_000,
  maxScreensPerRun: 100,
  maxActionsPerScreen: 25,
  maxCheckboxSelections: 12,
  maxRetries: 2
} as const;
