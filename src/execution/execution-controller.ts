import {
  ExecutionTelemetry,
  type ExecutionMetrics,
  type ExecutionReporter,
} from "./execution-telemetry.js";
import type { BrowserExecutionContext } from "../browser/browser-execution-context.js";
import { ExecutionStoppedError } from "../browser/browser-execution-context.js";
export { ExecutionStoppedError } from "../browser/browser-execution-context.js";
export { awaitExecutionOperation } from "../browser/browser-execution-context.js";

export interface ExecutionControllerOptions {
  timeoutMs: number;
  maxBrowserActions: number;
  signal?: AbortSignal;
  workflowId?: string;
  now?: () => number;
}

export class ExecutionController implements ExecutionReporter, BrowserExecutionContext {
  private readonly startedAt: number;
  private readonly telemetry: ExecutionTelemetry;
  private readonly abortSignal: AbortSignal;
  private readonly abortController = new AbortController();
  private readonly deadlineTimer: NodeJS.Timeout;
  private readonly parentSignal: AbortSignal | undefined;
  private readonly parentAbortListener: (() => void) | undefined;
  private currentTaskId: string | undefined;
  private mutationInFlight = false;
  readonly workflowId: string | undefined;
  readonly deadlineAt: number;

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
    this.workflowId = options.workflowId;
    this.deadlineAt = Date.now() + options.timeoutMs;
    this.parentSignal = options.signal;
    this.parentAbortListener = options.signal
      ? () => this.abortController.abort(
          options.signal?.reason instanceof ExecutionStoppedError
            ? options.signal.reason
            : new ExecutionStoppedError("cancelled"),
        )
      : undefined;
    if (options.signal && this.parentAbortListener) {
      options.signal.addEventListener("abort", this.parentAbortListener, { once: true });
      if (options.signal.aborted) this.parentAbortListener();
    }
    this.deadlineTimer = setTimeout(
      () => this.abortController.abort(new ExecutionStoppedError("timed_out")),
      options.timeoutMs,
    );
    this.deadlineTimer.unref();
    this.abortSignal = this.abortController.signal;
  }

  checkpoint(): void {
    if (this.abortSignal.aborted) {
      throw this.abortSignal.reason instanceof ExecutionStoppedError
        ? this.abortSignal.reason
        : new ExecutionStoppedError("cancelled");
    }
    if ((this.options.now ?? Date.now)() - this.startedAt >= this.options.timeoutMs) {
      this.abortController.abort(new ExecutionStoppedError("timed_out"));
      throw this.abortSignal.reason;
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
    clearTimeout(this.deadlineTimer);
    if (this.parentSignal && this.parentAbortListener) {
      this.parentSignal.removeEventListener("abort", this.parentAbortListener);
    }
    return this.telemetry.finish(status);
  }

  get remainingMs(): number {
    return Math.max(
      0,
      this.deadlineAt - Date.now(),
    );
  }

  get signal(): AbortSignal {
    return this.abortSignal;
  }

  get taskId(): string | undefined {
    return this.currentTaskId;
  }

  setTaskId(taskId: string | undefined): void {
    this.currentTaskId = taskId;
  }

  get mutationOutcomeUncertain(): boolean {
    return this.mutationInFlight;
  }

  markMutationStarted(): void {
    this.checkpoint();
    this.mutationInFlight = true;
  }

  markMutationVerified(): void {
    this.mutationInFlight = false;
  }

  abort(reason: ExecutionStoppedError): void {
    this.abortController.abort(reason);
  }
}
