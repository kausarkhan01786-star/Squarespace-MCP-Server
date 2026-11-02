import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CapabilityRegistry,
} from "../capabilities/capability-registry.js";
import { squarespaceCapabilityBindings } from "../capabilities/providers/squarespace.js";
import {
  formatProposalForHuman,
} from "../approval/mcp-human-approval.js";
import {
  createMutationProposal,
  MutationApprovalError,
  MutationApprovalGuard,
  type MutationProposal,
  type MutationProposalInput,
} from "../approval/mutation-approval.js";
import { SettingsChangePlanner } from "../planning/settings-change-planner.js";
import type {
  PlannedValue,
  SettingsPlanningField,
} from "../planning/settings-change-types.js";
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
          toolNames: ["execute_approved_settings_change"],
          mechanism: "browser_ui",
          permissions: [permission],
          humanApproval: "required",
          verificationRequirements: ["independently inspect the saved timezone"],
          recoveryStrategy: "none",
          limitations: [],
        },
      },
    },
  ]);
}

function makeField(value: PlannedValue): SettingsPlanningField {
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

async function fixture(options: {
  readonly providersConfigured?: boolean;
  readonly prompt?: (proposal: MutationProposal) => Promise<boolean>;
  readonly onApproval?: () => void;
  readonly updateFails?: boolean;
  readonly updateApplies?: boolean;
  readonly updateHangs?: boolean;
  readonly applyHangingUpdateOnSettle?: boolean;
  readonly updateTimeoutMs?: number;
} = {}) {
  let field = makeField("America/New_York");
  let sites = [{ id: "site-1", name: "Fixture site" }];
  let permissions: readonly string[] | null = [permission];
  let updateCalls = 0;
  let updateWasAborted = false;
  let settleHangingUpdate: (() => void) | undefined;
  let approvalCalls = 0;
  const provider: SettingsExecutionProvider = {
    cms: "squarespace",
    async listSites() {
      return sites;
    },
    async inspectCategory() {
      return {
        status: "PARTIALLY_AVAILABLE",
        fields: [field],
        source: "fixture",
        limitations: [],
        errors: [],
      };
    },
    capabilityIdForCategory(categoryId) {
      return categoryId === "website" ? "settings.website" : undefined;
    },
    async getGrantedPermissions() {
      return permissions;
    },
    async updateField(input) {
      updateCalls += 1;
      assert.equal(input.siteId, "site-1");
      assert.equal(input.categoryId, "website");
      assert.equal(input.fieldId, "timezone");
      assert.equal(input.expectedCurrentValue, "America/New_York");
      assert.equal(input.proposedValue, "Dhaka");
      if (options.updateHangs) {
        return new Promise<void>((_resolve) => {
          settleHangingUpdate = () => {
            if (options.applyHangingUpdateOnSettle) {
              field = makeField(input.proposedValue);
            }
            _resolve();
          };
          input.signal.addEventListener("abort", () => {
            updateWasAborted = true;
          }, { once: true });
        });
      }
      if (options.updateFails) throw new Error("fixture provider error");
      if (options.updateApplies !== false) field = makeField(input.proposedValue);
    },
  };
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

  const approval = new MutationApprovalGuard({
    async requestApproval(proposal) {
      approvalCalls += 1;
      options.onApproval?.();
      return options.prompt ? options.prompt(proposal) : true;
    },
  });
  const providers = options.providersConfigured === false
    ? new Map()
    : new Map([["squarespace", provider] as const]);
  const service = new SettingsExecutionService({
    planner,
    providers,
    approval,
    registry,
    ...(options.updateTimeoutMs === undefined
      ? {}
      : { updateTimeoutMs: options.updateTimeoutMs }),
  });
  return {
    plan,
    planner,
    service,
    provider,
    approval,
    counts: () => ({ updateCalls, approvalCalls }),
    updateWasAborted: () => updateWasAborted,
    settleHangingUpdate: () => settleHangingUpdate?.(),
    setField: (value: PlannedValue) => {
      field = makeField(value);
    },
    setSites: (value: typeof sites) => {
      sites = value;
    },
    setPermissions: (value: readonly string[] | null) => {
      permissions = value;
    },
  };
}

test("executes only an approved exact proposal and independently verifies the new value", async () => {
  const context = await fixture();
  const result = await context.service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.approvalStatus, "ACCEPTED");
  assert.equal(result.verificationStatus, "VERIFIED");
  assert.equal(result.recoveryStatus, "NOT_NEEDED");
  assert.match(result.proposalFingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(context.counts(), { updateCalls: 1, approvalCalls: 1 });
  assert.equal(
    context.service.getSettingsExecutionResult(result.executionId),
    result,
  );
});

test("the real Squarespace registry and default provider set keep execution disabled", async () => {
  const context = await fixture({ providersConfigured: false });
  const service = new SettingsExecutionService({
    planner: {
      getSettingsChangePlan: (id) => id === context.plan.planId
        ? context.plan
        : undefined,
    },
    providers: new Map(),
    approval: context.approval,
  });
  const result = await context.service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  });
  const report = service.getSettingsExecutionStatus("squarespace");
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["EXECUTION_PROVIDER_NOT_CONFIGURED"]);
  assert.equal(report.executionProviderConfigured, false);
  assert.equal(report.mutationToolExposed, false);
  assert.ok(report.capabilities.some((capability) =>
    capability.capabilityId === "settings.website" &&
    capability.updateStatus === "NOT_IMPLEMENTED" &&
    capability.executable === false));
  assert.deepEqual(context.counts(), { updateCalls: 0, approvalCalls: 0 });
});

