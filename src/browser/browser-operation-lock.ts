import { AsyncLocalStorage } from "node:async_hooks";
import {
  withBrowserExecutionContext,
  ExecutionStoppedError,
  stopReasonFromSignal,
  type BrowserExecutionContext,
} from "./browser-execution-context.js";
import { SquarespaceBrowserError } from "./browser-errors.js";
import { logError } from "../utils/logger.js";

const activeLocks = new AsyncLocalStorage<ReadonlySet<BrowserOperationLock>>();
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
  queued: boolean;
}

export interface BrowserOperationOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  executionContext?: BrowserExecutionContext;
  onAbort?: () => void;
}

export class BrowserOperationLockTimeoutError extends SquarespaceBrowserError {
  constructor(timeoutMs: number) {
    super(
      "BROWSER_OPERATION_LOCK_TIMEOUT",
      `Timed out after ${timeoutMs}ms waiting for the shared browser operation lock.`,
    );
  }
}

export class BrowserOperationQueueFullError extends SquarespaceBrowserError {
  constructor(maxWaiters: number) {
    super(
      "BROWSER_OPERATION_QUEUE_FULL",
      `The shared browser operation queue is full (maximum ${maxWaiters} waiting operations). Retry after an operation completes.`,
    );
  }
}

export class BrowserOperationLock {
  private locked = false;
  private readonly waiters: Waiter[] = [];
  private readonly idleListeners = new Set<() => void>();

  constructor(
    private readonly acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
    readonly maxWaiters = 32,
  ) {
    if (!Number.isSafeInteger(acquireTimeoutMs) || acquireTimeoutMs <= 0) {
      throw new RangeError("acquireTimeoutMs must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 0) {
      throw new RangeError("maxWaiters must be a non-negative safe integer.");
    }
  }

  get isIdle(): boolean {
    return !this.locked && this.waiters.length === 0;
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("timeoutMs must be a non-negative safe integer.");
    }
    if (this.isIdle) return true;
    if (timeoutMs === 0) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleListeners.delete(onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(this.isIdle), timeoutMs);
      timer.unref();
      this.idleListeners.add(onIdle);
      if (this.isIdle) finish(true);
    });
  }

  async runExclusive<T>(
    operation: () => Promise<T> | T,
    options: BrowserOperationOptions = {},
  ): Promise<T> {
    const active = activeLocks.getStore();
    if (active?.has(this)) {
      if (options.signal?.aborted) throw stopReasonFromSignal(options.signal);
      return operation();
    }

    const release = await this.acquire(options);
    const nestedLocks = new Set(active ?? []);
    nestedLocks.add(this);
    let releaseWhenOperationEnds = false;
    const operationPromise = activeLocks.run(
      nestedLocks,
      () => options.executionContext
        ? withBrowserExecutionContext(
            options.executionContext,
            () => Promise.resolve().then(operation),
          )
        : Promise.resolve().then(operation),
    );
    try {
      if (!options.signal) return await operationPromise;
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          releaseWhenOperationEnds = true;
          void operationPromise.then(release, release);
          reject(stopReasonFromSignal(options.signal!));
          try {
            options.onAbort?.();
          } catch (error) {
            logError("browser_operation_cancel_failed", error);
          }
        };
        options.signal!.addEventListener("abort", onAbort, { once: true });
        if (options.signal!.aborted) {
          onAbort();
          return;
        }
        operationPromise.then(
          (result) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          },
        );
      });
    } finally {
      if (!releaseWhenOperationEnds) release();
    }
  }

  private acquire(options: BrowserOperationOptions): Promise<() => void> {
    if (options.signal?.aborted) return Promise.reject(stopReasonFromSignal(options.signal));
    const deadlineRemaining = options.deadlineAt === undefined
      ? this.acquireTimeoutMs
      : options.deadlineAt - Date.now();
    if (deadlineRemaining <= 0) {
      return Promise.reject(new ExecutionStoppedError("timed_out"));
    }
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.createRelease());
    }
    if (this.waiters.length >= this.maxWaiters) {
      return Promise.reject(new BrowserOperationQueueFullError(this.maxWaiters));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        queued: true,
        timer: setTimeout(() => {
          if (!waiter.queued) return;
          this.removeWaiter(waiter);
          reject(
            options.deadlineAt !== undefined &&
                options.deadlineAt - Date.now() <= this.acquireTimeoutMs
              ? new ExecutionStoppedError("timed_out")
              : new BrowserOperationLockTimeoutError(this.acquireTimeoutMs),
          );
        }, Math.min(this.acquireTimeoutMs, deadlineRemaining)),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      waiter.timer.unref();
      this.waiters.push(waiter);
      waiter.abortListener = () => {
        if (!waiter.queued) return;
        this.removeWaiter(waiter);
        reject(stopReasonFromSignal(options.signal!));
      };
      options.signal?.addEventListener("abort", waiter.abortListener, { once: true });
      if (options.signal?.aborted) waiter.abortListener();
    });
  }

  private removeWaiter(waiter: Waiter): void {
    waiter.queued = false;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      while (this.waiters.length > 0) {
        const next = this.waiters.shift();
        if (!next?.queued) continue;
        this.removeWaiter(next);
        next.resolve(this.createRelease());
        return;
      }

      this.locked = false;
      const idleListeners = [...this.idleListeners];
      this.idleListeners.clear();
      for (const listener of idleListeners) listener();
    };
  }
}
