import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_STATUSES,
  type CapabilityOperation,
  type CapabilityPermissionRequirement,
  type CapabilityStatus,
  type ExecutionMechanism,
  type HumanApprovalRequirement,
} from "./capability-types.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { squarespaceCapabilityBindings } from "./providers/squarespace.js";
import {
  capabilityIdentityKey,
  normalizeCapabilities as normalizeDeclarationSet,
  validateAdapterCapabilityDeclarationSet,
  type EffectiveCapabilityView,
} from "./adapter-capability-normalizer.js";
import {
  type AdapterCapabilityDeclaration,
  type AdapterCapabilityDescriptor,
  type CapabilityVerificationEvidence,
} from "../adapters/adapter-capability.js";

const now = new Date("2026-01-15T12:00:00.000Z");
const registryPermissions = ["pages.write"];
const verifiedContext = {
  grantedPermissions: [...registryPermissions, "pages.extra"],
  humanApprovalGranted: true,
  policyAuthorized: true,
  verificationCompleted: true,
};
const trustedPolicy = {
  trustedPublishers: { live_provider_test: ["evidence.example"] },
  trustedReviewerAuthorities: ["reviewer.example"],
  maxEvidenceAgeMs: 365 * 24 * 60 * 60 * 1000,
};

function evidence(
  overrides: Partial<CapabilityVerificationEvidence> = {},
): CapabilityVerificationEvidence {
  return {
    evidenceId: "evidence-1",
    sourceType: "live_provider_test",
    claim: "independently_tested",
    cms: "squarespace",
    adapterId: "fixture-adapter",
    capabilityId: "website.pages",
    operationId: "create",
    contractVersion: "1.0.0",
    reference: "https://evidence.example/reports/pages-create",
    publisherAuthority: "evidence.example",
    scope: "adapter_operation",
    siteIdentityHash: null,
    retrievedAt: "2026-01-10T12:00:00.000Z",
    reviewedAt: "2026-01-12T12:00:00.000Z",
    reviewerAuthority: "reviewer.example",
    reviewStatus: "approved",
    validity: "active",
    validUntil: "2027-01-12T12:00:00.000Z",
    limitations: [],
    ...overrides,
  };
}

function descriptor(
  overrides: Partial<AdapterCapabilityDescriptor> = {},
): AdapterCapabilityDescriptor {
  const capabilityId = overrides.capabilityId ?? "website.pages";
  const operationId = overrides.operationId ?? "create";
  return {
    capabilityId,
    operationId,
    support: "supported",
    access: "write",
    executionMechanism: "browser_automation",
    verification: "independently_verified",
    approvalRequirement: "required",
    permissionRequirement: { kind: "required", permissions: registryPermissions },
    evidence: [evidence({ capabilityId, operationId })],
    ...overrides,
  };
}

function declaration(
  descriptors: readonly AdapterCapabilityDescriptor[] = [descriptor()],
  overrides: Partial<AdapterCapabilityDeclaration> = {},
): readonly AdapterCapabilityDeclaration[] {
  return [{
    cms: "squarespace",
    adapterId: "fixture-adapter",
    contractVersion: "1.0.0",
    descriptors,
    ...overrides,
  }];
}

function registryWith(options: {
  readonly aggregateStatus?: CapabilityStatus;
  readonly operationId?: CapabilityOperation;
  readonly operationStatus?: CapabilityStatus;
  readonly allOperationStatus?: CapabilityStatus;
  readonly mechanism?: ExecutionMechanism;
  readonly permissions?: readonly string[];
  readonly permissionRequirement?: CapabilityPermissionRequirement | null;
  readonly approval?: HumanApprovalRequirement;
} = {}): CapabilityRegistry {
  const capabilityId = "website.pages";
  const operationId = options.operationId ?? "create";
  const current = squarespaceCapabilityBindings.find((binding) =>
    binding.capabilityId === capabilityId);
  assert.ok(current);

  const permissions = options.permissions ?? registryPermissions;
  const operations = { ...current.operations };
  if (options.allOperationStatus !== undefined) {
    for (const operation of Object.keys(operations) as CapabilityOperation[]) {
      const operationBinding = operations[operation];
      if (operationBinding) operations[operation] = {
        ...operationBinding,
        status: options.allOperationStatus,
      };
    }
  }
  const permissionMetadata = options.permissionRequirement === null
    ? {}
    : {
        permissionRequirement: options.permissionRequirement ?? {
          kind: "required" as const,
          permissions,
        },
      };
  const binding = {
    ...current,
    status: options.aggregateStatus ?? "PARTIALLY_IMPLEMENTED",
    operations: {
      ...operations,
      [operationId]: {
        ...current.operations[operationId],
        status: options.operationStatus ?? "IMPLEMENTED_AND_TESTED",
        toolNames: ["fixture_page_operation"],
        mechanism: options.mechanism ?? "browser_ui",
        permissions: [...permissions],
        ...permissionMetadata,
        humanApproval: options.approval ?? "required",
        verificationRequirements: ["fixture read-back"],
        recoveryStrategy: "manual_recovery",
      },
    },
  };
  return new CapabilityRegistry([
    ...squarespaceCapabilityBindings.filter((item) => item.capabilityId !== capabilityId),
    binding,
  ]);
}

