import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MutationApprovalError,
  MutationApprovalGuard,
  type MutationAuthorization,
} from "../../approval/mutation-approval.js";
import type { PlannedValue } from "../../planning/settings-change-types.js";
import {
  evaluateSettingsProviderEligibility,
  fingerprintSettingsOperation,
  validateProviderCapabilityEvidence,
  type ProviderEvidenceRecord,
  type ProviderEvidenceValidationPolicy,
  SETTINGS_PROVIDER_FEATURES,
  type AtomicSettingsUpdateRequest,
  type ProviderCapabilityEvidence,
  type SettingsProviderEligibilityContext,
  type SettingsProviderFeature,
  type SettingsTarget,
} from "./settings-provider-contract.js";
import { SyntheticSettingsProvider } from "./synthetic-settings-provider.js";

const target: SettingsTarget = {
  cms: "squarespace",
  siteId: "synthetic-site",
  categoryId: "website",
  settingId: "timezone",
};

const reviewDate = "2025-01-01T00:00:00.000Z";
const trustedEvidencePolicy: ProviderEvidenceValidationPolicy = {
  trustedPublishers: {
    OFFICIAL_DOCUMENTATION: ["docs.example.test"],
    OFFICIAL_API_REFERENCE: ["api.example.test"],
    OFFICIAL_PROVIDER_STATEMENT: ["vendor.example.test"],
    VERIFIED_PROVIDER_TEST: ["test-authority"],
    INDEPENDENT_SECURITY_REVIEW: ["review-authority"],
  },
  trustedReviewerAuthorities: ["security-review-board"],
  maxEvidenceAgeMs: null,
  allowVerifiedWithLimitationsForExecution: false,
};

function officialEvidence(
  feature: SettingsProviderFeature,
  overrides: Partial<ProviderEvidenceRecord> = {},
): ProviderEvidenceRecord {
  const isReadFeature = feature === "READ_SETTING" ||
    feature === "INDEPENDENT_READBACK";
  return {
    evidenceId: `evidence-${feature.toLowerCase()}`,
    type: "OFFICIAL_API_REFERENCE",
    cms: "squarespace",
    adapterId: "test-real-adapter",
    feature,
    operations: [isReadFeature ? "read" : "update"],
    reference: "https://api.example.test/docs/settings",
    publisherAuthority: "api.example.test",
    claim: feature === "READ_SETTING"
      ? "DOCUMENTED_CAPABILITY"
      : "DOCUMENTED_GUARANTEE",
    scope: `${feature} for the documented settings endpoint`,
    retrievedAt: reviewDate,
    reviewedAt: reviewDate,
    reviewStatus: "APPROVED",
    reviewerAuthority: "security-review-board",
    validity: "ACTIVE",
    validUntil: null,
    supersededBy: null,
    conflictsWith: [],
    limitations: [],
    verificationNotes: ["Illustrative test fixture; not a claim about a real provider."],
    ...overrides,
  };
}

function realDeclarationWithEvidence(
  provider: SyntheticSettingsProvider,
  feature: SettingsProviderFeature,
  records: readonly ProviderEvidenceRecord[],
) {
  return {
    ...provider.declaration,
    adapterId: "test-real-adapter",
    providerKind: "real" as const,
    features: {
      ...provider.declaration.features,
      [feature]: { status: "VERIFIED" as const, evidence: records },
    },
  };
}

function request(overrides: Partial<AtomicSettingsUpdateRequest> = {}): AtomicSettingsUpdateRequest {
  const merged = {
    target,
    expectedValue: "UTC",
    precondition: { kind: "version_token", version: "1" },
    proposedValue: "Asia/Dhaka",
    executionId: "execution-1",
    idempotencyKey: "idempotency-1",
    ...overrides,
  };
  return {
    ...merged,
    proposalFingerprint: overrides.proposalFingerprint ??
      fingerprintSettingsOperation({
        target: merged.target,
        expectedValue: merged.expectedValue,
        precondition: merged.precondition,
        proposedValue: merged.proposedValue,
        executionId: merged.executionId,
        idempotencyKey: merged.idempotencyKey,
        operationScope: "settings.update",
      }),
  };
}

function proposalInput(input: AtomicSettingsUpdateRequest) {
  return {
    provider: input.target.cms,
    websiteId: input.target.siteId,
    action: "settings.update",
    targetResource: `setting:${input.target.categoryId}:${input.target.settingId}`,
    payload: {
      expectedValue: input.expectedValue,
      precondition: input.precondition,
      proposedValue: input.proposedValue,
      executionId: input.executionId,
      idempotencyKey: input.idempotencyKey,
      proposalFingerprint: input.proposalFingerprint,
      operationScope: "settings.update",
    },
    permissionScopes: ["settings.update"] as const,
  };
}

async function authorizeAndUpdate(
  provider: SyntheticSettingsProvider,
  input: AtomicSettingsUpdateRequest,
): Promise<{
  readonly authorization: MutationAuthorization;
  readonly result: Awaited<ReturnType<SyntheticSettingsProvider["updateAtomically"]>>;
}> {
  const { guard: approval, authorization } = await authorize(input);
  const result = await approval.runAuthorized(
    authorization.proposal,
    authorization.receipt,
    async () => {
      approval.assertAuthorized({
        scope: "settings.update",
        provider: input.target.cms,
        websiteId: input.target.siteId,
        action: "settings.update",
        targetResource: `setting:${input.target.categoryId}:${input.target.settingId}`,
        payload: authorization.proposal.payload,
      });
      return provider.updateAtomically(input);
    },
  );
  return { authorization, result };
}

