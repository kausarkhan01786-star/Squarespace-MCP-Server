import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionController,
  ExecutionStoppedError,
} from "../execution/execution-controller.js";

test("records telemetry counts, wait time, stage duration, and total duration", () => {
  let now = 100;
  const controller = new ExecutionController({
    timeoutMs: 1_000,
    maxBrowserActions: 5,
    now: () => now,
  });
  controller.startStage("section_creation");
  controller.beforeBrowserAction();
  controller.recordDomInspection();
  controller.recordScreenshot(2);
  controller.recordExplicitWait(25);
  now += 80;
  controller.endStage("section_creation");
  now += 20;

  assert.deepEqual(controller.finish("succeeded"), {
    totalDurationMs: 100,
    browserActionCount: 1,
    domInspectionCount: 1,
    screenshotCount: 2,
    explicitWaitDurationMs: 25,
    retryCount: 0,
    stageDurationsMs: { section_creation: 80 },
    status: "succeeded",
  });
});

test("enforces the browser-action budget before exceeding it", () => {
  const controller = new ExecutionController({ timeoutMs: 1_000, maxBrowserActions: 1 });
  controller.beforeBrowserAction();
  assert.throws(
    () => controller.beforeBrowserAction(),
    (error: unknown) =>
      error instanceof ExecutionStoppedError && error.reason === "action_budget_exceeded",
  );
  assert.equal(controller.finish("interrupted").browserActionCount, 1);
});

test("reports deadlines and propagates cancellation at checkpoints", () => {
  let now = 0;
  const timed = new ExecutionController({
    timeoutMs: 10,
    maxBrowserActions: 2,
    now: () => now,
  });
  now = 10;
  assert.throws(
    () => timed.checkpoint(),
    (error: unknown) => error instanceof ExecutionStoppedError && error.reason === "timed_out",
  );

  const cancellation = new AbortController();
  const cancelled = new ExecutionController({
    timeoutMs: 1_000,
    maxBrowserActions: 2,
    signal: cancellation.signal,
  });
  cancellation.abort();
  assert.throws(
    () => cancelled.checkpoint(),
    (error: unknown) => error instanceof ExecutionStoppedError && error.reason === "cancelled",
  );
});