function options(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    now,
    evidencePolicy: trustedPolicy,
    eligibilityContext: verifiedContext,
    ...overrides,
  };
}

function normalizeCapabilities(
  registry: CapabilityRegistry,
  cms: "squarespace" | "wordpress" | "wix",
  declarations?: unknown,
  _ignoredCallerAuthority?: unknown,
): ReturnType<typeof normalizeDeclarationSet> {
  return normalizeDeclarationSet(registry, cms, declarations);
}

function viewFor(
  result: ReturnType<typeof normalizeCapabilities>,
  capabilityId = "website.pages",
  operationId: CapabilityOperation = "create",
): EffectiveCapabilityView {
  const view = result.views.find((candidate) =>
    candidate.identity.capabilityId === capabilityId &&
    candidate.identity.operationId === operationId);
  assert.ok(view, `missing view for ${capabilityId}.${operationId}`);
  return view;
}

test("every registry operation status is reconciled against every descriptor support value", () => {
  const supportValues = ["supported", "unsupported", "not_verified"] as const;
  for (const operationStatus of CAPABILITY_STATUSES) {
    for (const support of supportValues) {
      const result = normalizeCapabilities(
        registryWith({ operationStatus }),
        "squarespace",
        declaration([descriptor({ support })]),
        options(),
      );
      const view = viewFor(result);
      assert.equal(view.operationStatus, operationStatus);
      assert.equal(view.descriptorSupport, support);
      assert.equal(
        view.adapterRouteEligible,
        false,
        `${operationStatus} / ${support}`,
      );
    }
  }
});

test("PARTIALLY_IMPLEMENTED aggregate with mixed implemented/unimplemented operations stays ineligible for adapter route", () => {
  // A partially implemented aggregate with both implemented and not implemented ops must remain ineligible.

  const result = normalizeCapabilities(
    registryWith({ aggregateStatus: "PARTIALLY_IMPLEMENTED", operationStatus: "IMPLEMENTED_AND_TESTED" }),
    "squarespace",
    declaration(),
    options(),
  );
  const view = viewFor(result);

  assert.equal(view.aggregateStatus, "PARTIALLY_IMPLEMENTED");
  assert.equal(view.operationStatus, "IMPLEMENTED_AND_TESTED");
  assert.equal(view.adapterRouteEligible, false);
  assert.ok(view.reasonCodes.includes("trusted_verifier_not_integrated"));
  assert.equal(result.conflicts.some((conflict) =>
    conflict.code === "registry_aggregate_operation_mismatch"), false);
});

test("contradictory non-partial aggregate and operation statuses fail closed", () => {
  const result = normalizeCapabilities(
    registryWith({ aggregateStatus: "NOT_IMPLEMENTED", operationStatus: "IMPLEMENTED_AND_TESTED" }),
    "squarespace",
    declaration(),
    options(),
  );
  assert.equal(viewFor(result).adapterRouteEligible, false);
  assert.ok(result.conflicts.some((conflict) =>
    conflict.code === "registry_aggregate_operation_mismatch"));
});

