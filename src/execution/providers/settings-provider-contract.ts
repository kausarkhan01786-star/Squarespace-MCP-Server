import { createHash } from "node:crypto";
import type {
  CapabilityOperation,
  CmsId,
} from "../../capabilities/capability-types.js";
import type {
  MutationApprovalGuard,
  MutationAuthorization,
} from "../../approval/mutation-approval.js";
import type { PlannedValue } from "../../planning/settings-change-types.js";

export const SETTINGS_PROVIDER_FEATURES = [
  "READ_SETTING",
  "WRITE_SETTING",
  "ATOMIC_COMPARE_AND_SET",
  "IDEMPOTENT_WRITE",
  "INDEPENDENT_READBACK",
  "CONFLICT_DETECTION",
  "TIMEOUT_RECONCILIATION",
] as const;

export type SettingsProviderFeature = typeof SETTINGS_PROVIDER_FEATURES[number];
export type ProviderEvidenceStatus =
  | "VERIFIED"
  | "PARTIALLY_VERIFIED"
  | "UNSUPPORTED"
  | "UNKNOWN";

export const PROVIDER_EVIDENCE_SOURCE_TYPES = [
  "OFFICIAL_DOCUMENTATION",
  "OFFICIAL_API_REFERENCE",
  "OFFICIAL_PROVIDER_STATEMENT",
  "VERIFIED_PROVIDER_TEST",
  "INDEPENDENT_SECURITY_REVIEW",
  "SYNTHETIC_FIXTURE",
  "UNVERIFIED_REFERENCE",
] as const;
export type ProviderEvidenceSourceType =
  typeof PROVIDER_EVIDENCE_SOURCE_TYPES[number];

export const PROVIDER_EVIDENCE_TRUST_STATUSES = [
  "VERIFIED",
  "VERIFIED_WITH_LIMITATIONS",
  "UNVERIFIED",
  "REJECTED",
  "EXPIRED",
  "REVOKED",
  "CONFLICTED",
] as const;
export type ProviderEvidenceTrustStatus =
  typeof PROVIDER_EVIDENCE_TRUST_STATUSES[number];

export type ProviderEvidenceReviewStatus =
  | "APPROVED"
  | "PENDING"
  | "REJECTED";
export type ProviderEvidenceValidity =
  | "ACTIVE"
  | "EXPIRED"
  | "REVOKED"
  | "SUPERSEDED"
  | "CONFLICTED";
export type ProviderEvidenceClaim =
  | "DOCUMENTED_CAPABILITY"
  | "DOCUMENTED_GUARANTEE"
  | "PROVIDER_ASSERTION"
  | "INDEPENDENTLY_TESTED"
  | "SYNTHETIC_ONLY";

export interface ProviderEvidenceRecord {
  readonly evidenceId: string;
  readonly type: ProviderEvidenceSourceType;
  readonly cms: CmsId;
  readonly adapterId: string;
  readonly feature: SettingsProviderFeature;
  readonly operations: readonly CapabilityOperation[];
  readonly reference: string;
  readonly publisherAuthority: string;
  readonly claim: ProviderEvidenceClaim;
  readonly scope: string;
  readonly retrievedAt: string;
  readonly reviewedAt: string | null;
  readonly reviewStatus: ProviderEvidenceReviewStatus;
  readonly reviewerAuthority: string | null;
  readonly validity: ProviderEvidenceValidity;
  readonly validUntil: string | null;
  readonly supersededBy: string | null;
  readonly conflictsWith: readonly string[];
  readonly limitations: readonly string[];
  readonly verificationNotes: readonly string[];
}

export interface ProviderCapabilityEvidence {
  readonly status: ProviderEvidenceStatus;
  readonly evidence: readonly ProviderEvidenceRecord[];
}

export interface ProviderEvidenceValidationPolicy {
  readonly trustedPublishers: Partial<
    Readonly<Record<ProviderEvidenceSourceType, readonly string[]>>
  >;
  readonly trustedReviewerAuthorities: readonly string[];
  readonly maxEvidenceAgeMs: number | null;
  readonly allowVerifiedWithLimitationsForExecution: boolean;
}

export const DEFAULT_PROVIDER_EVIDENCE_VALIDATION_POLICY:
  ProviderEvidenceValidationPolicy = Object.freeze({
    trustedPublishers: Object.freeze({}),
    trustedReviewerAuthorities: Object.freeze([]),
    maxEvidenceAgeMs: null,
    allowVerifiedWithLimitationsForExecution: false,
  });