test("the audited Squarespace update registry blocks even with a fixture provider", async () => {
  const context = await fixture();
  const service = new SettingsExecutionService({
    planner: {
      getSettingsChangePlan: (id) => id === context.plan.planId
        ? context.plan
        : undefined,
    },
    providers: new Map([["squarespace", context.provider]]),
    approval: context.approval,
  });
  const result = await service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["UPDATE_CAPABILITY_NOT_VERIFIED"]);
  assert.deepEqual(context.counts(), { updateCalls: 0, approvalCalls: 0 });
});

test("blocks unsupported or missing plans before approval", async () => {
  const context = await fixture();
  const missing = await context.service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: "not-a-change",
  });
  assert.equal(missing.status, "BLOCKED");
  assert.deepEqual(missing.reasonCodes, ["PLAN_OR_CHANGE_NOT_FOUND"]);
  assert.deepEqual(context.counts(), { updateCalls: 0, approvalCalls: 0 });
});

test("blocks a stale current value before approval", async () => {
  const context = await fixture();
  context.setField("Asia/Dhaka");
  const result = await context.service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["CURRENT_VALUE_STALE_OR_UNVERIFIED"]);
  assert.deepEqual(context.counts(), { updateCalls: 0, approvalCalls: 0 });
});

test("blocks a site that no longer resolves uniquely", async () => {
  const context = await fixture();
  context.setSites([
    { id: "site-1", name: "Original" },
    { id: "site-1", name: "Duplicate identity" },
  ]);
  const result = await context.service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["SITE_ID_NOT_VERIFIED"]);
  assert.deepEqual(context.counts(), { updateCalls: 0, approvalCalls: 0 });
});

test("blocks missing required permissions before asking for approval", async () => {
  const context = await fixture();
  context.setPermissions([]);
  const result = await context.service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.reasonCodes, ["REQUIRED_PERMISSION_MISSING"]);
  assert.deepEqual(context.counts(), { updateCalls: 0, approvalCalls: 0 });
});

test("rechecks the exact site, permissions, and current value after approval", async () => {
  let stale: Awaited<ReturnType<typeof fixture>> | undefined;
  stale = await fixture({
    onApproval: () => stale?.setField("Asia/Dhaka"),
  });
  const staleResult = await stale.service.executeApprovedSettingsChange({
    planId: stale.plan.planId,
    changeId: stale.plan.changes[0]!.changeId,
  });
  assert.equal(staleResult.status, "BLOCKED");
  assert.deepEqual(staleResult.reasonCodes, ["PRECONDITIONS_CHANGED_AFTER_APPROVAL"]);

  let approvalContext: Awaited<ReturnType<typeof fixture>> | undefined;
  approvalContext = await fixture({
    onApproval: () => approvalContext?.setPermissions([]),
  });
  const permissionResult = await approvalContext.service.executeApprovedSettingsChange({
    planId: approvalContext.plan.planId,
    changeId: approvalContext.plan.changes[0]!.changeId,
  });
  assert.equal(permissionResult.status, "BLOCKED");
  assert.deepEqual(permissionResult.reasonCodes, ["PRECONDITIONS_CHANGED_AFTER_APPROVAL"]);
  assert.equal(approvalContext.counts().updateCalls, 0);

  let changedSiteContext: Awaited<ReturnType<typeof fixture>> | undefined;
  changedSiteContext = await fixture({
    onApproval: () => changedSiteContext?.setSites([]),
  });
  const siteResult = await changedSiteContext.service.executeApprovedSettingsChange({
    planId: changedSiteContext.plan.planId,
    changeId: changedSiteContext.plan.changes[0]!.changeId,
  });
  assert.equal(siteResult.status, "BLOCKED");
  assert.deepEqual(siteResult.reasonCodes, ["PRECONDITIONS_CHANGED_AFTER_APPROVAL"]);
  assert.equal(changedSiteContext.counts().updateCalls, 0);
});

