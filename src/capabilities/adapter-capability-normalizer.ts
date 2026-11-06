import {
  CAPABILITY_OPERATIONS,
  CMS_IDS,
  type CapabilityOperation,
  type CapabilityOperationBinding,
  type CapabilityPermissionRequirement,
  type CapabilityStatus,
  type CmsId,
  type ExecutionMechanism,
  type HumanApprovalRequirement,
  type RecoveryStrategy,
} from "./capability-types.js";
import { CapabilityRegistry } from "./capability-registry.js";
import {
  adapterCapabilityDeclarationSetSchema,
  type AdapterCapabilityDeclaration,
  type AdapterCapabilityDeclarationSet,
  type AdapterCapabilityDescriptor,
  type CapabilityVerificationEvidence,
} from "../adapters/adapter-capability.js";

export interface CapabilityIdentity {
  readonly cms: CmsId;
  readonly capabilityId: string;
  readonly operationId: CapabilityOperation;
}

export type CapabilityConflictCode =
  | "registry_aggregate_operation_mismatch"
  | "registry_permission_metadata_mismatch"
  | "registry_binding_missing"
  | "duplicate_descriptor_identity"
  | "duplicate_adapter_identity"
  | "descriptor_support_mismatch"
  | "descriptor_mechanism_mismatch"
  | "descriptor_permission_mismatch"
  | "descriptor_approval_weakens_registry";

export interface CapabilityConflict {
  readonly code: CapabilityConflictCode;
  readonly identity: CapabilityIdentity | {
    readonly cms: CmsId;
    readonly capabilityId: string;
    readonly operationId: null;
  };
}

export type CapabilityValidationErrorCode =
  | "invalid_cms"
  | "invalid_declaration"
  | "invalid_declaration_set"
  | "declaration_cms_mismatch"
  | "unknown_capability"
  | "undefined_operation"
  | "duplicate_identity"
  | "duplicate_evidence_id"
  | "registry_binding_missing"
  | "evidence_scope_mismatch"
  | "evidence_claim_mismatch"
  | "evidence_expired"
  | "evidence_expiry_missing"
  | "evidence_invalidated"
  | "evidence_revoked"
  | "evidence_superseded"
  | "evidence_conflicted"
  | "evidence_unapproved"
  | "trusted_verifier_not_integrated";

export interface CapabilityValidationError {
  readonly code: CapabilityValidationErrorCode;
  readonly declarationIndex?: number;
  readonly evidenceIndex?: number;
}

export type EffectiveVerification =
  | "independently_verified"
  | "synthetic_only"
  | "not_verified";

export type EffectiveApprovalRequirement =
  | "none"
  | "required"
  | "policy_based"
  | "required_and_policy_based"
  | "unavailable";

export interface EffectiveCapabilityView {
  readonly identity: CapabilityIdentity;
  readonly identityKey: string;
  readonly aggregateStatus: CapabilityStatus;
  readonly operationStatus: CapabilityStatus;
  readonly registryBindingPresent: boolean;
  readonly descriptorPresent: boolean;
  readonly descriptorSupport: AdapterCapabilityDescriptor["support"] | null;
  readonly access: AdapterCapabilityDescriptor["access"] | null;
  readonly registryMechanism: ExecutionMechanism;
  readonly descriptorMechanism: AdapterCapabilityDescriptor["executionMechanism"] | null;
  readonly permissionRequirement: CapabilityPermissionRequirement;
  readonly requiredPermissions: readonly string[];
  readonly approvalRequirement: EffectiveApprovalRequirement;
  readonly verification: EffectiveVerification;
  readonly verificationScope: "adapter_operation" | "provider_site" | null;
  readonly verificationSiteIdentityHash: string | null;
  readonly recoveryStrategy: RecoveryStrategy;
  readonly adapterRouteEligible: boolean;
  readonly reasonCodes: readonly string[];
}

export interface CapabilityNormalizationResult {
  readonly views: readonly EffectiveCapabilityView[];
  readonly conflicts: readonly CapabilityConflict[];
  readonly validationErrors: readonly CapabilityValidationError[];
}