async function eligibilityContext(
  provider: SyntheticSettingsProvider,
  input: AtomicSettingsUpdateRequest,
  authorization: MutationAuthorization | null,
  approvalGuard: MutationApprovalGuard | null,
  options: { readonly providerAvailable?: boolean } = {},
): Promise<SettingsProviderEligibilityContext> {
  return {
    providerAvailable: options.providerAvailable ?? true,
    site: await provider.resolveAuthorizedSite(input.target.siteId),
    target: input.target,
    requiredPermissions: ["settings.website.write"],
    operation: {
      expectedValue: input.expectedValue,
      precondition: input.precondition,
      proposedValue: input.proposedValue,
      executionId: input.executionId,
      idempotencyKey: input.idempotencyKey,
      proposalFingerprint: input.proposalFingerprint,
      operationScope: "settings.update",
    },
    approval: authorization,
    approvalGuard,
  };
}

async function authorize(input: AtomicSettingsUpdateRequest): Promise<{
  readonly guard: MutationApprovalGuard;
  readonly authorization: MutationAuthorization;
}> {
  const guard = new MutationApprovalGuard({
    async requestApproval() {
      return true;
    },
  });
  return {
    guard,
    authorization: await guard.requestApproval(proposalInput(input)),
  };
}

function withFeatureStatus(
  provider: SyntheticSettingsProvider,
  feature: SettingsProviderFeature,
  status: ProviderCapabilityEvidence["status"],
) {
  return {
    ...provider.declaration,
    features: {
      ...provider.declaration.features,
      [feature]: {
        ...provider.declaration.features[feature],
        status,
      },
    },
  };
}

test("successful update applies atomically and is independently verified", async () => {
  const provider = new SyntheticSettingsProvider();
  const input = request();
  const { result } = await authorizeAndUpdate(provider, input);
  const verification = await provider.verifyIndependently(target, input.proposedValue);
  const state = provider.getState();

  assert.equal(result.outcome, "APPLIED");
  assert.equal(verification.matchesProposedValue, true);
  assert.equal(state.value, "Asia/Dhaka");
  assert.equal(state.version, "2");
  assert.equal(state.calls.update, 1);
  assert.equal(state.calls.mutation, 1);
  assert.equal(state.calls.verify, 1);
});

test("expected value mismatch conflicts without mutating", async () => {
  const provider = new SyntheticSettingsProvider();
  const result = await provider.updateAtomically(request({ expectedValue: "Europe/London" }));
  const state = provider.getState();
  assert.equal(result.outcome, "CONFLICT");
  assert.equal(result.evidence.kind, "VALUE_MISMATCH");
  assert.equal(state.value, "UTC");
  assert.equal(state.version, "1");
  assert.equal(state.calls.mutation, 0);
});

test("version mismatch conflicts without mutating", async () => {
  const provider = new SyntheticSettingsProvider();
  const result = await provider.updateAtomically(request({
    precondition: { kind: "version_token", version: "stale-version" },
  }));
  const state = provider.getState();
  assert.equal(result.outcome, "CONFLICT");
  assert.equal(result.evidence.kind, "VERSION_MISMATCH");
  assert.equal(state.value, "UTC");
  assert.equal(state.version, "1");
  assert.equal(state.calls.mutation, 0);
});

test("concurrent updates using one version allow exactly one write", async () => {
  const provider = new SyntheticSettingsProvider();
  const first = request({ proposedValue: "Asia/Dhaka", idempotencyKey: "first-key" });
  const second = request({ proposedValue: "Europe/London", idempotencyKey: "second-key" });
  const [firstResult, secondResult] = await Promise.all([
    provider.updateAtomically(first),
    provider.updateAtomically(second),
  ]);
  const outcomes = [firstResult.outcome, secondResult.outcome].sort();
  const state = provider.getState();
  assert.deepEqual(outcomes, ["APPLIED", "CONFLICT"]);
  assert.equal(state.calls.update, 2);
  assert.equal(state.calls.mutation, 1);
  assert.equal(state.version, "2");
  const winner = firstResult.outcome === "APPLIED" ? first : second;
  assert.equal(state.value, winner.proposedValue);
});

test("identical idempotency replay returns original result without a duplicate write", async () => {
  const provider = new SyntheticSettingsProvider();
  const input = request();
  const first = await provider.updateAtomically(input);
  const replay = await provider.updateAtomically(input);
  const state = provider.getState();
  assert.deepEqual(replay, first);
  assert.equal(state.calls.update, 2);
  assert.equal(state.calls.mutation, 1);
  assert.equal(state.value, "Asia/Dhaka");
  assert.deepEqual(state.idempotencyKeys, ["idempotency-1"]);
});

test("idempotency key reuse with another payload rejects without replacing its record", async () => {
  const provider = new SyntheticSettingsProvider();
  const original = request();
  const first = await provider.updateAtomically(original);
  const conflicting = await provider.updateAtomically({
    ...original,
    proposedValue: "Europe/London",
  });
  const replay = await provider.updateAtomically(original);
  const state = provider.getState();
  assert.equal(first.outcome, "APPLIED");
  assert.deepEqual(conflicting, {
    outcome: "REJECTED",
    reasonCode: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
  });
  assert.deepEqual(replay, first);
  assert.equal(state.value, "Asia/Dhaka");
  assert.equal(state.calls.mutation, 1);
  assert.deepEqual(state.idempotencyKeys, ["idempotency-1"]);
});