test("PARTIALLY_IMPLEMENTED aggregate with no implemented operations is inconsistent and ineligible", () => {
  // A partially implemented aggregate with all NOT_IMPLEMENTED ops must be flagged as inconsistent/ineligible.

  const result = normalizeCapabilities(
    registryWith({
      aggregateStatus: "PARTIALLY_IMPLEMENTED",
      operationStatus: "NOT_IMPLEMENTED",
      allOperationStatus: "NOT_IMPLEMENTED",
    }),
    "squarespace",
    declaration([descriptor({ support: "unsupported", verification: "not_verified", evidence: [] })]),
    options(),
  );
  assert.equal(viewFor(result).adapterRouteEligible, false);
  assert.ok(result.conflicts.some((conflict) =>
    conflict.code === "registry_aggregate_operation_mismatch"));
});

test("missing descriptor preserves registry status but is not adapter-route eligible", () => {
  const result = normalizeCapabilities(
    registryWith(),
    "squarespace",
    undefined,
    options(),
  );
  const view = viewFor(result);

  assert.equal(view.descriptorPresent, false);
  assert.equal(view.adapterRouteEligible, false);
  assert.ok(view.reasonCodes.includes("descriptor_missing"));
});

test("missing explicit registry binding remains unknown even with a supported descriptor", () => {
  const result = normalizeCapabilities(
    new CapabilityRegistry([]),
    "squarespace",
    declaration(),
    options(),
  );
  const view = viewFor(result);

  assert.equal(view.registryBindingPresent, false);
  assert.equal(view.operationStatus, "UNKNOWN_NEEDS_INVESTIGATION");
  assert.equal(view.adapterRouteEligible, false);
  assert.ok(result.validationErrors.some((error) => error.code === "registry_binding_missing"));
  assert.ok(result.conflicts.some((conflict) => conflict.code === "registry_binding_missing"));
});

test("WordPress and Wix remain unknown and non-executable despite positive declarations", () => {
  const base = descriptor();
  for (const cms of ["wordpress", "wix"] as const) {
    const cmsDeclaration = declaration([base], { cms });
    const result = normalizeCapabilities(
      new CapabilityRegistry([]),
      cms,
      cmsDeclaration,
      options(),
    );
    const view = viewFor(result);
    assert.equal(view.operationStatus, "UNKNOWN_NEEDS_INVESTIGATION");
    assert.equal(view.adapterRouteEligible, false);
    assert.ok(result.conflicts.some((conflict) => conflict.code === "descriptor_support_mismatch"));
  }
});

test("all access values are checked against read and mutation operations", () => {
  const accesses: readonly AdapterCapabilityDescriptor["access"][] = [
    "none", "read_only", "write", "read_write",
  ];
  for (const access of accesses) {
    const createResult = normalizeCapabilities(
      registryWith(), "squarespace", declaration([descriptor({ access })]), options(),
    );
    assert.equal(viewFor(createResult).adapterRouteEligible, false, `create access=${access}`);

    const readResult = normalizeCapabilities(
      registryWith({
        operationId: "read",
        permissions: ["pages.read"],
        permissionRequirement: { kind: "required", permissions: ["pages.read"] },
        approval: "never",
      }),
      "squarespace",
      declaration([descriptor({
        operationId: "read",
        access,
        approvalRequirement: "none",
        permissionRequirement: { kind: "required", permissions: ["pages.read"] },
      })]),
      options({ eligibilityContext: {
        grantedPermissions: ["pages.read"],
        verificationCompleted: true,
      } }),
    );
    assert.equal(viewFor(readResult, "website.pages", "read").adapterRouteEligible,
      false, `read access=${access}`);
  }
});

test("all descriptor mechanisms preserve API, browser, hybrid, none, and unknown distinctions", () => {
  const cases: Array<{
    readonly descriptorMechanism: AdapterCapabilityDescriptor["executionMechanism"];
    readonly registryMechanism: ExecutionMechanism;
  }> = [
    { descriptorMechanism: "none", registryMechanism: "unknown" },
    { descriptorMechanism: "official_api", registryMechanism: "official_api" },
    { descriptorMechanism: "browser_automation", registryMechanism: "browser_ui" },
    { descriptorMechanism: "hybrid", registryMechanism: "hybrid" },
    { descriptorMechanism: "custom_code", registryMechanism: "custom_code" },
    { descriptorMechanism: "manual", registryMechanism: "manual" },
    { descriptorMechanism: "unknown", registryMechanism: "unknown" },
  ];
  for (const scenario of cases) {
    const result = normalizeCapabilities(
      registryWith({ mechanism: scenario.registryMechanism }),
      "squarespace",
      declaration([descriptor({ executionMechanism: scenario.descriptorMechanism })]),
      options(),
    );
    assert.equal(viewFor(result).registryMechanism, scenario.registryMechanism);
    assert.equal(viewFor(result).descriptorMechanism, scenario.descriptorMechanism);
    assert.equal(viewFor(result).adapterRouteEligible, false, scenario.descriptorMechanism);
  }
});