export interface CapabilityDeclarationSetValidationResult {
  readonly declarations: AdapterCapabilityDeclarationSet;
  readonly conflicts: readonly CapabilityConflict[];
  readonly validationErrors: readonly CapabilityValidationError[];
}

const VALID_CMS_IDS: readonly string[] = CMS_IDS;

export function validateAdapterCapabilityDeclarationSet(
  registry: CapabilityRegistry,
  rawDeclarationSet: unknown,
): CapabilityDeclarationSetValidationResult {
  const parsed = adapterCapabilityDeclarationSetSchema.safeParse(rawDeclarationSet);
  if (!parsed.success) {
    return {
      declarations: [],
      conflicts: [],
      validationErrors: [{ code: "invalid_declaration_set" }],
    };
  }

  const conflicts: CapabilityConflict[] = [];
  const validationErrors: CapabilityValidationError[] = [];
  const adapterIds = new Map<string, number>();
  const operationIds = new Map<string, number>();

  for (const [declarationIndex, declaration] of parsed.data.entries()) {
    const adapterKey = JSON.stringify([declaration.cms, declaration.adapterId]);
    if (adapterIds.has(adapterKey)) {
      conflicts.push({
        code: "duplicate_adapter_identity",
        identity: { cms: declaration.cms, capabilityId: "*", operationId: null },
      });
      validationErrors.push({ code: "duplicate_identity", declarationIndex });
    } else {
      adapterIds.set(adapterKey, declarationIndex);
    }

    for (const descriptor of declaration.descriptors) {
      if (!registry.getCapability(declaration.cms, descriptor.capabilityId)) {
        validationErrors.push({ code: "unknown_capability", declarationIndex });
        continue;
      }
      if (!registry.isOperationDefined(descriptor.capabilityId, descriptor.operationId)) {
        validationErrors.push({ code: "undefined_operation", declarationIndex });
        continue;
      }
      const identity: CapabilityIdentity = {
        cms: declaration.cms,
        capabilityId: descriptor.capabilityId,
        operationId: descriptor.operationId,
      };
      const key = capabilityIdentityKey(identity);
      if (operationIds.has(key)) {
        conflicts.push({ code: "duplicate_descriptor_identity", identity });
        validationErrors.push({ code: "duplicate_identity", declarationIndex });
      } else {
        operationIds.set(key, declarationIndex);
      }
    }
  }

  const uniqueConflicts = dedupeConflicts(conflicts);
  const uniqueErrors = dedupeValidationErrors(validationErrors);
  return {
    declarations: uniqueConflicts.length === 0 && uniqueErrors.length === 0
      ? parsed.data
      : [],
    conflicts: uniqueConflicts,
    validationErrors: uniqueErrors,
  };
}

/**
 * Pure, fail-closed reconciliation. No caller-supplied policy, grant, approval,
 * clock, or verification context is accepted. Adapter routing remains ineligible
 * until trusted verifier, permission-provider, and approval boundaries exist.
 */