test("timeout after successful write remains unknown until key reconciliation", async () => {
  const provider = new SyntheticSettingsProvider({
    timeoutAfterApply: "reconcile_committed",
  });
  const input = request();
  const result = await provider.updateAtomically(input);
  const state = provider.getState();
  assert.equal(result.outcome, "UNKNOWN");
  assert.equal(result.mayHaveApplied, true);
  assert.equal(state.value, "Asia/Dhaka");
  assert.equal(state.calls.mutation, 1);
  assert.equal(state.calls.reconcile, 0);
  const reconciliation = await provider.reconcileTimeout(target, input.idempotencyKey);
  assert.equal(reconciliation.outcome, "COMMITTED");
  assert.equal(provider.getState().calls.update, 1);
});

test("reconciliation preserves NOT_COMMITTED, PENDING, and UNKNOWN without blind retry", async () => {
  const notCommitted = new SyntheticSettingsProvider({
    timeoutBeforeApply: "reconcile_not_committed",
  });
  const notCommittedRequest = request();
  const notCommittedOutcome = await notCommitted.updateAtomically(notCommittedRequest);
  assert.equal(notCommittedOutcome.outcome, "UNKNOWN");
  assert.deepEqual(
    await notCommitted.reconcileTimeout(target, notCommittedRequest.idempotencyKey),
    { outcome: "NOT_COMMITTED" },
  );
  assert.deepEqual(await notCommitted.updateAtomically(notCommittedRequest), notCommittedOutcome);
  assert.equal(notCommitted.getState().calls.mutation, 0);

  const pending = new SyntheticSettingsProvider({
    timeoutBeforeApply: "reconcile_pending",
  });
  const pendingRequest = request();
  const pendingOutcome = await pending.updateAtomically(pendingRequest);
  assert.equal(pendingOutcome.outcome, "UNKNOWN");
  assert.deepEqual(
    await pending.reconcileTimeout(target, pendingRequest.idempotencyKey),
    { outcome: "PENDING" },
  );
  assert.deepEqual(await pending.updateAtomically(pendingRequest), pendingOutcome);
  assert.equal(pending.getState().calls.mutation, 0);

  const unknown = new SyntheticSettingsProvider({ timeoutAfterApply: "unresolved" });
  const unknownRequest = request();
  const unknownOutcome = await unknown.updateAtomically(unknownRequest);
  assert.equal(unknownOutcome.outcome, "UNKNOWN");
  assert.deepEqual(
    await unknown.reconcileTimeout(target, unknownRequest.idempotencyKey),
    { outcome: "UNKNOWN" },
  );
  assert.equal(unknown.getState().calls.mutation, 1);
});

test("unresolved timeout remains unknown despite a readable new value", async () => {
  const provider = new SyntheticSettingsProvider({ timeoutAfterApply: "unresolved" });
  const input = request();
  const result = await provider.updateAtomically(input);
  const readBack = await provider.readSetting(target);
  const reconciliation = await provider.reconcileTimeout(target, input.idempotencyKey);
  const state = provider.getState();
  assert.equal(result.outcome, "UNKNOWN");
  assert.equal(readBack.value, "Asia/Dhaka");
  assert.equal(reconciliation.outcome, "UNKNOWN");
  assert.equal(state.calls.mutation, 1);
  assert.equal(state.calls.update, 1);
});

test("site identity mismatch is rejected without changing setting", async () => {
  const provider = new SyntheticSettingsProvider();
  const result = await provider.updateAtomically(request({
    target: { ...target, siteId: "other-site" },
  }));
  const state = provider.getState();
  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.reasonCode, "SITE_OR_SETTING_IDENTITY_MISMATCH");
  assert.equal(state.value, "UTC");
  assert.equal(state.calls.mutation, 0);
});

test("missing provider permission rejects without changing setting", async () => {
  const provider = new SyntheticSettingsProvider({ permissions: [] });
  const result = await provider.updateAtomically(request());
  const state = provider.getState();
  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.reasonCode, "REQUIRED_PERMISSION_MISSING");
  assert.equal(state.value, "UTC");
  assert.equal(state.calls.mutation, 0);
});

test("independent read-back mismatch is explicit and not verified", async () => {
  const provider = new SyntheticSettingsProvider();
  const result = await provider.updateAtomically(request());
  assert.equal(result.outcome, "APPLIED");
  provider.setFixtureValue("Europe/London");
  const verification = await provider.verifyIndependently(target, "Asia/Dhaka");
  assert.equal(verification.value, "Europe/London");
  assert.equal(verification.matchesProposedValue, false);
  assert.equal(provider.getState().calls.mutation, 1);
});

test("unavailable provider cannot resolve or mutate a site", async () => {
  const provider = new SyntheticSettingsProvider({ providerAvailable: false });
  assert.equal(await provider.resolveAuthorizedSite(target.siteId), null);
  const result = await provider.updateAtomically(request());
  const state = provider.getState();
  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.reasonCode, "PROVIDER_UNAVAILABLE");
  assert.equal(state.value, "UTC");
  assert.equal(state.calls.mutation, 0);
});