test("mechanism mismatches are reported and never imply permission", () => {
  const result = normalizeCapabilities(
    registryWith({ mechanism: "official_api" }),
    "squarespace",
    declaration([descriptor({ executionMechanism: "browser_automation" })]),
    options({ eligibilityContext: {
      grantedPermissions: ["pages.write"],
      humanApprovalGranted: true,
      verificationCompleted: true,
    } }),
  );
  assert.equal(viewFor(result).adapterRouteEligible, false);
  assert.ok(result.conflicts.some((conflict) => conflict.code === "descriptor_mechanism_mismatch"));
});

test("missing permission metadata differs from explicitly permissionless", () => {
  const missing = normalizeCapabilities(
    registryWith({ permissions: [], permissionRequirement: null }),
    "squarespace",
    declaration([descriptor({ permissionRequirement: { kind: "permissionless" } })]),
    options({ eligibilityContext: { humanApprovalGranted: true, verificationCompleted: true } }),
  );
  assert.equal(viewFor(missing).permissionRequirement.kind, "unknown");
  assert.equal(viewFor(missing).adapterRouteEligible, false);

  const explicit = normalizeCapabilities(
    registryWith({ permissions: [], permissionRequirement: { kind: "permissionless" } }),
    "squarespace",
    declaration([descriptor({ permissionRequirement: { kind: "permissionless" } })]),
    options({ eligibilityContext: { humanApprovalGranted: true, verificationCompleted: true } }),
  );
  assert.equal(viewFor(explicit).permissionRequirement.kind, "permissionless");
  assert.equal(viewFor(explicit).adapterRouteEligible, false);
  assert.equal(viewFor(explicit).permissionRequirement.kind, "permissionless");
});

test("permission requirements cannot be weakened and stricter scopes are retained", () => {
  const weakened = normalizeCapabilities(
    registryWith(),
    "squarespace",
    declaration([descriptor({ permissionRequirement: { kind: "permissionless" } })]),
    options(),
  );
  assert.equal(viewFor(weakened).adapterRouteEligible, false);
  assert.ok(weakened.conflicts.some((conflict) => conflict.code === "descriptor_permission_mismatch"));
  assert.equal(viewFor(weakened).permissionRequirement.kind, "required");

  const stricter = normalizeCapabilities(
    registryWith(),
    "squarespace",
    declaration([descriptor({
      permissionRequirement: { kind: "required", permissions: ["pages.write", "pages.extra"] },
    })]),
    options(),
  );
  assert.equal(viewFor(stricter).adapterRouteEligible, false);
  assert.deepEqual(viewFor(stricter).requiredPermissions, ["pages.extra", "pages.write"]);
});

test("all approval values preserve or strengthen registry requirements", () => {
  const cases: Array<{
    registry: HumanApprovalRequirement;
    descriptor: AdapterCapabilityDescriptor["approvalRequirement"];
  }> = [
    { registry: "never", descriptor: "none" },
    { registry: "never", descriptor: "required" },
    { registry: "never", descriptor: "policy_based" },
    { registry: "required", descriptor: "none" },
    { registry: "required", descriptor: "required" },
    { registry: "required", descriptor: "policy_based" },
    { registry: "policy_based", descriptor: "none" },
    { registry: "policy_based", descriptor: "policy_based" },
    { registry: "policy_based", descriptor: "required" },
    { registry: "unavailable", descriptor: "required" },
  ];
  for (const scenario of cases) {
    const result = normalizeCapabilities(
      registryWith({ approval: scenario.registry }),
      "squarespace",
      declaration([descriptor({ approvalRequirement: scenario.descriptor })]),
      options({ humanApprovalGranted: true, policyAuthorized: true }),
    );
    assert.equal(viewFor(result).adapterRouteEligible, false,
      `${scenario.registry} / ${scenario.descriptor}`);
  }
});