export function normalizeCapabilities(
  registry: CapabilityRegistry,
  cms: CmsId,
  rawDeclarationSet?: unknown,
): CapabilityNormalizationResult {
  const validationErrors: CapabilityValidationError[] = [];
  const conflicts: CapabilityConflict[] = [];
  const now = new Date();

  if (!VALID_CMS_IDS.includes(cms)) {
    validationErrors.push({ code: "invalid_cms" });
    return emptyResult(conflicts, validationErrors);
  }

  const declarationSetResult = rawDeclarationSet === undefined
    ? { declarations: [], conflicts: [], validationErrors: [] }
    : validateAdapterCapabilityDeclarationSet(registry, rawDeclarationSet);
  validationErrors.push(...declarationSetResult.validationErrors);
  conflicts.push(...declarationSetResult.conflicts);
  const declarations = declarationSetResult.declarations.filter((declaration) => declaration.cms === cms);

  const descriptors = new Map<string, {
    readonly declaration: AdapterCapabilityDeclaration;
    readonly descriptor: AdapterCapabilityDescriptor;
  }>();
  const evidenceCounts = new Map<string, number>();
  const duplicateEvidenceIds = new Set<string>();
  for (const declaration of declarations) {
    for (const descriptor of declaration.descriptors) {
      const key = capabilityIdentityKey({
        cms,
        capabilityId: descriptor.capabilityId,
        operationId: descriptor.operationId,
      });
      descriptors.set(key, { declaration, descriptor });
      for (const evidence of descriptor.evidence) {
        const count = (evidenceCounts.get(evidence.evidenceId) ?? 0) + 1;
        evidenceCounts.set(evidence.evidenceId, count);
        if (count > 1) {
          duplicateEvidenceIds.add(evidence.evidenceId);
          validationErrors.push({ code: "duplicate_evidence_id" });
        }
      }
    }
  }

  const validEvidence = new Map<string, {
    readonly independent: readonly string[];
    readonly synthetic: readonly string[];
    readonly scope: "adapter_operation" | "provider_site" | null;
  }>();
  if (declarations.length > 0) {
    for (const { declaration, descriptor } of descriptors.values()) {
      const identity: CapabilityIdentity = {
        cms,
        capabilityId: descriptor.capabilityId,
        operationId: descriptor.operationId,
      };
      const accepted = validateEvidenceForDescriptor(
        declaration,
        descriptor,
        identity,
        now,
        duplicateEvidenceIds,
        validationErrors,
      );
      validEvidence.set(capabilityIdentityKey(identity), accepted);
    }
  }

  const views: EffectiveCapabilityView[] = [];
  for (const capability of registry.getCapabilitiesForCms(cms)) {
    const definitionOperations = CAPABILITY_OPERATIONS.filter((operation) =>
      registry.isOperationDefined(capability.id, operation));
    const aggregateConflict = findAggregateConflict(
      capability.status,
      definitionOperations,
      capability.operations,
    );
    if (aggregateConflict) {
      conflicts.push({
        code: "registry_aggregate_operation_mismatch",
        identity: { cms, capabilityId: capability.id, operationId: null },
      });
    }

    for (const operationId of definitionOperations) {
      const identity: CapabilityIdentity = { cms, capabilityId: capability.id, operationId };
      const key = capabilityIdentityKey(identity);
      const binding = capability.operations[operationId];
      const registryBindingPresent = registry.hasExplicitBinding(cms, capability.id);
      const descriptorEntry = descriptors.get(key);
      const descriptor = descriptorEntry?.descriptor;
      const reasons = new Set<string>();
      if (!registryBindingPresent) {
        validationErrors.push({ code: "registry_binding_missing" });
        conflicts.push({ code: "registry_binding_missing", identity });
        reasons.add("registry_binding_missing");
      }
      if (aggregateConflict) reasons.add("aggregate_operation_conflict");

      const operationStatus = binding?.status ?? "UNKNOWN_NEEDS_INVESTIGATION";
      if (!binding) reasons.add("operation_binding_missing");
      const registryPermission = resolveRegistryPermission(binding, conflicts, identity);

      if (!descriptor) {
        reasons.add("descriptor_missing");
        views.push(makeView({
          identity,
          identityKey: key,
          aggregateStatus: capability.status,
          operationStatus,
          registryBindingPresent,
          descriptor: null,
          registryMechanism: binding?.mechanism ?? "unknown",
          permissionRequirement: registryPermission.requirement,
          requiredPermissions: registryPermission.permissions,
          approvalRequirement: normalizeRegistryApproval(binding?.humanApproval ?? "unavailable"),
          verification: "not_verified",
          verificationScope: null,
          verificationSiteIdentityHash: null,
          recoveryStrategy: binding?.recoveryStrategy ?? "none",
          adapterRouteEligible: false,
          reasons,
        }));
        continue;
      }

      const descriptorConflict = reconcileDescriptor(
        descriptor,
        binding,
        operationStatus,
        identity,
        registryPermission,
        validEvidence.get(key) ?? { independent: [], synthetic: [], scope: null },
        conflicts,
      );
      for (const reason of descriptorConflict.reasons) reasons.add(reason);
      const evidenceForDescriptor = validEvidence.get(key) ?? { independent: [], synthetic: [], scope: null };
      const verification: EffectiveVerification =
        descriptor.verification === "synthetic_only" && evidenceForDescriptor.synthetic.length > 0
          ? "synthetic_only"
          : "not_verified";

      const permissionRequirement = descriptorConflict.permissionRequirement;
      const requiredPermissions = descriptorConflict.requiredPermissions;
      const staticRouteChecksPass = registryBindingPresent && binding !== undefined &&
        !aggregateConflict && operationStatus === "IMPLEMENTED_AND_TESTED" &&
        descriptor.support === "supported" &&
        descriptorConflict.accessCompatible &&
        descriptorConflict.mechanismCompatible &&
        descriptorConflict.permissionCompatible &&
        descriptorConflict.permissionSatisfied &&
        permissionRequirement.kind !== "unknown" &&
        descriptor.executionMechanism !== "none" &&
        descriptor.executionMechanism !== "unknown" &&
        descriptor.executionMechanism !== "manual" &&
        descriptor.executionMechanism !== "custom_code" &&
        descriptorConflict.approvalCompatible;
      const adapterRouteEligible = false;
      if (!staticRouteChecksPass) reasons.add("static_adapter_route_checks_failed");
      if (descriptor.verification === "independently_verified") {
        reasons.add("trusted_verifier_not_integrated");
      }
      if (permissionRequirement.kind === "required") {
        reasons.add("trusted_permission_provider_not_integrated");
      }
      if (descriptorConflict.approvalRequirement !== "none") {
        reasons.add("trusted_approval_receipt_not_integrated");
      }
      reasons.add("adapter_route_not_authorized_by_normalization");

      views.push(makeView({
        identity,
        identityKey: key,
        aggregateStatus: capability.status,
        operationStatus,
        registryBindingPresent,
        descriptor,
        registryMechanism: binding?.mechanism ?? "unknown",
        permissionRequirement,
        requiredPermissions,
        approvalRequirement: descriptorConflict.approvalRequirement,
        verification,
        verificationScope: verification === "synthetic_only" ? evidenceForDescriptor.scope : null,
        verificationSiteIdentityHash: null,
        recoveryStrategy: binding?.recoveryStrategy ?? "none",
        adapterRouteEligible,
        reasons,
      }));
    }
  }

  return {
    views: Object.freeze(views),
    conflicts: Object.freeze(dedupeConflicts(conflicts)),
    validationErrors: Object.freeze(dedupeValidationErrors(validationErrors)),
  };
}