test("eligibility blocks provider absence, unsupported, unknown, and partial evidence", async () => {
  const provider = new SyntheticSettingsProvider();
  const input = request();
  const approval = await authorize(input);
  const context = await eligibilityContext(
    provider,
    input,
    approval.authorization,
    approval.guard,
  );

  const unavailable = evaluateSettingsProviderEligibility(null, {
    ...context,
    providerAvailable: false,
  });
  assert.equal(unavailable.eligibleForSyntheticConformance, false);
  assert.ok(unavailable.reasons.includes("PROVIDER_UNAVAILABLE"));

  for (const feature of SETTINGS_PROVIDER_FEATURES) {
    for (const status of ["UNSUPPORTED", "UNKNOWN", "PARTIALLY_VERIFIED"] as const) {
      const declaration = withFeatureStatus(provider, feature, status);
      const eligibility = evaluateSettingsProviderEligibility(declaration, context);
      assert.equal(eligibility.eligibleForSyntheticConformance, false);
      assert.ok(eligibility.reasons.some((reason) =>
        reason.includes(`CAPABILITY_${feature}_${status}`)));
    }
  }
});

test("real provider cannot qualify from synthetic fixture evidence", async () => {
  const provider = new SyntheticSettingsProvider();
  const input = request();
  const approval = await authorize(input);
  const context = await eligibilityContext(
    provider,
    input,
    approval.authorization,
    approval.guard,
  );
  const realDeclaration = {
    ...provider.declaration,
    providerKind: "real" as const,
  };
  const eligibility = evaluateSettingsProviderEligibility(realDeclaration, context);
  assert.equal(eligibility.eligibleForExecution, false);
  assert.equal(eligibility.eligibleForSyntheticConformance, false);
  assert.ok(eligibility.reasons.some((reason) =>
    reason.includes("EVIDENCE_MISSING_OR_OUT_OF_SCOPE")));
  assert.ok(eligibility.reasons.some((reason) =>
    reason.includes("SYNTHETIC_EVIDENCE_NOT_VALID_FOR_PRODUCTION")));
});

test("missing required version token and unknown precondition both block", async () => {
  const provider = new SyntheticSettingsProvider();
  const input = request({ precondition: { kind: "expected_value" } });
  const approval = await authorize(input);
  const context = await eligibilityContext(
    provider,
    input,
    approval.authorization,
    approval.guard,
  );
  const eligibility = evaluateSettingsProviderEligibility(provider.declaration, context);
  assert.equal(eligibility.eligibleForSyntheticConformance, false);
  assert.ok(eligibility.reasons.includes("EXPECTED_VERSION_REQUIRED"));

  const unknownDeclaration = {
    ...provider.declaration,
    preconditionMode: { kind: "unknown" as const },
  };
  const unknown = evaluateSettingsProviderEligibility(unknownDeclaration, context);
  assert.ok(unknown.reasons.includes("ATOMIC_PRECONDITION_UNVERIFIED"));
  assert.equal(provider.getState().calls.mutation, 0);
});

test("site, permission, and exact approval mismatches block eligibility", async () => {
  const provider = new SyntheticSettingsProvider();
  const input = request();
  const approval = await authorize(input);
  const context = await eligibilityContext(
    provider,
    input,
    approval.authorization,
    approval.guard,
  );
  const noPermission = evaluateSettingsProviderEligibility(provider.declaration, {
    ...context,
    requiredPermissions: ["different.permission"],
  });
  assert.ok(noPermission.reasons.includes("REQUIRED_PERMISSION_MISSING"));

  const wrongSite = evaluateSettingsProviderEligibility(provider.declaration, {
    ...context,
    site: { ...context.site!, siteId: "other-site" },
  });
  assert.ok(wrongSite.reasons.includes("SITE_IDENTITY_MISMATCH"));

  const wrongApproval = evaluateSettingsProviderEligibility(provider.declaration, {
    ...context,
    approval: {
      ...approval.authorization,
      proposal: {
        ...approval.authorization.proposal,
        websiteId: "other-site",
      },
    },
  });
  assert.ok(wrongApproval.reasons.includes("EXACT_APPROVAL_NOT_VERIFIED"));
  assert.equal(provider.getState().calls.mutation, 0);
});

test("eligibility rejects arbitrary matching fingerprints and invalidated approval", async () => {
  const provider = new SyntheticSettingsProvider();
  const forgedInput = request({ proposalFingerprint: "arbitrary-matching-fingerprint" });
  const forgedApproval = await authorize(forgedInput);
  const forgedContext = await eligibilityContext(
    provider,
    forgedInput,
    forgedApproval.authorization,
    forgedApproval.guard,
  );
  const forged = evaluateSettingsProviderEligibility(provider.declaration, forgedContext);
  assert.equal(forged.eligibleForSyntheticConformance, false);
  assert.ok(forged.reasons.includes("EXACT_APPROVAL_NOT_VERIFIED"));

  const input = request();
  const approval = await authorize(input);
  approval.guard.revoke(approval.authorization.receipt);
  const invalidatedContext = await eligibilityContext(
    provider,
    input,
    approval.authorization,
    approval.guard,
  );
  const invalidated = evaluateSettingsProviderEligibility(
    provider.declaration,
    invalidatedContext,
  );
  assert.equal(invalidated.eligibleForSyntheticConformance, false);
  assert.ok(invalidated.reasons.includes("EXACT_APPROVAL_NOT_VERIFIED"));
});