test("approval-none cannot clear registry approval and no boolean substitutes for a receipt", () => {
  const result = normalizeCapabilities(
    registryWith({ approval: "required" }),
    "squarespace",
    declaration([descriptor({ approvalRequirement: "none" })]),
  );
  assert.equal(viewFor(result).approvalRequirement, "required");
  assert.equal(viewFor(result).adapterRouteEligible, false);
  assert.ok(result.conflicts.some((conflict) =>
    conflict.code === "descriptor_approval_weakens_registry"));
  assert.ok(viewFor(result).reasonCodes.includes("trusted_approval_receipt_not_integrated"));
});

test("independent verification requires trusted evidence scoped to the exact operation and version", () => {
  const noEvidence = normalizeCapabilities(
    registryWith(), "squarespace", declaration([descriptor({ evidence: [] })]), options(),
  );
  assert.equal(viewFor(noEvidence).verification, "not_verified");
  assert.equal(viewFor(noEvidence).adapterRouteEligible, false);

  const invalidScope = normalizeCapabilities(
    registryWith(), "squarespace",
    declaration([descriptor({ evidence: [evidence({ operationId: "read" })] })]),
    options(),
  );
  assert.equal(viewFor(invalidScope).adapterRouteEligible, false);
  assert.ok(invalidScope.validationErrors.some((error) => error.code === "evidence_scope_mismatch"));

  const callerClaimedTrusted = normalizeCapabilities(
    registryWith(), "squarespace", declaration(), options({
      evidencePolicy: trustedPolicy,
      eligibilityContext: verifiedContext,
    }),
  );
  assert.equal(viewFor(callerClaimedTrusted).verification, "not_verified");
  assert.equal(viewFor(callerClaimedTrusted).adapterRouteEligible, false);
  assert.ok(callerClaimedTrusted.validationErrors.some((error) =>
    error.code === "trusted_verifier_not_integrated"));
});

test("Regression: adapterRouteEligible is never granted by caller-provided trust policy, values, or extra arguments", () => {
  // Callers cannot force eligibility by supplying trust/evidence/context/time/site/hash/vars, nor override registry restrictions.
  const forgedCallerInputs = {
    evidencePolicy: trustedPolicy,
    eligibilityContext: {
      grantedPermissions: ["pages.write"],
      humanApprovalGranted: true,
      policyAuthorized: true,
      verificationCompleted: true,
    },
    now: new Date("2099-01-01T00:00:00.000Z"),
    siteIdentityHash: "a".repeat(64),
    extra: "not_allowed"
  };
  const result = Reflect.apply(normalizeDeclarationSet, undefined, [
    registryWith(), "squarespace", declaration(), forgedCallerInputs,
  ]) as ReturnType<typeof normalizeDeclarationSet>;
  const view = viewFor(result);
  assert.equal(view.adapterRouteEligible, false);
  assert.ok(view.reasonCodes.includes("trusted_verifier_not_integrated"));
  assert.ok(view.reasonCodes.includes("trusted_permission_provider_not_integrated"));
  assert.ok(view.reasonCodes.includes("trusted_approval_receipt_not_integrated"));
});
test("caller-provided trust policy, grants, approvals, verification, time, and site hash cannot authorize", () => {
  const forgedCallerInputs = {
    evidencePolicy: trustedPolicy,
    eligibilityContext: {
      grantedPermissions: ["pages.write"],
      humanApprovalGranted: true,
      policyAuthorized: true,
      verificationCompleted: true,
    },
    now: new Date("2099-01-01T00:00:00.000Z"),
    siteIdentityHash: "a".repeat(64),
  };
  const result = Reflect.apply(normalizeDeclarationSet, undefined, [
    registryWith(), "squarespace", declaration(), forgedCallerInputs,
  ]) as ReturnType<typeof normalizeDeclarationSet>;
  const view = viewFor(result);

  assert.equal(view.verification, "not_verified");
  assert.equal(view.adapterRouteEligible, false);
  assert.ok(view.reasonCodes.includes("trusted_verifier_not_integrated"));
  assert.ok(view.reasonCodes.includes("trusted_permission_provider_not_integrated"));
  assert.ok(view.reasonCodes.includes("trusted_approval_receipt_not_integrated"));
  assert.equal(normalizeDeclarationSet.length, 3);
});