export function capabilityIdentityKey(identity: CapabilityIdentity): string {
  if (!VALID_CMS_IDS.includes(identity.cms) ||
      !(CAPABILITY_OPERATIONS as readonly string[]).includes(identity.operationId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identity.capabilityId)) {
    throw new TypeError("Invalid capability identity.");
  }
  return JSON.stringify([identity.cms, identity.capabilityId, identity.operationId]);
}

function findAggregateConflict(
  aggregateStatus: CapabilityStatus,
  operations: readonly CapabilityOperation[],
  bindings: Readonly<Partial<Record<CapabilityOperation, CapabilityOperationBinding>>>,
): boolean {
  if (aggregateStatus === "PARTIALLY_IMPLEMENTED") {
    return !operations.some((operation) => {
      const status = bindings[operation]?.status;
      return status === "IMPLEMENTED_AND_TESTED" ||
        status === "IMPLEMENTED_BUT_UNVERIFIED" ||
        status === "PARTIALLY_IMPLEMENTED";
    });
  }
  return operations.some((operation) => bindings[operation]?.status !== aggregateStatus);
}

function resolveRegistryPermission(
  binding: CapabilityOperationBinding | undefined,
  conflicts: CapabilityConflict[],
  identity: CapabilityIdentity,
): { requirement: CapabilityPermissionRequirement; permissions: readonly string[] } {
  if (!binding) return { requirement: { kind: "unknown" }, permissions: [] };
  const explicit = binding.permissionRequirement;
  if (!explicit) {
    return binding.permissions.length > 0
      ? { requirement: { kind: "required", permissions: [...binding.permissions] }, permissions: [...binding.permissions] }
      : { requirement: { kind: "unknown" }, permissions: [] };
  }
  if (explicit.kind === "required") {
    if (!sameStringSet(explicit.permissions, binding.permissions) || binding.permissions.length === 0) {
      conflicts.push({ code: "registry_permission_metadata_mismatch", identity });
      return { requirement: { kind: "unknown" }, permissions: [...binding.permissions] };
    }
    return { requirement: { kind: "required", permissions: [...binding.permissions] }, permissions: [...binding.permissions] };
  }
  if (explicit.kind === "permissionless" && binding.permissions.length > 0 ||
      explicit.kind === "unknown" && binding.permissions.length > 0) {
    conflicts.push({ code: "registry_permission_metadata_mismatch", identity });
    return { requirement: { kind: "unknown" }, permissions: [...binding.permissions] };
  }
  return { requirement: explicit, permissions: [] };
}