export interface ProviderEvidenceValidation {
  readonly trustStatus: ProviderEvidenceTrustStatus;
  readonly acceptedForExecution: boolean;
  readonly acceptedForSyntheticConformance: boolean;
  readonly reasons: readonly string[];
}

export type AtomicPrecondition =
  | {
      readonly kind: "version_token";
      readonly version: string;
    }
  | {
      readonly kind: "expected_value";
    };

export type AtomicPreconditionMode =
  | {
      readonly kind: "version_token";
      readonly evidenceReference: string;
    }
  | {
      readonly kind: "atomic_expected_value";
      readonly evidenceReference: string;
    }
  | {
      readonly kind: "unknown" | "unsupported";
      readonly evidenceReference?: string;
    };

export interface SettingsProviderDeclaration {
  readonly cms: CmsId;
  readonly adapterId: string;
  readonly contractVersion: string;
  readonly providerKind: "synthetic" | "real";
  readonly preconditionMode: AtomicPreconditionMode;
  readonly features: Readonly<Record<
    SettingsProviderFeature,
    ProviderCapabilityEvidence
  >>;
}

export interface AuthorizedSiteIdentity {
  readonly cms: CmsId;
  readonly siteId: string;
  readonly principalId: string;
  readonly verified: boolean;
  readonly grantedPermissions: readonly string[];
}

export interface SettingsTarget {
  readonly cms: CmsId;
  readonly siteId: string;
  readonly categoryId: string;
  readonly settingId: string;
}

export interface ReadSettingResult {
  readonly target: SettingsTarget;
  readonly value: PlannedValue;
  readonly version: string;
  readonly observedAt: string;
}

export type AtomicSettingsUpdateRequest = {
  readonly target: SettingsTarget;
  readonly expectedValue: PlannedValue;
  readonly precondition: AtomicPrecondition;
  readonly proposedValue: PlannedValue;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly proposalFingerprint: string;
};

export interface SettingsConflictEvidence {
  readonly kind: "VALUE_MISMATCH" | "VERSION_MISMATCH" | "SITE_MISMATCH";
  readonly observedValue?: PlannedValue;
  readonly observedVersion?: string;
}

export type AtomicSettingsUpdateResult =
  | {
      readonly outcome: "APPLIED";
      readonly providerOperationId: string;
      readonly committedVersion: string;
      readonly replayed: boolean;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly evidence: SettingsConflictEvidence;
    }
  | {
      readonly outcome: "REJECTED";
      readonly reasonCode: string;
    }
  | {
      readonly outcome: "UNKNOWN";
      readonly reasonCode: string;
      readonly mayHaveApplied: true;
    };

export type TimeoutReconciliationResult =
  | {
      readonly outcome: "COMMITTED";
      readonly providerOperationId: string;
      readonly committedVersion: string;
    }
  | {
      readonly outcome: "NOT_COMMITTED";
    }
  | {
      readonly outcome: "PENDING";
    }
  | {
      readonly outcome: "UNKNOWN";
    };

export interface IndependentVerificationResult {
  readonly target: SettingsTarget;
  readonly value: PlannedValue;
  readonly version: string;
  readonly matchesProposedValue: boolean;
  readonly verifiedAt: string;
}

export interface SettingsProviderAdapter {
  readonly declaration: SettingsProviderDeclaration;
  resolveAuthorizedSite(siteId: string): Promise<AuthorizedSiteIdentity | null>;
  readSetting(target: SettingsTarget): Promise<ReadSettingResult>;
  updateAtomically(
    request: AtomicSettingsUpdateRequest,
  ): Promise<AtomicSettingsUpdateResult>;
  verifyIndependently(
    target: SettingsTarget,
    proposedValue: PlannedValue,
  ): Promise<IndependentVerificationResult>;
  reconcileTimeout(
    target: SettingsTarget,
    idempotencyKey: string,
  ): Promise<TimeoutReconciliationResult>;
}

