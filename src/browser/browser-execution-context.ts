import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Locator, Page } from "playwright";
import type { ExecutionStage } from "../execution/execution-telemetry.js";

const executionContextStorage = new AsyncLocalStorage<BrowserExecutionContext>();

export type ExecutionStopReason =
  | "cancelled"
  | "timed_out"
  | "browser_operation_timeout"
  | "api_request_timeout"
  | "action_budget_exceeded";

export class ExecutionStoppedError extends Error {
  constructor(
    readonly reason: ExecutionStopReason,
    readonly mutationOutcomeUncertain = false,
  ) {
    super(messageForReason(reason, mutationOutcomeUncertain));
    this.name = "ExecutionStoppedError";
  }
}

export interface BrowserExecutionContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly workflowId: string | undefined;
  readonly taskId: string | undefined;
  readonly mutationOutcomeUncertain: boolean;
  readonly remainingMs: number;
  checkpoint(): void;
  beforeBrowserAction(): void;
  recordDomInspection(): void;
  recordScreenshot(count?: number): void;
  recordExplicitWait(durationMs: number): void;
  startStage(stage: ExecutionStage): void;
  endStage(stage: ExecutionStage): void;
  markMutationStarted(): void;
  markMutationVerified(): void;
}

export function withBrowserExecutionContext<T>(
  execution: BrowserExecutionContext,
  operation: () => Promise<T>,
): Promise<T> {
  return executionContextStorage.run(execution, operation);
}

export function currentBrowserExecutionContext(): BrowserExecutionContext | undefined {
  return executionContextStorage.getStore();
}

function messageForReason(
  reason: ExecutionStopReason,
  mutationOutcomeUncertain: boolean,
): string {
  const message = reason === "cancelled"
    ? "Execution was cancelled."
    : reason === "timed_out"
      ? "Execution deadline was exceeded."
      : reason === "browser_operation_timeout"
        ? "A browser operation timed out."
        : reason === "api_request_timeout"
          ? "An API request timed out."
          : "The browser-action budget was exhausted.";
  return mutationOutcomeUncertain
    ? `${message} A save may already have reached the CMS; the final state is uncertain and requires verification. Do not retry automatically.`
    : message;
}

export function stopReasonFromSignal(signal: AbortSignal): ExecutionStoppedError {
  return signal.reason instanceof ExecutionStoppedError
    ? signal.reason
    : new ExecutionStoppedError("cancelled");
}

export async function awaitExecutionOperation<T>(
  operation: Promise<T>,
  execution: BrowserExecutionContext,
  onAbort?: () => void,
): Promise<T> {
  execution.checkpoint();
  let removeAbortListener = () => {};
  const stopped = new Promise<never>((_, reject) => {
    const onAbortSignal = () => {
      reject(stopReasonFromSignal(execution.signal));
      onAbort?.();
    };
    execution.signal.addEventListener("abort", onAbortSignal, { once: true });
    removeAbortListener = () =>
      execution.signal.removeEventListener("abort", onAbortSignal);
    if (execution.signal.aborted) onAbortSignal();
  });
  try {
    return await Promise.race([operation, stopped]);
  } finally {
    removeAbortListener();
  }
}

export async function awaitPlaywrightOperation<T>(
  operation: Promise<T>,
  execution: BrowserExecutionContext,
  onAbort?: () => void,
): Promise<T> {
  try {
    return await awaitExecutionOperation(operation, execution, onAbort);
  } catch (error) {
    if (!(error instanceof ExecutionStoppedError)) throw error;
    try {
      await operation;
    } catch (operationError) {
      if (!execution.signal.aborted) throw operationError;
    }
    throw error;
  }
}

export async function waitForExecutionCondition<T>(
  probe: () => Promise<T>,
  isSatisfied: (value: T) => boolean,
  execution: BrowserExecutionContext,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T> {
  const deadline = Math.min(Date.now() + timeoutMs, execution.deadlineAt);
  while (Date.now() < deadline) {
    execution.checkpoint();
    const value = await probe();
    if (isSatisfied(value)) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      await delay(Math.min(intervalMs, remaining), undefined, {
        signal: execution.signal,
      });
    } catch (error) {
      if (execution.signal.aborted) throw stopReasonFromSignal(execution.signal);
      throw error;
    }
  }
  execution.checkpoint();
  throw new ExecutionStoppedError("browser_operation_timeout");
}

export async function waitForLocatorState(
  locator: Locator,
  state: "visible" | "hidden" | "attached" | "detached",
  timeoutMs: number,
  execution = currentBrowserExecutionContext(),
): Promise<void> {
  if (!execution) {
    await locator.waitFor({ state, timeout: timeoutMs });
    return;
  }
  await waitForExecutionCondition(
    async () => {
      if (state === "visible" || state === "hidden") {
        const visible = await locator.isVisible();
        return state === "visible" ? visible : !visible;
      }
      const attached = (await locator.count()) > 0;
      return state === "attached" ? attached : !attached;
    },
    Boolean,
    execution,
    timeoutMs,
  );
}

export async function waitForPageUrl(
  page: Page,
  predicate: (url: URL) => boolean,
  timeoutMs: number,
  execution = currentBrowserExecutionContext(),
): Promise<void> {
  if (!execution) {
    await page.waitForURL(predicate, { timeout: timeoutMs });
    return;
  }
  await waitForExecutionCondition(
    async () => new URL(page.url()),
    predicate,
    execution,
    timeoutMs,
  );
}

export async function waitForExecutionDelay(
  durationMs: number,
  execution = currentBrowserExecutionContext(),
): Promise<void> {
  if (!execution) {
    await delay(durationMs);
    return;
  }
  execution.checkpoint();
  try {
    await delay(durationMs, undefined, { signal: execution.signal });
  } catch (error) {
    if (execution.signal.aborted) throw stopReasonFromSignal(execution.signal);
    throw error;
  }
  execution.checkpoint();
}