test("Unapproved live, superseded, and conflicted evidence never establish independent verification", () => {
  // All these evidence types must not allow independent verification or adapter route.
  const states = [
    evidence({ reviewStatus: "pending", validity: "pending", reviewedAt: null }), // unapproved
    evidence({ validity: "superseded" }),
    evidence({ validity: "conflict" }),
  ];
  for (const ev of states) {
    const result = normalizeCapabilities(
      registryWith(),
      "squarespace",
      declaration([descriptor({ verification: "independently_verified", evidence: [ev] })]),
      options(),
    );
    const view = viewFor(result);
    assert.notEqual(view.verification, "independently_verified");
    assert.equal(view.adapterRouteEligible, false);
  }
});

test("synthetic evidence is explicitly labeled and never establishes live verification", () => {
  const syntheticEvidence = evidence({
    sourceType: "synthetic_test",
    claim: "synthetic_only",
    reviewStatus: "pending",
    reviewerAuthority: null,
    reviewedAt: null,
  });
  const result = normalizeCapabilities(
    registryWith(),
    "squarespace",
    declaration([descriptor({ verification: "synthetic_only", evidence: [syntheticEvidence] })]),
    options(),
  );
  assert.equal(viewFor(result).verification, "synthetic_only");
  assert.equal(viewFor(result).adapterRouteEligible, false);
});

test("provider-site evidence is rejected without a trusted site identity verifier", () => {
  const siteEvidence = evidence({
    scope: "provider_site",
    siteIdentityHash: "a".repeat(64),
  });
  const noSite = normalizeCapabilities(
    registryWith(), "squarespace",
    declaration([descriptor({ evidence: [siteEvidence] })]),
    options(),
  );
  assert.equal(viewFor(noSite).adapterRouteEligible, false);
  assert.ok(noSite.validationErrors.some((error) => error.code === "evidence_scope_mismatch"));

  const callerSuppliedHash = normalizeCapabilities(
    registryWith(), "squarespace",
    declaration([descriptor({ evidence: [siteEvidence] })]),
    options({ siteIdentityHash: "a".repeat(64) }),
  );
  assert.equal(viewFor(callerSuppliedHash).verification, "not_verified");
  assert.equal(viewFor(callerSuppliedHash).adapterRouteEligible, false);
});

test("stale, future, mismatched-authority, and wrong-claim evidence fail closed", () => {
  const badRecords = [
    evidence({ reviewedAt: "2024-01-01T00:00:00.000Z" }),
    evidence({ retrievedAt: "2026-01-16T00:00:00.000Z" }),
    evidence({ publisherAuthority: "other.example" }),
    evidence({ sourceType: "official_documentation", claim: "documented_capability" }),
  ];
  for (const item of badRecords) {
    const result = normalizeCapabilities(
      registryWith(), "squarespace",
      declaration([descriptor({ evidence: [item] })]),
      options(),
    );
    assert.equal(viewFor(result).adapterRouteEligible, false);
    assert.notEqual(viewFor(result).verification, "independently_verified");
  }
});

test("mismatched evidence source and claim is a validation error", () => {
  const result = normalizeCapabilities(
    registryWith(), "squarespace",
    declaration([descriptor({ evidence: [evidence({
      sourceType: "official_documentation",
      claim: "independently_tested",
    })] })]),
    options(),
  );
  assert.ok(result.validationErrors.some((error) => error.code === "evidence_claim_mismatch"));
  assert.equal(viewFor(result).adapterRouteEligible, false);
});

test("evidence from another contract version is rejected", () => {
  const result = normalizeCapabilities(
    registryWith(), "squarespace",
    declaration([descriptor({ evidence: [evidence({ contractVersion: "0.9.0" })] })]),
  );
  assert.equal(viewFor(result).adapterRouteEligible, false);
  assert.ok(result.validationErrors.some((error) => error.code === "evidence_scope_mismatch"));
});