function reconcileDescriptor(
  descriptor: AdapterCapabilityDescriptor,
  binding: CapabilityOperationBinding | undefined,
  operationStatus: CapabilityStatus,
  identity: CapabilityIdentity,
  registryPermission: { requirement: CapabilityPermissionRequirement; permissions: readonly string[] },
  verifiedEvidence: {
    readonly independent: readonly string[];
    readonly synthetic: readonly string[];
    readonly scope: "adapter_operation" | "provider_site" | null;
  },
  conflicts: CapabilityConflict[],
): {
  readonly reasons: readonly string[];
  readonly accessCompatible: boolean;
  readonly mechanismCompatible: boolean;
  readonly permissionCompatible: boolean;
  readonly permissionSatisfied: boolean;
  readonly permissionRequirement: CapabilityPermissionRequirement;
  readonly requiredPermissions: readonly string[];
  readonly approvalRequirement: EffectiveApprovalRequirement;
  readonly approvalAvailable: boolean;
  readonly approvalAuthorized: boolean;
  readonly approvalCompatible: boolean;
} {
  const reasons = new Set<string>();
  if (descriptor.support === "supported" &&
      operationStatus !== "IMPLEMENTED_AND_TESTED" &&
      operationStatus !== "IMPLEMENTED_BUT_UNVERIFIED") {
    conflicts.push({ code: "descriptor_support_mismatch", identity });
    reasons.add("descriptor_cannot_promote_registry_status");
  }
  if (descriptor.support === "unsupported" &&
      (operationStatus === "IMPLEMENTED_AND_TESTED" ||
       operationStatus === "IMPLEMENTED_BUT_UNVERIFIED")) {
    conflicts.push({ code: "descriptor_support_mismatch", identity });
    reasons.add("descriptor_disagrees_with_registry_support");
  }
  if (descriptor.support === "not_verified" && operationStatus === "IMPLEMENTED_AND_TESTED") {
    conflicts.push({ code: "descriptor_support_mismatch", identity });
    reasons.add("descriptor_verification_disagrees_with_registry");
  }

  const accessCompatible = descriptor.access !== "none" &&
    (identity.operationId === "read"
      ? descriptor.access === "read_only" || descriptor.access === "read_write"
      : descriptor.access === "write" || descriptor.access === "read_write");
  if (!accessCompatible) reasons.add("access_does_not_cover_operation");

  const descriptorMechanism = toRegistryMechanism(descriptor.executionMechanism);
  const mechanismCompatible = descriptor.executionMechanism === "unknown"
    ? false
    : descriptor.executionMechanism === "none"
      ? descriptorMechanism === binding?.mechanism && binding?.mechanism === "unknown"
      : descriptorMechanism === binding?.mechanism;
  if (!mechanismCompatible) {
    if (descriptor.executionMechanism !== "unknown" && descriptor.executionMechanism !== "none") {
      conflicts.push({ code: "descriptor_mechanism_mismatch", identity });
    }
    reasons.add("execution_mechanism_unavailable_or_mismatched");
  }
  if (descriptor.executionMechanism === "custom_code") reasons.add("custom_code_requires_separate_review");
  if (descriptor.executionMechanism === "manual") reasons.add("manual_operation_is_not_automatically_executable");

  const permissionResult = reconcilePermission(
    descriptor.permissionRequirement,
    registryPermission,
    identity,
    conflicts,
  );
  if (!permissionResult.compatible) reasons.add("permission_requirement_unknown_or_mismatched");
  const permissionSatisfied = permissionResult.requirement.kind === "permissionless";
  if (permissionResult.requirement.kind === "required") {
    reasons.add("trusted_permission_provider_not_integrated");
  }

  const approvalResult = reconcileApproval(
    binding?.humanApproval ?? "unavailable",
    descriptor.approvalRequirement,
    identity,
    conflicts,
  );
  if (!approvalResult.available) reasons.add("approval_unavailable");
  const approvalAuthorized = approvalResult.requirement === "none" && approvalResult.available;
  if (approvalResult.requirement !== "none" && approvalResult.available) {
    reasons.add("trusted_approval_receipt_not_integrated");
  }

  if (descriptor.verification === "independently_verified") {
    reasons.add("trusted_verifier_not_integrated");
  }
  if (descriptor.verification === "synthetic_only") reasons.add("synthetic_evidence_cannot_verify_live_provider");
  if (descriptor.verification === "not_verified") reasons.add("verification_not_established");

  return {
    reasons: [...reasons],
    accessCompatible,
    mechanismCompatible,
    permissionCompatible: permissionResult.compatible,
    permissionSatisfied,
    permissionRequirement: permissionResult.requirement,
    requiredPermissions: permissionResult.permissions,
    approvalRequirement: approvalResult.requirement,
    approvalAvailable: approvalResult.available,
    approvalAuthorized,
    approvalCompatible: approvalResult.compatible,
  };
}