export interface SettingsProviderEligibilityContext {
  readonly providerAvailable: boolean;
  readonly site: AuthorizedSiteIdentity | null;
  readonly target: SettingsTarget;
  readonly requiredPermissions: readonly string[];
  readonly operation: {
    readonly expectedValue: PlannedValue;
    readonly precondition: AtomicPrecondition;
    readonly proposedValue: PlannedValue;
    readonly executionId: string;
    readonly idempotencyKey: string;
    readonly proposalFingerprint: string;
    readonly operationScope: string;
  };
  readonly approval: MutationAuthorization | null;
  readonly approvalGuard: MutationApprovalGuard | null;
  readonly evidencePolicy?: ProviderEvidenceValidationPolicy;
  readonly evidenceValidationTime?: Date;
}

export interface SettingsProviderEligibility {
  readonly eligibleForExecution: boolean;
  readonly eligibleForSyntheticConformance: boolean;
  readonly reasons: readonly string[];
}

export interface SettingsOperationFingerprintInput {
  readonly target: SettingsTarget;
  readonly expectedValue: PlannedValue;
  readonly precondition: AtomicPrecondition;
  readonly proposedValue: PlannedValue;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly operationScope: string;
}

export function fingerprintSettingsOperation(
  input: SettingsOperationFingerprintInput,
): string {
  return createHash("sha256")
    .update(stableStringify(input))
    .digest("hex");
}

const REQUIRED_UPDATE_FEATURES: readonly SettingsProviderFeature[] = [
  "READ_SETTING",
  "WRITE_SETTING",
  "ATOMIC_COMPARE_AND_SET",
  "IDEMPOTENT_WRITE",
  "INDEPENDENT_READBACK",
  "CONFLICT_DETECTION",
  "TIMEOUT_RECONCILIATION",
];

const RUNTIME_BEHAVIOR_FEATURES = new Set<SettingsProviderFeature>([
  "WRITE_SETTING",
  "ATOMIC_COMPARE_AND_SET",
  "IDEMPOTENT_WRITE",
  "CONFLICT_DETECTION",
  "TIMEOUT_RECONCILIATION",
]);

