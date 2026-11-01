import {
  ExecutionTelemetry,
  type ExecutionMetrics,
  type ExecutionReporter,
} from "./execution-telemetry.js";
import type { BrowserExecutionContext } from "../browser/browser-execution-context.js";
import { ExecutionStoppedError } from "../browser/browser-execution-context.js";
export { ExecutionStoppedError } from "../browser/browser-execution-context.js";

export interface ExecutionControllerOptions {
  timeoutMs: number;
  maxBrowserActions: number;
  signal?: AbortSignal;
  now?: () => number;
}

export class ExecutionController implements ExecutionReporter, BrowserExecutionContext {
  private readonly startedAt: number;
  private readonly telemetry: ExecutionTelemetry;
  private readonly abortSignal: AbortSignal;

  constructor(private readonly options: ExecutionControllerOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(options.maxBrowserActions) || options.maxBrowserActions <= 0) {
      throw new RangeError("maxBrowserActions must be a positive safe integer.");
    }
    const now = options.now ?? Date.now;
    this.startedAt = now();
    this.telemetry = new ExecutionTelemetry(now);
    this.abortSignal = options.signal ?? new AbortController().signal;
  }

  checkpoint(): void {
    if (this.abortSignal.aborted) throw new ExecutionStoppedError("cancelled");
    if ((this.options.now ?? Date.now)() - this.startedAt >= this.options.timeoutMs) {
      throw new ExecutionStoppedError("timed_out");
    }
  }

  beforeBrowserAction(): void {
    this.checkpoint();
    if (this.telemetry.snapshot().browserActionCount >= this.options.maxBrowserActions) {
      throw new ExecutionStoppedError("action_budget_exceeded");
    }
    this.telemetry.recordBrowserAction();
  }

  recordBrowserAction(): void {
    this.beforeBrowserAction();
  }

  recordDomInspection(): void {
    this.telemetry.recordDomInspection();
  }

  recordScreenshot(count?: number): void {
    this.telemetry.recordScreenshot(count);
  }

  recordExplicitWait(durationMs: number): void {
    this.telemetry.recordExplicitWait(durationMs);
  }

  recordRetry(): void {
    this.telemetry.recordRetry();
  }

  startStage(stage: Parameters<ExecutionReporter["startStage"]>[0]): void {
    this.telemetry.startStage(stage);
  }

  endStage(stage: Parameters<ExecutionReporter["endStage"]>[0]): void {
    this.telemetry.endStage(stage);
  }

  finish(status: ExecutionMetrics["status"]): ExecutionMetrics {
    return this.telemetry.finish(status);
  }

  get remainingMs(): number {
    return Math.max(
      0,
      this.options.timeoutMs - ((this.options.now ?? Date.now)() - this.startedAt),
    );
  }

  get signal(): AbortSignal {
    return this.abortSignal;
  }
}