function reconcilePermission(
  descriptor: CapabilityPermissionRequirement,
  registry: { requirement: CapabilityPermissionRequirement; permissions: readonly string[] },
  identity: CapabilityIdentity,
  conflicts: CapabilityConflict[],
): { compatible: boolean; requirement: CapabilityPermissionRequirement; permissions: readonly string[] } {
  if (registry.requirement.kind === "unknown") {
    return { compatible: false, requirement: { kind: "unknown" }, permissions: [...descriptorPermissions(descriptor)] };
  }
  if (registry.requirement.kind === "required") {
    if (descriptor.kind !== "required" || !containsAll(descriptor.permissions, registry.permissions)) {
      conflicts.push({ code: "descriptor_permission_mismatch", identity });
      return { compatible: false, requirement: registry.requirement, permissions: [...registry.permissions] };
    }
    return {
      compatible: true,
      requirement: { kind: "required", permissions: unionStrings(registry.permissions, descriptor.permissions) },
      permissions: unionStrings(registry.permissions, descriptor.permissions),
    };
  }
  if (descriptor.kind === "unknown") {
    return { compatible: true, requirement: registry.requirement, permissions: [] };
  }
  if (descriptor.kind === "permissionless") {
    return { compatible: true, requirement: registry.requirement, permissions: [] };
  }
  return {
    compatible: true,
    requirement: { kind: "required", permissions: [...descriptor.permissions] },
    permissions: [...descriptor.permissions],
  };
}

function reconcileApproval(
  registry: HumanApprovalRequirement,
  descriptor: AdapterCapabilityDescriptor["approvalRequirement"],
  identity: CapabilityIdentity,
  conflicts: CapabilityConflict[],
): {
  readonly requirement: EffectiveApprovalRequirement;
  readonly available: boolean;
  readonly compatible: boolean;
  readonly authorized: boolean;
} {
  if (registry === "unavailable") {
    return { requirement: "unavailable", available: false, compatible: false, authorized: false };
  }
  const requirements = new Set<"required" | "policy_based">();
  if (registry === "required") requirements.add("required");
  if (registry === "policy_based") requirements.add("policy_based");
  if (descriptor === "required") requirements.add("required");
  if (descriptor === "policy_based") requirements.add("policy_based");
  if (descriptor === "none" && registry !== "never") {
    conflicts.push({ code: "descriptor_approval_weakens_registry", identity });
  }
  const compatible = !(descriptor === "none" && registry !== "never");
  const requirement: EffectiveApprovalRequirement = requirements.size === 0
    ? "none"
    : requirements.size === 2
      ? "required_and_policy_based"
      : requirements.has("required")
        ? "required"
        : "policy_based";
  return {
    requirement,
    available: true,
    compatible,
    authorized: requirements.size === 0,
  };
}

