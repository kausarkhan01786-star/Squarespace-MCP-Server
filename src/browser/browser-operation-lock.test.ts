import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserOperationLock,
  BrowserOperationQueueFullError,
  BrowserOperationLockTimeoutError,
} from "./browser-operation-lock.js";
import { ExecutionStoppedError } from "./browser-execution-context.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("serializes operations that share a browser page and preserves FIFO order", async () => {
  const lock = new BrowserOperationLock();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const activePageOperations: string[] = [];
  const order: string[] = [];

  const first = lock.runExclusive(async () => {
    activePageOperations.push("first");
    firstStarted.resolve();
    await releaseFirst.promise;
    order.push("first");
    activePageOperations.pop();
  });
  await firstStarted.promise;

  const second = lock.runExclusive(async () => {
    assert.deepEqual(activePageOperations, []);
    activePageOperations.push("second");
    order.push("second");
    activePageOperations.pop();
  });
  const third = lock.runExclusive(async () => {
    assert.deepEqual(activePageOperations, []);
    activePageOperations.push("third");
    order.push("third");
    activePageOperations.pop();
  });

  assert.deepEqual(order, []);
  releaseFirst.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ["first", "second", "third"]);
});

test("releases the browser lock after an operation fails", async () => {
  const lock = new BrowserOperationLock();
  const failure = lock.runExclusive(async () => {
    throw new Error("expected fixture failure");
  });

  await assert.rejects(failure, /expected fixture failure/);
  assert.equal(await lock.runExclusive(() => "next operation"), "next operation");
});

test("independent browser contexts can run concurrently", async () => {
  const firstContextLock = new BrowserOperationLock();
  const secondContextLock = new BrowserOperationLock();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const secondStarted = deferred();

  const first = firstContextLock.runExclusive(async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  const second = secondContextLock.runExclusive(async () => {
    secondStarted.resolve();
  });

  await secondStarted.promise;
  releaseFirst.resolve();
  await Promise.all([first, second]);
});

test("nested service calls reuse the current lock scope without deadlocking", async () => {
  const lock = new BrowserOperationLock();
  const result = await lock.runExclusive(async () => {
    const nested = await lock.runExclusive(async () => "nested result");
    return `outer and ${nested}`;
  });

  assert.equal(result, "outer and nested result");
});

test("times out queued acquisition and allows later waiters through", async () => {
  const lock = new BrowserOperationLock(20);
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const first = lock.runExclusive(async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  await assert.rejects(
    lock.runExclusive(() => "timed out"),
    (error: unknown) =>
      error instanceof BrowserOperationLockTimeoutError &&
      error.code === "BROWSER_OPERATION_LOCK_TIMEOUT",
  );

  const later = lock.runExclusive(() => "later waiter acquired");
  releaseFirst.resolve();
  await first;
  assert.equal(await later, "later waiter acquired");
});

test("cancels while waiting for the lock and keeps the held operation exclusive", async () => {
  const lock = new BrowserOperationLock(1_000);
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const cancellation = new AbortController();
  let cancelledOperationStarted = false;
  const first = lock.runExclusive(async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  const waiting = lock.runExclusive(
    () => {
      cancelledOperationStarted = true;
    },
    { signal: cancellation.signal },
  );
  cancellation.abort(new ExecutionStoppedError("cancelled"));
  await assert.rejects(waiting, { reason: "cancelled" });

  let nextStarted = false;
  const next = lock.runExclusive(() => {
    nextStarted = true;
  });
  await Promise.resolve();
  assert.equal(nextStarted, false);
  assert.equal(cancelledOperationStarted, false);

  releaseFirst.resolve();
  await Promise.all([first, next]);
  assert.equal(nextStarted, true);
});

test("reports active cancellation promptly but retains the lock until the browser operation settles", async () => {
  const lock = new BrowserOperationLock();
  const cancellation = new AbortController();
  const operationStarted = deferred();
  const settleOperation = deferred();
  const active = lock.runExclusive(async () => {
    operationStarted.resolve();
    await settleOperation.promise;
  }, { signal: cancellation.signal });
  await operationStarted.promise;

  cancellation.abort(new ExecutionStoppedError("cancelled"));
  await assert.rejects(active, { reason: "cancelled" });

  let nextStarted = false;
  const next = lock.runExclusive(() => {
    nextStarted = true;
  });
  await Promise.resolve();
  assert.equal(nextStarted, false);

  settleOperation.resolve();
  await next;
  assert.equal(nextStarted, true);
});

test("bounds queued browser operations and reports immediate admission failure", async () => {
  const lock = new BrowserOperationLock(1_000, 1);
  const started = deferred();
  const release = deferred();
  const first = lock.runExclusive(async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  const queued = lock.runExclusive(() => "queued");
  await assert.rejects(
    lock.runExclusive(() => "must not enter the queue"),
    (error: unknown) => error instanceof BrowserOperationQueueFullError &&
      error.code === "BROWSER_OPERATION_QUEUE_FULL",
  );
  release.resolve();
  await first;
  assert.equal(await queued, "queued");
  assert.equal(lock.isIdle, true);
});

test("waitForIdle reports timeout without releasing an active operation", async () => {
  const lock = new BrowserOperationLock();
  const started = deferred();
  const release = deferred();
  const active = lock.runExclusive(async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  assert.equal(await lock.waitForIdle(5), false);
  assert.equal(lock.isIdle, false);
  release.resolve();
  await active;
  assert.equal(await lock.waitForIdle(5), true);
});
