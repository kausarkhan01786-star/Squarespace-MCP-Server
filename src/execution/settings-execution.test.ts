import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilityRegistry } from "../capabilities/capability-registry.js";
import { squarespaceCapabilityBindings } from "../capabilities/providers/squarespace.js";
import { formatProposalForHuman } from "../approval/mcp-human-approval.js";
import {
  createMutationProposal,
  MutationApprovalGuard,
  type MutationProposalInput,
} from "../approval/mutation-approval.js";
import { SettingsChangePlanner } from "../planning/settings-change-planner.js";
import type { SettingsPlanningField } from "../planning/settings-change-types.js";
import { SettingsExecutionService } from "./settings-execution-service.js";
import type { SettingsExecutionProvider } from "./settings-execution-types.js";

const permission = "settings.website.write";

function testedSettingsRegistry(): CapabilityRegistry {
  const website = squarespaceCapabilityBindings.find((binding) =>
    binding.capabilityId === "settings.website");
  assert.ok(website);
  return new CapabilityRegistry([
    ...squarespaceCapabilityBindings.filter((binding) =>
      binding.capabilityId !== "settings.website"),
    {
      ...website,
      operations: {
        ...website.operations,
        update: {
          status: "IMPLEMENTED_AND_TESTED",
          toolNames: ["test-only-update"],
          mechanism: "browser_ui",
          permissions: [permission],
          humanApproval: "required",
          verificationRequirements: ["fixture-only"],
          recoveryStrategy: "none",
          limitations: [],
        },
      },
    },
  ]);
}

function field(value: string): SettingsPlanningField {
  return {
    fieldId: "timezone",
    fieldLabel: "Time Zone",
    currentValue: value,
    valueType: "string",
    valueStatus: "AVAILABLE",
    source: "fixture",
    inspectionConfidence: 0.99,
    isSensitive: false,
    limitations: [],
  };
}

async function fixture() {
  let legacyWriterAccesses = 0;
  const provider: SettingsExecutionProvider = {
    cms: "squarespace",
    async listSites() {
      return [{ id: "site-1", name: "Fixture site" }];
    },
    async inspectCategory() {
      return {
        status: "PARTIALLY_AVAILABLE",
        fields: [field("America/New_York")],
        source: "fixture",
        limitations: [],
        errors: [],
      };
    },
    capabilityIdForCategory(categoryId) {
      return categoryId === "website" ? "settings.website" : undefined;
    },
    async getGrantedPermissions() {
      return [permission];
    },
  };
  Object.defineProperty(provider, "updateField", {
    get() {
      legacyWriterAccesses += 1;
      throw new Error("legacy non-CAS writer must never be accessed");
    },
  });
  const registry = testedSettingsRegistry();
  const planner = new SettingsChangePlanner(
    new Map([["squarespace", provider]]),
    registry,
  );
  const plan = await planner.analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  assert.equal(plan.status, "READY_FOR_APPROVAL");

  const service = new SettingsExecutionService({
    planner,
    providers: new Map([["squarespace", provider]]),
    registry,
  });
  return {
    legacyWriterAccesses: () => legacyWriterAccesses,
    plan,
    provider,
    service,
  };
}

test("valid plans fail closed before approval and cannot reach a legacy writer", async () => {
  const context = await fixture();
  const result = await context.service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["ATOMIC_PROVIDER_ADAPTER_NOT_INTEGRATED"]);
  assert.equal(result.approvalStatus, "NOT_REQUESTED");
  assert.equal(context.legacyWriterAccesses(), 0);
  assert.equal(
    context.service.getSettingsExecutionResult(result.executionId),
    result,
  );
});

test("legacy-only and repeated requests cannot bypass the disabled execution path", async () => {
  const context = await fixture();
  const input = {
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  };
  const result = await context.service.executeApprovedSettingsChange(input);
  const repeated = await context.service.executeApprovedSettingsChange(input);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasonCodes.includes("ATOMIC_PROVIDER_ADAPTER_NOT_INTEGRATED"));
  assert.deepEqual(repeated.reasonCodes, result.reasonCodes);
  assert.equal(context.legacyWriterAccesses(), 0);
});