test("eligibility rejects an expired approval receipt", async () => {
  const provider = new SyntheticSettingsProvider();
  const input = request();
  let now = new Date("2025-01-01T00:00:00.000Z");
  const guard = new MutationApprovalGuard(
    { async requestApproval() { return true; } },
    1_000,
    () => now,
  );
  const authorization = await guard.requestApproval(proposalInput(input));
  const context = await eligibilityContext(
    provider,
    input,
    authorization,
    guard,
  );
  assert.equal(
    evaluateSettingsProviderEligibility(provider.declaration, context)
      .eligibleForSyntheticConformance,
    true,
  );
  now = new Date(now.getTime() + 1_000);
  const expired = evaluateSettingsProviderEligibility(provider.declaration, context);
  assert.equal(expired.eligibleForSyntheticConformance, false);
  assert.ok(expired.reasons.includes("EXACT_APPROVAL_NOT_VERIFIED"));
});

test("eligibility rejects evidence scoped to another feature, CMS, or adapter", async () => {
  const provider = new SyntheticSettingsProvider();
  const input = request();
  const approval = await authorize(input);
  const context = await eligibilityContext(
    provider,
    input,
    approval.authorization,
    approval.guard,
  );
  const original = provider.declaration.features.ATOMIC_COMPARE_AND_SET;
  for (const evidence of [
    { ...original.evidence[0]!, feature: "WRITE_SETTING" as const },
    { ...original.evidence[0]!, cms: "wordpress" as const },
    { ...original.evidence[0]!, adapterId: "another-adapter" },
  ]) {
    const declaration = {
      ...provider.declaration,
      features: {
        ...provider.declaration.features,
        ATOMIC_COMPARE_AND_SET: { ...original, evidence: [evidence] },
      },
    };
    const result = evaluateSettingsProviderEligibility(declaration, context);
    assert.equal(result.eligibleForSyntheticConformance, false);
    assert.ok(result.reasons.includes(
      "CAPABILITY_ATOMIC_COMPARE_AND_SET_EVIDENCE_MISSING_OR_OUT_OF_SCOPE",
    ));
  }
});

test("trusted official API documentation validates with provenance and scoped authority", () => {
  const provider = new SyntheticSettingsProvider();
  const feature: SettingsProviderFeature = "READ_SETTING";
  const record = officialEvidence(feature);
  const result = validateProviderCapabilityEvidence(
    realDeclarationWithEvidence(provider, feature, [record]),
    feature,
    { status: "VERIFIED", evidence: [record] },
    trustedEvidencePolicy,
    new Date("2025-02-01T00:00:00.000Z"),
  );
  assert.equal(result.trustStatus, "VERIFIED");
  assert.equal(result.acceptedForExecution, true);
  assert.equal(result.acceptedForSyntheticConformance, false);

  const documentedCas = officialEvidence("ATOMIC_COMPARE_AND_SET");
  const casResult = validateProviderCapabilityEvidence(
    realDeclarationWithEvidence(provider, "ATOMIC_COMPARE_AND_SET", [documentedCas]),
    "ATOMIC_COMPARE_AND_SET",
    { status: "VERIFIED", evidence: [documentedCas] },
    trustedEvidencePolicy,
    new Date("2025-02-01T00:00:00.000Z"),
  );
  assert.equal(casResult.trustStatus, "VERIFIED");
  assert.equal(casResult.acceptedForExecution, true);
});

test("missing references, unsupported source types, and untrusted publishers are rejected", () => {
  const provider = new SyntheticSettingsProvider();
  const feature: SettingsProviderFeature = "READ_SETTING";
  const base = officialEvidence(feature);
  const candidates = [
    { record: { ...base, reference: "" }, reason: "EVIDENCE_ID_OR_SOURCE_REFERENCE_MISSING" },
    {
      record: { ...base, type: "UNSUPPORTED_SOURCE" as never },
      reason: "EVIDENCE_SOURCE_TYPE_UNSUPPORTED",
    },
    {
      record: { ...base, publisherAuthority: "attacker.example.test" },
      reason: "EVIDENCE_PUBLISHER_UNTRUSTED",
    },
    {
      record: { ...base, publisherAuthority: "", reference: "not a URL" },
      reason: "EVIDENCE_PROVENANCE_OR_SCOPE_INCOMPLETE",
    },
  ];
  for (const candidate of candidates) {
    const result = validateProviderCapabilityEvidence(
      realDeclarationWithEvidence(provider, feature, [candidate.record]),
      feature,
      { status: "VERIFIED", evidence: [candidate.record] },
      trustedEvidencePolicy,
      new Date("2025-02-01T00:00:00.000Z"),
    );
    assert.equal(result.acceptedForExecution, false);
    assert.ok(result.reasons.includes(candidate.reason));
  }
});

test("review authority and age policy are enforced explicitly", () => {
  const provider = new SyntheticSettingsProvider();
  const feature: SettingsProviderFeature = "READ_SETTING";
  const missingReviewer = officialEvidence(feature, { reviewerAuthority: null });
  const missingReviewerResult = validateProviderCapabilityEvidence(
    realDeclarationWithEvidence(provider, feature, [missingReviewer]),
    feature,
    { status: "VERIFIED", evidence: [missingReviewer] },
    trustedEvidencePolicy,
  );
  assert.equal(missingReviewerResult.trustStatus, "UNVERIFIED");
  assert.ok(missingReviewerResult.reasons.includes(
    "EVIDENCE_REVIEWER_AUTHORITY_UNTRUSTED_OR_MISSING",
  ));

  const staleRecord = officialEvidence(feature, {
    reviewedAt: "2024-01-01T00:00:00.000Z",
  });
  const staleResult = validateProviderCapabilityEvidence(
    realDeclarationWithEvidence(provider, feature, [staleRecord]),
    feature,
    { status: "VERIFIED", evidence: [staleRecord] },
    { ...trustedEvidencePolicy, maxEvidenceAgeMs: 1_000 },
    new Date("2025-02-01T00:00:00.000Z"),
  );
  assert.equal(staleResult.trustStatus, "EXPIRED");
  assert.ok(staleResult.reasons.includes("EVIDENCE_STALE_BY_POLICY"));
});