test("documentation can never establish independent verification", () => {
  const documentation = evidence({
    sourceType: "official_documentation",
    claim: "documented_capability",
    publisherAuthority: "docs.example",
    reference: "https://docs.example/api/pages",
    reviewStatus: "pending",
    reviewerAuthority: null,
    reviewedAt: null,
  });
  const result = normalizeCapabilities(
    registryWith(), "squarespace",
    declaration([descriptor({ evidence: [documentation] })]),
    options({ evidencePolicy: trustedPolicy, verificationCompleted: true }),
  );
  assert.equal(viewFor(result).verification, "not_verified");
  assert.equal(viewFor(result).adapterRouteEligible, false);
  assert.ok(result.validationErrors.some((error) =>
    error.code === "trusted_verifier_not_integrated"));
});

test("duplicate evidence IDs cannot establish independent verification", () => {
  const shared = evidence();
  const result = normalizeCapabilities(
    registryWith(), "squarespace",
    declaration([
      descriptor({ evidence: [shared] }),
      descriptor({ capabilityId: "editor.sections", evidence: [shared] }),
    ]),
    options(),
  );
  assert.ok(result.validationErrors.some((error) => error.code === "duplicate_evidence_id"));
  assert.equal(viewFor(result).adapterRouteEligible, false);
});

test("invalid and duplicate identities are rejected without echoing untrusted values", () => {
  const duplicate = descriptor();
  const duplicateResult = normalizeCapabilities(
    registryWith(), "squarespace", declaration([duplicate, duplicate]), options(),
  );
  assert.ok(duplicateResult.validationErrors.some((error) => error.code === "duplicate_identity"));
  assert.equal(viewFor(duplicateResult).descriptorPresent, false);

  const unknownCapability = normalizeCapabilities(
    registryWith(), "squarespace",
    declaration([descriptor({ capabilityId: "api_key=credential-value" })]),
    options(),
  );
  assert.ok(unknownCapability.validationErrors.some((error) => error.code === "unknown_capability"));
  assert.doesNotMatch(JSON.stringify(unknownCapability), /credential-value/);

  const invalidOperation = normalizeCapabilities(
    registryWith(), "squarespace",
    declaration([descriptor({ operationId: "publish" as CapabilityOperation })]),
    options(),
  );
  assert.ok(invalidOperation.validationErrors.some((error) => error.code === "invalid_declaration_set"));
  assert.doesNotMatch(JSON.stringify(invalidOperation), /publish/);
});

test("stable keys encode each identity component without delimiter collisions", () => {
  assert.equal(
    capabilityIdentityKey({ cms: "squarespace", capabilityId: "website.pages", operationId: "read" }),
    JSON.stringify(["squarespace", "website.pages", "read"]),
  );
  assert.notEqual(
    capabilityIdentityKey({ cms: "squarespace", capabilityId: "website.pages", operationId: "read" }),
    capabilityIdentityKey({ cms: "squarespace", capabilityId: "editor.sections", operationId: "read" }),
  );
  assert.throws(() => capabilityIdentityKey({
    cms: "squarespace",
    capabilityId: "website.pages",
    operationId: "publish" as CapabilityOperation,
  }), /Invalid capability identity/);
});

test("recovery is preserved from the registry and executable does not authorize or invoke", () => {
  const result = normalizeCapabilities(registryWith(), "squarespace", declaration(), options());
  const view = viewFor(result);
  assert.equal(view.recoveryStrategy, "manual_recovery");
  assert.equal(view.adapterRouteEligible, false);
  assert.equal(typeof view.adapterRouteEligible, "boolean");
});

test("PARTIALLY_IMPLEMENTED aggregate with all CRUD implemented does not promote to IMPLEMENTED_AND_TESTED", () => {
  // All CRUD ops implemented but aggregate remains PARTIALLY_IMPLEMENTED due to registry constraint; must stay ineligible for adapter route.
  const result = normalizeCapabilities(
    registryWith({ aggregateStatus: "PARTIALLY_IMPLEMENTED", allOperationStatus: "IMPLEMENTED_AND_TESTED" }),
    "squarespace",
    declaration([descriptor({ support: "supported" })]),
    options(),
  );
  const view = viewFor(result);
  assert.equal(view.aggregateStatus, "PARTIALLY_IMPLEMENTED");
  assert.equal(view.adapterRouteEligible, false);
  assert.ok(view.reasonCodes.includes("trusted_verifier_not_integrated"));
});