test("the production Squarespace status remains disabled and read-only", async () => {
  const context = await fixture();
  const service = new SettingsExecutionService({
    planner: {
      getSettingsChangePlan: (id) => id === context.plan.planId
        ? context.plan
        : undefined,
    },
    providers: new Map(),
  });
  const result = await service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  });
  const report = service.getSettingsExecutionStatus("squarespace");
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["ATOMIC_PROVIDER_ADAPTER_NOT_INTEGRATED"]);
  assert.equal(report.executionProviderConfigured, false);
  assert.equal(report.mutationToolExposed, false);
  assert.ok(report.capabilities.some((capability) =>
    capability.capabilityId === "settings.website" &&
    capability.updateStatus === "NOT_IMPLEMENTED" &&
    capability.executable === false));
});

test("missing plans remain blocked without approval", async () => {
  const context = await fixture();
  const result = await context.service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: "unknown-change",
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["PLAN_OR_CHANGE_NOT_FOUND"]);
  assert.equal(context.legacyWriterAccesses(), 0);
});

const settingsProposal: MutationProposalInput = {
  provider: "squarespace",
  websiteId: "site-1",
  action: "settings.update",
  targetResource: "setting:website:timezone",
  payload: {
    planId: "plan-1",
    planFingerprint: "a".repeat(64),
    categoryId: "website",
    fieldId: "timezone",
    currentValue: "America/New_York",
    proposedValue: "Asia/Dhaka",
  },
  permissionScopes: ["settings.update"],
};

test("approval receipt is one-use and bound to CMS, site, field, operation, and values", async () => {
  const guard = new MutationApprovalGuard({ requestApproval: async () => true });
  const accepted = await guard.requestApproval(settingsProposal);
  const assertMismatch = async (input: Parameters<
    MutationApprovalGuard["assertAuthorized"]
  >[0]) => {
    const auth = await guard.requestApproval(settingsProposal);
    await assert.rejects(guard.runAuthorized(
      auth.proposal,
      auth.receipt,
      async () => guard.assertAuthorized(input),
    ), { reason: "scope_mismatch" });
  };
  const expected = {
    scope: "settings.update" as const,
    provider: "squarespace",
    websiteId: "site-1",
    action: "settings.update",
    targetResource: "setting:website:timezone",
    payload: settingsProposal.payload,
  };
  await assertMismatch({ ...expected, provider: "wordpress" });
  await assertMismatch({ ...expected, websiteId: "site-2" });
  await assertMismatch({ ...expected, targetResource: "setting:website:language" });
  await assertMismatch({ ...expected, action: "settings.delete" });
  await assertMismatch({
    ...expected,
    payload: { ...settingsProposal.payload, proposedValue: "Europe/London" },
  });
  await guard.runAuthorized(
    accepted.proposal,
    accepted.receipt,
    async () => guard.assertAuthorized(expected),
  );
  await assert.rejects(guard.runAuthorized(
    accepted.proposal,
    accepted.receipt,
    async () => guard.assertAuthorized(expected),
  ), { reason: "replayed" });
});

test("concurrent consumers cannot both use the same approval receipt", async () => {
  const guard = new MutationApprovalGuard({ requestApproval: async () => true });
  const authorization = await guard.requestApproval(settingsProposal);
  let releaseOperation: (() => void) | undefined;
  const operationWait = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  let operationCalls = 0;
  const first = guard.runAuthorized(
    authorization.proposal,
    authorization.receipt,
    async () => {
      operationCalls += 1;
      await operationWait;
    },
  );
  const second = guard.runAuthorized(
    authorization.proposal,
    authorization.receipt,
    async () => {
      operationCalls += 1;
    },
  );
  await assert.rejects(second, { reason: "replayed" });
  releaseOperation?.();
  await first;
  assert.equal(operationCalls, 1);
});

test("settings approval cannot be combined with Publish or authorize a Publish operation", async () => {
  const guard = new MutationApprovalGuard({ requestApproval: async () => true });
  const proposal = createMutationProposal(settingsProposal);
  const prompt = formatProposalForHuman(proposal);
  assert.match(prompt, /exact settings update shown/);
  assert.match(prompt, /does not authorize page-content Save or Publish/);
  await assert.rejects(guard.requestApproval({
    ...settingsProposal,
    permissionScopes: ["settings.update", "content.publish"],
  }), { reason: "invalid" });

  const accepted = await guard.requestApproval(settingsProposal);
  await assert.rejects(guard.runAuthorized(
    accepted.proposal,
    accepted.receipt,
    async () => guard.assertAuthorized({
      scope: "content.publish",
      provider: "squarespace",
      websiteId: "site-1",
      action: "settings.update",
      targetResource: "setting:website:timezone",
      payload: settingsProposal.payload,
    }),
  ), { reason: "scope_mismatch" });
});