test("expired, revoked, superseded, and explicitly conflicted evidence fail closed", () => {
  const provider = new SyntheticSettingsProvider();
  const feature: SettingsProviderFeature = "READ_SETTING";
  const records = [
    { record: officialEvidence(feature, { validity: "EXPIRED" }), status: "EXPIRED" },
    { record: officialEvidence(feature, { validity: "REVOKED" }), status: "REVOKED" },
    { record: officialEvidence(feature, { validity: "SUPERSEDED" }), status: "REVOKED" },
    {
      record: officialEvidence(feature, {
        validity: "CONFLICTED",
        conflictsWith: ["other-evidence"],
      }),
      status: "CONFLICTED",
    },
    {
      record: officialEvidence(feature, { validUntil: "2025-01-31T00:00:00.000Z" }),
      status: "EXPIRED",
    },
  ] as const;
  for (const candidate of records) {
    const result = validateProviderCapabilityEvidence(
      realDeclarationWithEvidence(provider, feature, [candidate.record]),
      feature,
      { status: "VERIFIED", evidence: [candidate.record] },
      trustedEvidencePolicy,
      new Date("2025-02-01T00:00:00.000Z"),
    );
    assert.equal(result.trustStatus, candidate.status);
    assert.equal(result.acceptedForExecution, false);
  }
});

test("duplicate evidence identifiers across feature declarations are conflicted", () => {
  const provider = new SyntheticSettingsProvider();
  const feature: SettingsProviderFeature = "READ_SETTING";
  const duplicate = officialEvidence(feature);
  const declaration = {
    ...realDeclarationWithEvidence(provider, feature, [duplicate]),
    features: {
      ...realDeclarationWithEvidence(provider, feature, [duplicate]).features,
      WRITE_SETTING: {
        status: "VERIFIED" as const,
        evidence: [duplicate],
      },
    },
  };
  const result = validateProviderCapabilityEvidence(
    declaration,
    feature,
    { status: "VERIFIED", evidence: [duplicate] },
    trustedEvidencePolicy,
  );
  assert.equal(result.trustStatus, "CONFLICTED");
  assert.ok(result.reasons.includes("EVIDENCE_IDENTIFIER_DUPLICATE"));
});

test("read-only and wrong-operation evidence cannot support a write capability", () => {
  const provider = new SyntheticSettingsProvider();
  const feature: SettingsProviderFeature = "WRITE_SETTING";
  const readonlyEvidence = officialEvidence(feature, {
    operations: ["read"],
    claim: "DOCUMENTED_CAPABILITY",
  });
  const readonlyResult = validateProviderCapabilityEvidence(
    realDeclarationWithEvidence(provider, feature, [readonlyEvidence]),
    feature,
    { status: "VERIFIED", evidence: [readonlyEvidence] },
    trustedEvidencePolicy,
  );
  assert.equal(readonlyResult.acceptedForExecution, false);
  assert.ok(readonlyResult.reasons.includes("EVIDENCE_OPERATION_SCOPE_MISMATCH"));
  assert.ok(readonlyResult.reasons.includes("EVIDENCE_DOES_NOT_ESTABLISH_RUNTIME_BEHAVIOR"));

  const otherOperation = officialEvidence(feature, {
    operations: ["create"],
  });
  const operationResult = validateProviderCapabilityEvidence(
    realDeclarationWithEvidence(provider, feature, [otherOperation]),
    feature,
    { status: "VERIFIED", evidence: [otherOperation] },
    trustedEvidencePolicy,
  );
  assert.ok(operationResult.reasons.includes("EVIDENCE_OPERATION_SCOPE_MISMATCH"));
});

test("provider statements cannot establish independently tested CAS", () => {
  const provider = new SyntheticSettingsProvider();
  const feature: SettingsProviderFeature = "ATOMIC_COMPARE_AND_SET";
  for (const claim of ["PROVIDER_ASSERTION", "DOCUMENTED_GUARANTEE"] as const) {
    const statement = officialEvidence(feature, {
      type: "OFFICIAL_PROVIDER_STATEMENT",
      reference: "https://vendor.example.test/claims/cas",
      publisherAuthority: "vendor.example.test",
      claim,
    });
    const result = validateProviderCapabilityEvidence(
      realDeclarationWithEvidence(provider, feature, [statement]),
      feature,
      { status: "VERIFIED", evidence: [statement] },
      trustedEvidencePolicy,
    );
    assert.equal(result.trustStatus, "REJECTED");
    assert.equal(result.acceptedForExecution, false);
    assert.ok(result.reasons.includes(
      "PROVIDER_STATEMENT_CANNOT_PROVE_RUNTIME_BEHAVIOR",
    ));
  }
});