export function validateProviderCapabilityEvidence(
  declaration: SettingsProviderDeclaration,
  feature: SettingsProviderFeature,
  evidence: ProviderCapabilityEvidence,
  policy: ProviderEvidenceValidationPolicy =
    DEFAULT_PROVIDER_EVIDENCE_VALIDATION_POLICY,
  now = new Date(),
): ProviderEvidenceValidation {
  const reasons = new Set<string>();
  const records = evidence.evidence;
  if (!Array.isArray(records) || records.length === 0) {
    return validationResult("UNVERIFIED", false, false, ["EVIDENCE_MISSING"]);
  }
  if (
    policy.maxEvidenceAgeMs !== null &&
    (!Number.isSafeInteger(policy.maxEvidenceAgeMs) || policy.maxEvidenceAgeMs < 0)
  ) {
    return validationResult("UNVERIFIED", false, false, ["EVIDENCE_POLICY_INVALID"]);
  }

  const matchingIds = records.filter((candidate) =>
    typeof candidate?.evidenceId === "string" &&
    records.filter((other) => other?.evidenceId === candidate.evidenceId).length > 1);
  const allRecords = Object.values(declaration.features ?? {})
    .flatMap((featureEvidence) => featureEvidence?.evidence ?? []);
  const duplicateIds = new Set<string>();
  for (const candidate of allRecords) {
    if (typeof candidate?.evidenceId !== "string" || candidate.evidenceId.length === 0) continue;
    if (allRecords.filter((other) => other?.evidenceId === candidate.evidenceId).length > 1) {
      duplicateIds.add(candidate.evidenceId);
    }
  }
  if (matchingIds.length > 0 || duplicateIds.size > 0) {
    reasons.add("EVIDENCE_IDENTIFIER_DUPLICATE");
  }

  let hasAcceptedProductionEvidence = false;
  let hasAcceptedSyntheticEvidence = false;
  let sawExpired = false;
  let sawRevoked = false;
  let sawRejected = false;
  let sawUnverified = false;
  let sawConflict = matchingIds.length > 0 || duplicateIds.size > 0;
  let hasLimitations = false;
  for (const item of records) {
    if (!item || typeof item !== "object") {
      reasons.add("EVIDENCE_RECORD_INVALID");
      sawRejected = true;
      continue;
    }
    if (
      typeof item.evidenceId !== "string" ||
      item.evidenceId.trim().length === 0 ||
      typeof item.reference !== "string" ||
      item.reference.trim().length === 0
    ) {
      reasons.add("EVIDENCE_ID_OR_SOURCE_REFERENCE_MISSING");
      sawUnverified = true;
    }
    if (!PROVIDER_EVIDENCE_SOURCE_TYPES.includes(item.type)) {
      reasons.add("EVIDENCE_SOURCE_TYPE_UNSUPPORTED");
      sawRejected = true;
      continue;
    }
    if (
      ![
        "DOCUMENTED_CAPABILITY",
        "DOCUMENTED_GUARANTEE",
        "PROVIDER_ASSERTION",
        "INDEPENDENTLY_TESTED",
        "SYNTHETIC_ONLY",
      ].includes(item.claim)
    ) {
      reasons.add("EVIDENCE_CLAIM_UNSUPPORTED");
      sawRejected = true;
    }
    if (
      typeof item.publisherAuthority !== "string" ||
      item.publisherAuthority.trim().length === 0 ||
      typeof item.scope !== "string" ||
      item.scope.trim().length === 0 ||
      !Array.isArray(item.operations) ||
      item.operations.length === 0 ||
      !Array.isArray(item.limitations) ||
      !Array.isArray(item.verificationNotes) ||
      !Array.isArray(item.conflictsWith) ||
      (item.supersededBy !== null && typeof item.supersededBy !== "string")
    ) {
      reasons.add("EVIDENCE_PROVENANCE_OR_SCOPE_INCOMPLETE");
      sawUnverified = true;
    }
    if (Array.isArray(item.limitations) && item.limitations.length > 0) {
      hasLimitations = true;
      reasons.add("EVIDENCE_HAS_LIMITATIONS");
    }
    if (
      item.cms !== declaration.cms ||
      item.adapterId !== declaration.adapterId ||
      item.feature !== feature
    ) {
      reasons.add("EVIDENCE_SCOPE_MISMATCH");
      sawRejected = true;
    }
    const requiredOperation = operationForFeature(feature);
    if (
      !Array.isArray(item.operations) ||
      !item.operations.includes(requiredOperation)
    ) {
      reasons.add("EVIDENCE_OPERATION_SCOPE_MISMATCH");
      sawRejected = true;
    }
    if (
      item.validity === "REVOKED" ||
      item.validity === "SUPERSEDED" ||
      (typeof item.supersededBy === "string" && item.supersededBy.length > 0)
    ) {
      reasons.add(
        item.validity === "REVOKED" ? "EVIDENCE_REVOKED" : "EVIDENCE_SUPERSEDED",
      );
      sawRevoked = true;
    } else if (item.validity === "EXPIRED") {
      reasons.add("EVIDENCE_EXPIRED");
      sawExpired = true;
    } else if (
      item.validity === "CONFLICTED" ||
      (Array.isArray(item.conflictsWith) && item.conflictsWith.length > 0)
    ) {
      reasons.add("EVIDENCE_CONFLICTED");
      sawConflict = true;
    } else if (item.validity !== "ACTIVE") {
      reasons.add("EVIDENCE_VALIDITY_UNKNOWN");
      sawRejected = true;
    }
    if (
      item.validUntil !== null &&
      (!isValidTimestamp(item.validUntil) || Date.parse(item.validUntil) <= now.getTime())
    ) {
      reasons.add("EVIDENCE_EXPIRED");
      sawExpired = true;
    }
    if (
      !isValidTimestamp(item.retrievedAt) ||
      Date.parse(item.retrievedAt) > now.getTime()
    ) {
      reasons.add("EVIDENCE_RETRIEVAL_DATE_INVALID");
      sawUnverified = true;
    }
    if (item.reviewStatus === "REJECTED") {
      reasons.add("EVIDENCE_REVIEW_REJECTED");
      sawRejected = true;
    } else if (item.reviewStatus !== "APPROVED") {
      reasons.add("EVIDENCE_REVIEW_NOT_APPROVED");
      sawUnverified = true;
    }

    const syntheticEvidence = item.type === "SYNTHETIC_FIXTURE" &&
      item.claim === "SYNTHETIC_ONLY";
    if (syntheticEvidence) {
      const fixtureIsScoped = declaration.providerKind === "synthetic" &&
        item.cms === declaration.cms &&
        item.adapterId === declaration.adapterId &&
        item.feature === feature &&
        Array.isArray(item.operations) &&
        item.operations.includes(requiredOperation) &&
        item.validity === "ACTIVE" &&
        item.reviewStatus === "APPROVED";
      if (fixtureIsScoped && !sawRejected && !sawExpired && !sawRevoked && !sawConflict) {
        hasAcceptedSyntheticEvidence = true;
      } else {
        reasons.add("SYNTHETIC_EVIDENCE_NOT_VALID_FOR_PRODUCTION");
        sawRejected = true;
      }
      continue;
    }

    if (
      item.type === "SYNTHETIC_FIXTURE" ||
      item.type === "UNVERIFIED_REFERENCE" ||
      item.claim === "SYNTHETIC_ONLY"
    ) {
      reasons.add("EVIDENCE_SOURCE_NOT_TRUSTED_FOR_PROVIDER");
      if (item.type === "UNVERIFIED_REFERENCE") sawUnverified = true;
      else sawRejected = true;
      continue;
    }

    if (!isTrustedPublisher(item, policy)) {
      reasons.add("EVIDENCE_PUBLISHER_UNTRUSTED");
      sawRejected = true;
    }
    if (
      !item.reviewedAt ||
      !isValidTimestamp(item.reviewedAt) ||
      Date.parse(item.reviewedAt) > now.getTime() ||
      typeof item.reviewerAuthority !== "string" ||
      item.reviewerAuthority.trim().length === 0 ||
      !policy.trustedReviewerAuthorities.includes(item.reviewerAuthority)
    ) {
      reasons.add("EVIDENCE_REVIEWER_AUTHORITY_UNTRUSTED_OR_MISSING");
      if (
        typeof item.reviewerAuthority !== "string" ||
        item.reviewerAuthority.trim().length === 0
      ) {
        sawUnverified = true;
      } else {
        sawRejected = true;
      }
    }
    if (
      policy.maxEvidenceAgeMs !== null &&
      isValidTimestamp(item.reviewedAt) &&
      now.getTime() - Date.parse(item.reviewedAt) > policy.maxEvidenceAgeMs
    ) {
      reasons.add("EVIDENCE_STALE_BY_POLICY");
      sawExpired = true;
    }
    if (
      RUNTIME_BEHAVIOR_FEATURES.has(feature) &&
      item.claim !== "DOCUMENTED_GUARANTEE" &&
      item.claim !== "INDEPENDENTLY_TESTED"
    ) {
      reasons.add("EVIDENCE_DOES_NOT_ESTABLISH_RUNTIME_BEHAVIOR");
      sawRejected = true;
    }
    if (
      RUNTIME_BEHAVIOR_FEATURES.has(feature) &&
      item.type === "OFFICIAL_PROVIDER_STATEMENT"
    ) {
      reasons.add("PROVIDER_STATEMENT_CANNOT_PROVE_RUNTIME_BEHAVIOR");
      sawRejected = true;
    }
    if (
      item.type === "OFFICIAL_PROVIDER_STATEMENT" &&
      item.claim === "INDEPENDENTLY_TESTED"
    ) {
      reasons.add("PROVIDER_STATEMENT_IS_NOT_INDEPENDENT_TEST_EVIDENCE");
      sawRejected = true;
    }
    if (
      (item.type === "OFFICIAL_DOCUMENTATION" ||
        item.type === "OFFICIAL_API_REFERENCE") &&
      item.claim !== "DOCUMENTED_CAPABILITY" &&
      item.claim !== "DOCUMENTED_GUARANTEE"
    ) {
      reasons.add("OFFICIAL_DOCUMENTATION_CLAIM_TYPE_MISMATCH");
      sawRejected = true;
    }

    if (
      !sawRejected &&
      !sawExpired &&
      !sawRevoked &&
      !sawConflict &&
      item.cms === declaration.cms &&
      item.adapterId === declaration.adapterId &&
      item.feature === feature &&
      item.reviewStatus === "APPROVED"
    ) {
      hasAcceptedProductionEvidence = true;
    }
  }

  if (sawConflict) return validationResult("CONFLICTED", false, false, [...reasons]);
  if (sawRevoked) return validationResult("REVOKED", false, false, [...reasons]);
  if (sawExpired) return validationResult("EXPIRED", false, false, [...reasons]);
  if (sawRejected) return validationResult("REJECTED", false, false, [...reasons]);
  if (sawUnverified) return validationResult("UNVERIFIED", false, false, [...reasons]);
  if (hasAcceptedProductionEvidence && hasLimitations) {
    return validationResult(
      "VERIFIED_WITH_LIMITATIONS",
      policy.allowVerifiedWithLimitationsForExecution,
      false,
      [...reasons],
    );
  }
  if (hasAcceptedProductionEvidence) {
    return validationResult("VERIFIED", true, false, [...reasons]);
  }
  if (hasAcceptedSyntheticEvidence && declaration.providerKind === "synthetic") {
    return validationResult("VERIFIED_WITH_LIMITATIONS", false, true, [
      ...reasons,
      "SYNTHETIC_EVIDENCE_IS_TEST_ONLY",
    ]);
  }
  return validationResult("UNVERIFIED", false, false, [
    ...reasons,
    "EVIDENCE_PROVENANCE_UNVERIFIED",
  ]);
}