test("every aggregate registry status is reconciled against every descriptor support value", () => {
  const supportValues = ["supported", "unsupported", "not_verified"] as const;
  for (const aggregateStatus of CAPABILITY_STATUSES) {
    for (const support of supportValues) {
      const operationStatus = aggregateStatus === "PARTIALLY_IMPLEMENTED"
        ? "IMPLEMENTED_AND_TESTED"
        : aggregateStatus;
      const result = normalizeCapabilities(
        registryWith({
          aggregateStatus,
          operationStatus,
          ...(aggregateStatus === "PARTIALLY_IMPLEMENTED"
            ? {}
            : { allOperationStatus: aggregateStatus }),
        }),
        "squarespace",
        declaration([descriptor({ support })]),
        options(),
      );
      const view = viewFor(result);
      assert.equal(view.aggregateStatus, aggregateStatus);
      assert.equal(view.descriptorSupport, support);
      assert.equal(
        view.adapterRouteEligible,
        false,
        `${aggregateStatus} / ${support}`,
      );
    }
  }
});

test("expired, revoked, and missing-expiry evidence are explicitly rejected", () => {
  const cases = [
    { evidence: evidence({ validUntil: "2000-01-01T00:00:00.000Z" }), code: "evidence_expired" },
    { evidence: evidence({ validity: "expired" }), code: "evidence_expired" },
    { evidence: evidence({ validity: "revoked" }), code: "evidence_revoked" },
    { evidence: evidence({ validUntil: null }), code: "evidence_expiry_missing" },
  ] as const;
  for (const scenario of cases) {
    const result = normalizeCapabilities(
      registryWith(), "squarespace",
      declaration([descriptor({ evidence: [scenario.evidence] })]),
    );
    assert.equal(viewFor(result).adapterRouteEligible, false);
    assert.ok(result.validationErrors.some((error) => error.code === scenario.code));
  }
});

test("declaration-set validation rejects duplicate adapter IDs and operation ownership", () => {
  const sameAdapter = validateAdapterCapabilityDeclarationSet(registryWith(), [
    ...declaration(),
    ...declaration([descriptor({ operationId: "read" })]),
  ]);
  assert.equal(sameAdapter.declarations.length, 0);
  assert.ok(sameAdapter.conflicts.some((conflict) =>
    conflict.code === "duplicate_adapter_identity"));

  const competingAdapters = validateAdapterCapabilityDeclarationSet(registryWith(), [
    ...declaration(),
    ...declaration([descriptor()], { adapterId: "second-adapter" }),
  ]);
  assert.equal(competingAdapters.declarations.length, 0);
  assert.ok(competingAdapters.conflicts.some((conflict) =>
    conflict.code === "duplicate_descriptor_identity"));
});

test("declaration-set validation rejects unknown CMS, capability, and operation identities", () => {
  const unknownCapability = validateAdapterCapabilityDeclarationSet(registryWith(),
    declaration([descriptor({ capabilityId: "unknown.capability" })]));
  assert.equal(unknownCapability.declarations.length, 0);
  assert.ok(unknownCapability.validationErrors.some((error) => error.code === "unknown_capability"));

  const unknownOperation = validateAdapterCapabilityDeclarationSet(registryWith(),
    declaration([descriptor({ operationId: "publish" as CapabilityOperation })]));
  assert.equal(unknownOperation.declarations.length, 0);
  assert.ok(unknownOperation.validationErrors.some((error) => error.code === "invalid_declaration_set"));

  const unknownCms = validateAdapterCapabilityDeclarationSet(registryWith(), [
    ...declaration([], { cms: "drupal" as "squarespace" }),
  ]);
  assert.equal(unknownCms.declarations.length, 0);
  assert.ok(unknownCms.validationErrors.some((error) => error.code === "invalid_declaration_set"));
});

// --- END PHASE 2B-A TESTS ---
test("declaration-set conflicts are deterministic regardless of declaration order", () => {
  const first = declaration();
  const second = declaration([descriptor()], { adapterId: "second-adapter" });
  const forward = validateAdapterCapabilityDeclarationSet(registryWith(), [first[0]!, second[0]!]);
  const reverse = validateAdapterCapabilityDeclarationSet(registryWith(), [second[0]!, first[0]!]);
  assert.deepEqual(forward.conflicts, reverse.conflicts);
  assert.deepEqual(
    forward.conflicts.map((conflict) => conflict.code),
    ["duplicate_descriptor_identity"],
  );
});