test("decline, cancellation, missing elicitation, and timeout all fail closed", async () => {
  const declined = await fixture({ prompt: async () => false });
  const declinedResult = await declined.service.executeApprovedSettingsChange({
    planId: declined.plan.planId,
    changeId: declined.plan.changes[0]!.changeId,
  });
  assert.equal(declinedResult.status, "BLOCKED");
  assert.equal(declinedResult.approvalStatus, "REJECTED_OR_CANCELLED");
  assert.equal(declined.counts().updateCalls, 0);

  const unavailable = await fixture({
    prompt: async () => {
      throw new MutationApprovalError("unavailable", "No form approval.");
    },
  });
  const unavailableResult = await unavailable.service.executeApprovedSettingsChange({
    planId: unavailable.plan.planId,
    changeId: unavailable.plan.changes[0]!.changeId,
  });
  assert.equal(unavailableResult.approvalStatus, "UNAVAILABLE");
  assert.equal(unavailable.counts().updateCalls, 0);

  let now = new Date("2026-01-01T00:00:00.000Z");
  const expiredContext = await fixture();
  const expiringApproval = new MutationApprovalGuard(
    {
      async requestApproval() {
        now = new Date(now.getTime() + 101);
        return true;
      },
    },
    100,
    () => now,
  );
  const expiredService = new SettingsExecutionService({
    planner: {
      getSettingsChangePlan: (id) => id === expiredContext.plan.planId
        ? expiredContext.plan
        : undefined,
    },
    providers: new Map([["squarespace", expiredContext.provider]]),
    approval: expiringApproval,
    registry: testedSettingsRegistry(),
  });
  const expiredResult = await expiredService.executeApprovedSettingsChange({
    planId: expiredContext.plan.planId,
    changeId: expiredContext.plan.changes[0]!.changeId,
  });
  assert.equal(expiredResult.approvalStatus, "EXPIRED");
  assert.equal(expiredContext.counts().updateCalls, 0);
});

test("provider update errors are uncertain, are not retried, and require manual recovery", async () => {
  const context = await fixture({ updateFails: true });
  const input = {
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  };
  const result = await context.service.executeApprovedSettingsChange(input);
  const second = await context.service.executeApprovedSettingsChange(input);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.verificationStatus, "UNKNOWN");
  assert.equal(result.recoveryStatus, "MANUAL_RECOVERY_REQUIRED");
  assert.deepEqual(result.reasonCodes, ["PROVIDER_UPDATE_OUTCOME_UNCERTAIN"]);
  assert.equal(second.status, "BLOCKED");
  assert.deepEqual(second.reasonCodes, ["MUTATION_ALREADY_ATTEMPTED"]);
  assert.equal(context.counts().updateCalls, 1);
});

test("update timeout aborts the provider signal and leaves the outcome uncertain", async () => {
  const context = await fixture({
    updateHangs: true,
    applyHangingUpdateOnSettle: true,
    updateTimeoutMs: 10,
  });
  const result = await context.service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.verificationStatus, "UNKNOWN");
  assert.equal(result.recoveryStatus, "MANUAL_RECOVERY_REQUIRED");
  assert.deepEqual(result.reasonCodes, ["PROVIDER_UPDATE_TIMED_OUT"]);
  assert.equal(context.updateWasAborted(), true);
  assert.equal(context.counts().updateCalls, 1);
});

test("a timed-out provider keeps its setting target locked until its promise settles", async () => {
  const context = await fixture({
    updateHangs: true,
    applyHangingUpdateOnSettle: true,
    updateTimeoutMs: 10,
  });
  const firstResult = await context.service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  });
  assert.equal(firstResult.status, "UNKNOWN");

  const secondPlan = await context.planner.analyzeSettingsChangeRequest({
    instruction: "Change my website timezone to Dhaka.",
    cmsProvider: "squarespace",
    siteId: "site-1",
  });
  const blocked = await context.service.executeApprovedSettingsChange({
    planId: secondPlan.planId,
    changeId: secondPlan.changes[0]!.changeId,
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.deepEqual(blocked.reasonCodes, [
    "TARGET_OUTCOME_UNCERTAIN_PROVIDER_STILL_RUNNING",
  ]);
  assert.equal(context.counts().updateCalls, 1);

  context.settleHangingUpdate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const retryAfterSettlement = await context.service.executeApprovedSettingsChange({
    planId: secondPlan.planId,
    changeId: secondPlan.changes[0]!.changeId,
  });
  assert.equal(retryAfterSettlement.status, "BLOCKED");
  assert.deepEqual(retryAfterSettlement.reasonCodes, [
    "CURRENT_VALUE_STALE_OR_UNVERIFIED",
  ]);
  assert.equal(context.counts().updateCalls, 1);
});

test("successful provider response with a mismatched read-back is not reported as success", async () => {
  const context = await fixture({ updateApplies: false });
  const result = await context.service.executeApprovedSettingsChange({
    planId: context.plan.planId,
    changeId: context.plan.changes[0]!.changeId,
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.verificationStatus, "FAILED");
  assert.equal(result.recoveryStatus, "MANUAL_RECOVERY_REQUIRED");
  assert.deepEqual(result.reasonCodes, ["POST_EXECUTION_VALUE_MISMATCH"]);
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