function operationForFeature(feature: SettingsProviderFeature): CapabilityOperation {
  return feature === "READ_SETTING" || feature === "INDEPENDENT_READBACK"
    ? "read"
    : "update";
}

function isTrustedPublisher(
  item: ProviderEvidenceRecord,
  policy: ProviderEvidenceValidationPolicy,
): boolean {
  const authorities = policy.trustedPublishers[item.type] ?? [];
  const publisherAuthority = item.publisherAuthority.toLowerCase();
  if (!authorities.some((authority) => authority.toLowerCase() === publisherAuthority)) {
    return false;
  }
  if (
    item.type !== "OFFICIAL_DOCUMENTATION" &&
    item.type !== "OFFICIAL_API_REFERENCE" &&
    item.type !== "OFFICIAL_PROVIDER_STATEMENT"
  ) {
    return true;
  }
  try {
    const url = new URL(item.reference);
    return url.protocol === "https:" &&
      (url.hostname === publisherAuthority ||
        url.hostname.endsWith(`.${publisherAuthority}`));
  } catch {
    return false;
  }
}

function isValidTimestamp(value: string): boolean {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    Number.isFinite(Date.parse(value));
}

function validationResult(
  trustStatus: ProviderEvidenceTrustStatus,
  acceptedForExecution: boolean,
  acceptedForSyntheticConformance: boolean,
  reasons: readonly string[],
): ProviderEvidenceValidation {
  return {
    trustStatus,
    acceptedForExecution,
    acceptedForSyntheticConformance,
    reasons: Object.freeze([...new Set(reasons)]),
  };
}