function validateEvidenceForDescriptor(
  declaration: AdapterCapabilityDeclaration,
  descriptor: AdapterCapabilityDescriptor,
  identity: CapabilityIdentity,
  now: Date,
  duplicateEvidenceIds: ReadonlySet<string>,
  errors: CapabilityValidationError[],
): {
  readonly independent: readonly string[];
  readonly synthetic: readonly string[];
  readonly scope: "adapter_operation" | "provider_site" | null;
} {
  const independentIds: string[] = [];
  const syntheticIds: string[] = [];
  for (const [evidenceIndex, evidence] of descriptor.evidence.entries()) {
    if (duplicateEvidenceIds.has(evidence.evidenceId)) continue;
    if (!evidenceMatchesIdentity(evidence, declaration, identity)) {
      errors.push({ code: "evidence_scope_mismatch", evidenceIndex });
      continue;
    }
    if (evidence.scope === "provider_site") {
      errors.push({ code: "evidence_scope_mismatch", evidenceIndex });
      continue;
    }
    if (evidence.scope === "adapter_operation" && evidence.siteIdentityHash !== null) {
      errors.push({ code: "evidence_scope_mismatch", evidenceIndex });
      continue;
    }
    const sourceClaimMatches =
      (evidence.sourceType === "live_provider_test" && evidence.claim === "independently_tested") ||
      (evidence.sourceType === "synthetic_test" && evidence.claim === "synthetic_only") ||
      (evidence.sourceType === "official_documentation" && evidence.claim === "documented_capability");
    if (!sourceClaimMatches) {
      errors.push({ code: "evidence_claim_mismatch", evidenceIndex });
      continue;
    }
    if (evidence.validUntil === null) {
      errors.push({ code: "evidence_expiry_missing", evidenceIndex });
      continue;
    }
    const expiresAt = Date.parse(evidence.validUntil);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      errors.push({ code: "evidence_expired", evidenceIndex });
      continue;
    }
    if (evidence.validity !== "active") {
      errors.push({
        code: evidence.validity === "expired"
          ? "evidence_expired"
          : evidence.validity === "revoked"
          ? "evidence_revoked"
          : evidence.validity === "superseded"
            ? "evidence_superseded"
            : evidence.validity === "conflicted"
              ? "evidence_conflicted"
              : "evidence_invalidated",
        evidenceIndex,
      });
      continue;
    }
    if (evidence.sourceType === "live_provider_test") {
      if (evidence.reviewStatus !== "approved" || !evidence.reviewedAt ||
          !evidence.reviewerAuthority) {
        errors.push({ code: "evidence_unapproved", evidenceIndex });
      }
      errors.push({ code: "trusted_verifier_not_integrated", evidenceIndex });
      continue;
    }
    if (evidence.sourceType === "synthetic_test") syntheticIds.push(evidence.evidenceId);
  }
  if (descriptor.verification === "independently_verified") {
    errors.push({ code: "trusted_verifier_not_integrated" });
  }
  if (descriptor.verification === "synthetic_only" && syntheticIds.length === 0) {
    errors.push({ code: "evidence_invalidated" });
  }
  const scope = syntheticIds.length > 0 ? "adapter_operation" : null;
  return { independent: independentIds, synthetic: syntheticIds, scope };
}

function evidenceMatchesIdentity(
  evidence: CapabilityVerificationEvidence,
  declaration: AdapterCapabilityDeclaration,
  identity: CapabilityIdentity,
): boolean {
  return evidence.cms === identity.cms && evidence.adapterId === declaration.adapterId &&
    evidence.capabilityId === identity.capabilityId &&
    evidence.operationId === identity.operationId &&
    evidence.contractVersion === declaration.contractVersion;
}

