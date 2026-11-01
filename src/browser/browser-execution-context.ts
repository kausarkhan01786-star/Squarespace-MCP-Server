import type { ExecutionStage } from "../execution/execution-telemetry.js";

export type ExecutionStopReason = "cancelled" | "timed_out" | "action_budget_exceeded";

export class ExecutionStoppedError extends Error {
  constructor(readonly reason: ExecutionStopReason) {
    super(reason === "cancelled"
      ? "Execution was cancelled at a safe checkpoint."
      : reason === "timed_out"
        ? "Execution deadline was reached at a safe checkpoint."
        : "The browser-action budget was exhausted at a safe checkpoint.");
    this.name = "ExecutionStoppedError";
  }
}

export interface BrowserExecutionContext {
  readonly signal: AbortSignal;
  readonly remainingMs: number;
  checkpoint(): void;
  beforeBrowserAction(): void;
  recordDomInspection(): void;
  recordScreenshot(count?: number): void;
  recordExplicitWait(durationMs: number): void;
  startStage(stage: ExecutionStage): void;
  endStage(stage: ExecutionStage): void;
}