test("CMS, adapter, feature, and operation scope mismatches are rejected", () => {
  const provider = new SyntheticSettingsProvider();
  const feature: SettingsProviderFeature = "READ_SETTING";
  const correct = officialEvidence(feature);
  const candidates = [
    { ...correct, cms: "wordpress" as const },
    { ...correct, adapterId: "different-adapter" },
    { ...correct, feature: "WRITE_SETTING" as const },
    { ...correct, operations: ["update"] as const },
    { ...correct, scope: "" },
    { ...correct, operations: [] as const },
  ];
  for (const candidate of candidates) {
    const result = validateProviderCapabilityEvidence(
      realDeclarationWithEvidence(provider, feature, [candidate]),
      feature,
      { status: "VERIFIED", evidence: [candidate] },
      trustedEvidencePolicy,
    );
    assert.equal(result.acceptedForExecution, false);
    assert.ok(
      result.reasons.includes("EVIDENCE_SCOPE_MISMATCH") ||
      result.reasons.includes("EVIDENCE_OPERATION_SCOPE_MISMATCH") ||
      result.reasons.includes("EVIDENCE_PROVENANCE_OR_SCOPE_INCOMPLETE"),
    );
  }
});

test("synthetic evidence is limited to synthetic conformance and never production", () => {
  const provider = new SyntheticSettingsProvider();
  const feature: SettingsProviderFeature = "ATOMIC_COMPARE_AND_SET";
  const fixtureEvidence = provider.declaration.features[feature];
  const syntheticResult = validateProviderCapabilityEvidence(
    provider.declaration,
    feature,
    fixtureEvidence,
    trustedEvidencePolicy,
  );
  assert.equal(syntheticResult.trustStatus, "VERIFIED_WITH_LIMITATIONS");
  assert.equal(syntheticResult.acceptedForExecution, false);
  assert.equal(syntheticResult.acceptedForSyntheticConformance, true);

  const realDeclaration = {
    ...provider.declaration,
    providerKind: "real" as const,
  };
  const productionResult = validateProviderCapabilityEvidence(
    realDeclaration,
    feature,
    fixtureEvidence,
    trustedEvidencePolicy,
  );
  assert.equal(productionResult.acceptedForExecution, false);
  assert.equal(productionResult.acceptedForSyntheticConformance, false);
});

test("all evidence trust classifications are explicit and fail closed as appropriate", () => {
  const provider = new SyntheticSettingsProvider();
  const feature: SettingsProviderFeature = "READ_SETTING";
  const active = officialEvidence(feature);
  const cases = [
    {
      record: active,
      expected: "VERIFIED",
      accepted: true,
    },
    {
      record: officialEvidence(feature, {
        limitations: ["Only documented API shape; no runtime test."],
      }),
      expected: "VERIFIED_WITH_LIMITATIONS",
      accepted: false,
    },
    {
      record: officialEvidence(feature, { type: "UNVERIFIED_REFERENCE" }),
      expected: "UNVERIFIED",
      accepted: false,
    },
    {
      record: officialEvidence(feature, { reviewStatus: "PENDING" }),
      expected: "UNVERIFIED",
      accepted: false,
    },
    {
      record: officialEvidence(feature, { reviewStatus: "REJECTED" }),
      expected: "REJECTED",
      accepted: false,
    },
    {
      record: officialEvidence(feature, { validity: "EXPIRED" }),
      expected: "EXPIRED",
      accepted: false,
    },
    {
      record: officialEvidence(feature, { validity: "REVOKED" }),
      expected: "REVOKED",
      accepted: false,
    },
    {
      record: officialEvidence(feature, { validity: "CONFLICTED" }),
      expected: "CONFLICTED",
      accepted: false,
    },
  ] as const;
  for (const candidate of cases) {
    const result = validateProviderCapabilityEvidence(
      realDeclarationWithEvidence(provider, feature, [candidate.record]),
      feature,
      { status: "VERIFIED", evidence: [candidate.record] },
      trustedEvidencePolicy,
    );
    assert.equal(result.trustStatus, candidate.expected);
    assert.equal(result.acceptedForExecution, candidate.accepted);
  }
});

test("incomplete provider declarations fail closed", async () => {
  const provider = new SyntheticSettingsProvider();
  const input = request();
  const approval = await authorize(input);
  const context = await eligibilityContext(
    provider,
    input,
    approval.authorization,
    approval.guard,
  );
  const incomplete = {
    ...provider.declaration,
    preconditionMode: null as never,
  };
  const result = evaluateSettingsProviderEligibility(incomplete, context);
  assert.equal(result.eligibleForExecution, false);
  assert.equal(result.eligibleForSyntheticConformance, false);
  assert.ok(result.reasons.includes("PROVIDER_DECLARATION_INCOMPLETE"));
});

test("unverified site and missing feature evidence both block", async () => {
  const provider = new SyntheticSettingsProvider();
  const input = request();
  const approval = await authorize(input);
  const context = await eligibilityContext(
    provider,
    input,
    approval.authorization,
    approval.guard,
  );
  const unverifiedSite = evaluateSettingsProviderEligibility(provider.declaration, {
    ...context,
    site: { ...context.site!, verified: false },
  });
  assert.ok(unverifiedSite.reasons.includes("SITE_IDENTITY_NOT_VERIFIED"));

  const missingEvidence = {
    ...provider.declaration,
    features: {
      ...provider.declaration.features,
      INDEPENDENT_READBACK: {
        status: "VERIFIED" as const,
        evidence: [],
      },
    },
  };
  const noEvidence = evaluateSettingsProviderEligibility(missingEvidence, context);
  assert.ok(noEvidence.reasons.includes(
    "CAPABILITY_INDEPENDENT_READBACK_EVIDENCE_MISSING_OR_OUT_OF_SCOPE",
  ));
});