function toRegistryMechanism(
  mechanism: AdapterCapabilityDescriptor["executionMechanism"],
): ExecutionMechanism | "none" {
  if (mechanism === "browser_automation") return "browser_ui";
  return mechanism;
}

function normalizeRegistryApproval(approval: HumanApprovalRequirement): EffectiveApprovalRequirement {
  if (approval === "never") return "none";
  if (approval === "required") return "required";
  if (approval === "policy_based") return "policy_based";
  return "unavailable";
}

function makeView(input: {
  identity: CapabilityIdentity;
  identityKey: string;
  aggregateStatus: CapabilityStatus;
  operationStatus: CapabilityStatus;
  registryBindingPresent: boolean;
  descriptor: AdapterCapabilityDescriptor | null;
  registryMechanism: ExecutionMechanism;
  permissionRequirement: CapabilityPermissionRequirement;
  requiredPermissions: readonly string[];
  approvalRequirement: EffectiveApprovalRequirement;
  verification: EffectiveVerification;
  verificationScope: "adapter_operation" | "provider_site" | null;
  verificationSiteIdentityHash: string | null;
  recoveryStrategy: RecoveryStrategy;
  adapterRouteEligible: boolean;
  reasons: ReadonlySet<string>;
}): EffectiveCapabilityView {
  return Object.freeze({
    identity: input.identity,
    identityKey: input.identityKey,
    aggregateStatus: input.aggregateStatus,
    operationStatus: input.operationStatus,
    registryBindingPresent: input.registryBindingPresent,
    descriptorPresent: input.descriptor !== null,
    descriptorSupport: input.descriptor?.support ?? null,
    access: input.descriptor?.access ?? null,
    registryMechanism: input.registryMechanism,
    descriptorMechanism: input.descriptor?.executionMechanism ?? null,
    permissionRequirement: input.permissionRequirement,
    requiredPermissions: Object.freeze([...input.requiredPermissions]),
    approvalRequirement: input.approvalRequirement,
    verification: input.verification,
    verificationScope: input.verificationScope,
    verificationSiteIdentityHash: input.verificationSiteIdentityHash,
    recoveryStrategy: input.recoveryStrategy,
    adapterRouteEligible: input.adapterRouteEligible,
    reasonCodes: Object.freeze([...input.reasons]),
  });
}

function descriptorPermissions(requirement: CapabilityPermissionRequirement): readonly string[] {
  return requirement.kind === "required" ? requirement.permissions : [];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function containsAll(candidate: readonly string[], required: readonly string[]): boolean {
  return required.every((item) => candidate.includes(item));
}

function unionStrings(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right])].sort();
}

function dedupeConflicts(conflicts: readonly CapabilityConflict[]): CapabilityConflict[] {
  const unique = new Map<string, CapabilityConflict>();
  for (const conflict of conflicts) {
    const operationId = conflict.identity.operationId ?? "*";
    unique.set(`${conflict.code}:${conflict.identity.cms}:${conflict.identity.capabilityId}:${operationId}`, conflict);
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = `${left.code}:${left.identity.cms}:${left.identity.capabilityId}:${left.identity.operationId ?? "*"}`;
    const rightKey = `${right.code}:${right.identity.cms}:${right.identity.capabilityId}:${right.identity.operationId ?? "*"}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function dedupeValidationErrors(
  errors: readonly CapabilityValidationError[],
): CapabilityValidationError[] {
  const unique = new Map<string, CapabilityValidationError>();
  for (const error of errors) {
    const key = `${error.code}:${error.declarationIndex ?? ""}:${error.evidenceIndex ?? ""}`;
    unique.set(key, error);
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = `${left.code}:${left.declarationIndex ?? -1}:${left.evidenceIndex ?? -1}`;
    const rightKey = `${right.code}:${right.declarationIndex ?? -1}:${right.evidenceIndex ?? -1}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function emptyResult(
  conflicts: readonly CapabilityConflict[],
  validationErrors: readonly CapabilityValidationError[],
): CapabilityNormalizationResult {
  return { views: [], conflicts: [...conflicts], validationErrors: [...validationErrors] };
}