export function evaluateSettingsProviderEligibility(
  declaration: SettingsProviderDeclaration | null,
  context: SettingsProviderEligibilityContext,
): SettingsProviderEligibility {
  const reasons: string[] = [];
  if (!declaration || !context.providerAvailable) {
    reasons.push("PROVIDER_UNAVAILABLE");
    return eligibilityResult(declaration, reasons);
  }
  if (
    !declaration.cms ||
    !declaration.adapterId?.trim() ||
    !declaration.contractVersion?.trim() ||
    !["real", "synthetic"].includes(declaration.providerKind) ||
    !declaration.preconditionMode ||
    !["version_token", "atomic_expected_value", "unknown", "unsupported"].includes(
      declaration.preconditionMode.kind,
    )
  ) {
    reasons.push("PROVIDER_DECLARATION_INCOMPLETE");
    return eligibilityResult(null, reasons);
  }

  if (!context.site?.verified) reasons.push("SITE_IDENTITY_NOT_VERIFIED");
  if (
    !context.site ||
    context.site.cms !== declaration.cms ||
    context.site.siteId !== context.target.siteId ||
    context.site.cms !== context.target.cms
  ) {
    reasons.push("SITE_IDENTITY_MISMATCH");
  }
  const granted = new Set(context.site?.grantedPermissions ?? []);
  if (context.requiredPermissions.some((permission) => !granted.has(permission))) {
    reasons.push("REQUIRED_PERMISSION_MISSING");
  }

  for (const feature of REQUIRED_UPDATE_FEATURES) {
    const evidence = declaration.features?.[feature];
    if (!evidence) {
      reasons.push(`CAPABILITY_${feature}_EVIDENCE_MISSING_OR_OUT_OF_SCOPE`);
      continue;
    }
    if (evidence.status !== "VERIFIED") {
      reasons.push(`CAPABILITY_${feature}_${evidence.status}`);
    }
    const provenance = validateProviderCapabilityEvidence(
      declaration,
      feature,
      evidence,
      context.evidencePolicy,
      context.evidenceValidationTime,
    );
    if (
      declaration.providerKind === "real"
        ? !provenance.acceptedForExecution
        : !provenance.acceptedForSyntheticConformance
    ) {
      reasons.push(
        `CAPABILITY_${feature}_EVIDENCE_PROVENANCE_${provenance.trustStatus}`,
      );
      reasons.push(`CAPABILITY_${feature}_EVIDENCE_MISSING_OR_OUT_OF_SCOPE`);
      reasons.push(...provenance.reasons.map((reason) =>
        `CAPABILITY_${feature}_${reason}`));
    }
  }

  if (
    (declaration.preconditionMode.kind === "version_token" ||
      declaration.preconditionMode.kind === "atomic_expected_value") &&
    !declaration.features?.ATOMIC_COMPARE_AND_SET?.evidence?.some((item) =>
      item.reference === declaration.preconditionMode.evidenceReference)
  ) {
    reasons.push("ATOMIC_PRECONDITION_EVIDENCE_NOT_BOUND");
  }

  if (
    declaration.preconditionMode.kind === "unknown" ||
    declaration.preconditionMode.kind === "unsupported"
  ) {
    reasons.push("ATOMIC_PRECONDITION_UNVERIFIED");
  } else if (
    declaration.preconditionMode.kind === "version_token" &&
    context.operation.precondition.kind !== "version_token"
  ) {
    reasons.push("EXPECTED_VERSION_REQUIRED");
  } else if (
    declaration.preconditionMode.kind === "atomic_expected_value" &&
    context.operation.precondition.kind !== "expected_value"
  ) {
    reasons.push("ATOMIC_EXPECTED_VALUE_PRECONDITION_REQUIRED");
  }

  if (
    !context.approval ||
    !context.approvalGuard?.isAuthorizationValid(
      context.approval.proposal,
      context.approval.receipt,
    ) ||
    context.approval.proposal.provider !== declaration.cms ||
    context.approval.proposal.websiteId !== context.target.siteId ||
    context.approval.proposal.targetResource !== targetResource(context.target) ||
    context.approval.proposal.action !== context.operation.operationScope ||
    context.operation.operationScope !== "settings.update" ||
    context.approval.proposal.permissionScopes.length !== 1 ||
    context.approval.proposal.permissionScopes[0] !== "settings.update" ||
    !sameValue(context.approval.proposal.payload.expectedValue, context.operation.expectedValue) ||
    !sameValue(context.approval.proposal.payload.precondition, context.operation.precondition) ||
    !sameValue(context.approval.proposal.payload.proposedValue, context.operation.proposedValue) ||
    context.approval.proposal.payload.executionId !== context.operation.executionId ||
    context.approval.proposal.payload.idempotencyKey !== context.operation.idempotencyKey ||
    context.approval.proposal.payload.proposalFingerprint !== context.operation.proposalFingerprint ||
    context.approval.proposal.payload.operationScope !== context.operation.operationScope ||
    context.operation.proposalFingerprint !== fingerprintSettingsOperation({
      target: context.target,
      expectedValue: context.operation.expectedValue,
      precondition: context.operation.precondition,
      proposedValue: context.operation.proposedValue,
      executionId: context.operation.executionId,
      idempotencyKey: context.operation.idempotencyKey,
      operationScope: context.operation.operationScope,
    }) ||
    !context.operation.executionId ||
    !context.operation.idempotencyKey
  ) {
    reasons.push("EXACT_APPROVAL_NOT_VERIFIED");
  }

  return eligibilityResult(declaration, reasons);
}

function eligibilityResult(
  declaration: SettingsProviderDeclaration | null,
  reasons: readonly string[],
): SettingsProviderEligibility {
  const eligible = reasons.length === 0;
  return {
    eligibleForExecution: eligible && declaration?.providerKind === "real",
    eligibleForSyntheticConformance:
      eligible && declaration?.providerKind === "synthetic",
    reasons: Object.freeze([...reasons]),
  };
}

function targetResource(target: SettingsTarget): string {
  return `setting:${target.categoryId}:${target.settingId}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      Object.hasOwn(right, key) &&
      sameValue(left[key], right[key]));
}

function stableStringify(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) {
    throw new TypeError("Settings operation fingerprint input is not serializable.");
  }
  return serialized;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