test("approval binds every operation field and receipt remains one-use", async () => {
  const input = request();
  const base = proposalInput(input);
  const mismatches = [
    { provider: "wordpress" },
    { websiteId: "other-site" },
    { targetResource: "setting:website:other-setting" },
    { action: "content.publish" },
    { payload: { ...base.payload, expectedValue: "Europe/London" } },
    { payload: { ...base.payload, precondition: { kind: "version_token", version: "2" } } },
    { payload: { ...base.payload, proposedValue: "Europe/London" } },
    { payload: { ...base.payload, executionId: "execution-2" } },
    { payload: { ...base.payload, idempotencyKey: "idempotency-2" } },
    { payload: { ...base.payload, proposalFingerprint: "different-fingerprint" } },
    { payload: { ...base.payload, operationScope: "content.publish" } },
    { scope: "content.publish" as const },
  ];

  for (const mismatch of mismatches) {
    const approval = new MutationApprovalGuard({
      async requestApproval() {
        return true;
      },
    });
    const authorization = await approval.requestApproval(base);
    await assert.rejects(approval.runAuthorized(
      authorization.proposal,
      authorization.receipt,
      async () => approval.assertAuthorized({
        scope: "settings.update",
        provider: input.target.cms,
        websiteId: input.target.siteId,
        action: "settings.update",
        targetResource: `setting:${input.target.categoryId}:${input.target.settingId}`,
        payload: base.payload,
        ...mismatch,
      }),
    ), { reason: "scope_mismatch" });
    await assert.rejects(approval.runAuthorized(
      authorization.proposal,
      authorization.receipt,
      async () => {},
    ), { reason: "replayed" });
  }
});

test("valid exact approval is required before synthetic atomic update", async () => {
  const provider = new SyntheticSettingsProvider();
  const input = request();
  const approval = new MutationApprovalGuard({
    async requestApproval() {
      return true;
    },
  });
  const authorization = await approval.requestApproval(proposalInput(input));
  const result = await approval.runAuthorized(
    authorization.proposal,
    authorization.receipt,
    async () => {
      approval.assertAuthorized({
        scope: "settings.update",
        provider: input.target.cms,
        websiteId: input.target.siteId,
        action: "settings.update",
        targetResource: `setting:${input.target.categoryId}:${input.target.settingId}`,
        payload: authorization.proposal.payload,
      });
      return provider.updateAtomically(input);
    },
  );
  assert.equal(result.outcome, "APPLIED");
  assert.equal(provider.getState().value, "Asia/Dhaka");
  assert.equal(provider.getState().calls.mutation, 1);
});

test("approval scope and exact payload are required for updates", async () => {
  const input = request();
  const approval = new MutationApprovalGuard({
    async requestApproval() {
      return true;
    },
  });
  const authorization = await approval.requestApproval(proposalInput(input));
  await assert.rejects(approval.runAuthorized(
    authorization.proposal,
    authorization.receipt,
    async () => {
      approval.assertAuthorized({
        scope: "settings.update",
        provider: input.target.cms,
        websiteId: input.target.siteId,
        action: "settings.update",
        targetResource: `setting:${input.target.categoryId}:${input.target.settingId}`,
        payload: {
          ...proposalInput(input).payload,
          expectedValue: "Europe/London",
        },
      });
    },
  ), { reason: "scope_mismatch" });
});

test("approval receipt expires before any provider update", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const provider = new SyntheticSettingsProvider();
  const input = request();
  const approval = new MutationApprovalGuard({
    async requestApproval() {
      return true;
    },
  }, 100, () => now);
  const authorization = await approval.requestApproval(proposalInput(input));
  now = new Date(now.getTime() + 101);
  let updateCalls = 0;
  await assert.rejects(approval.runAuthorized(
    authorization.proposal,
    authorization.receipt,
    async () => {
      updateCalls += 1;
      return provider.updateAtomically(input);
    },
  ), { reason: "expired" });
  assert.equal(updateCalls, 0);
  assert.equal(provider.getState().value, "UTC");
  assert.equal(provider.getState().calls.mutation, 0);
});

test("synthetic adapter is not a production CMS provider", async () => {
  const provider = new SyntheticSettingsProvider();
  const realDeclaration = {
    ...provider.declaration,
    providerKind: "real" as const,
    features: Object.fromEntries(
      Object.entries(provider.declaration.features).map(([feature, evidence]) => [
        feature,
        { ...evidence, status: "UNKNOWN" as const },
      ]),
    ) as typeof provider.declaration.features,
  };
  const input = request();
  const context = await eligibilityContext(provider, input, null, null);
  const eligibility = evaluateSettingsProviderEligibility(realDeclaration, context);
  assert.equal(provider.declaration.providerKind, "synthetic");
  assert.equal(eligibility.eligibleForExecution, false);
  assert.equal(eligibility.eligibleForSyntheticConformance, false);
});

test("production remains isolated from synthetic settings mutation", () => {
  const productionEntry = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
  const executionTools = readFileSync(
    new URL("../../tools/settings-execution-tools.ts", import.meta.url),
    "utf8",
  );
  const planner = readFileSync(
    new URL("../../planning/settings-change-planner.ts", import.meta.url),
    "utf8",
  );
  assert.match(productionEntry, /providers:\s*new Map\(\)/);
  assert.doesNotMatch(productionEntry, /SyntheticSettingsProvider/);
  assert.match(executionTools, /"get_settings_execution_status"/);
  assert.doesNotMatch(executionTools, /"execute_approved_settings_change"/);
  assert.match(planner, /executionEnabled:\s*false/);
});
