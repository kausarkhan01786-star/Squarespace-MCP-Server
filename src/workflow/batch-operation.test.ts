import assert from "node:assert/strict";
import test from "node:test";
import {
  planBatchOperations,
  recordBatchExecution,
  recordBatchVerification,
} from "./batch-operation.js";

test("keeps planned, supported, executed, verified, and unsupported operations distinct", () => {
  const plan = planBatchOperations([
    {
      id: "hero-section",
      capability: "create_section",
      operation: { kind: "create_section", sectionId: "hero", placement: "bottom" },
    },
    {
      id: "hero-image",
      capability: "add_image",
      operation: { kind: "add_image", sectionId: "hero", elementId: "image", assetId: "asset-1" },
    },
  ], new Set(["create_section"]));

  assert.equal(plan.plannedOperations.length, 2);
  assert.deepEqual(plan.supportedOperations.map(({ id }) => id), ["hero-section"]);
  assert.deepEqual(plan.unsupportedOperations.map(({ id }) => id), ["hero-image"]);
  assert.equal(plan.executedOperations.length, 0);
  assert.equal(plan.verifiedOperations.length, 0);

  recordBatchExecution(plan, "hero-section", true);
  assert.equal(plan.executedOperations[0]?.status, "executed");
  recordBatchVerification(plan, "hero-section", true);
  assert.equal(plan.verifiedOperations[0]?.status, "verified");
});

test("does not execute an unsupported operation", () => {
  const plan = planBatchOperations([
    {
      id: "hero-image",
      capability: "add_image",
      operation: { kind: "add_image", sectionId: "hero", elementId: "image", assetId: "asset-1" },
    },
  ], new Set());

  assert.throws(() => recordBatchExecution(plan, "hero-image", true), /supported planned operation/);
});
