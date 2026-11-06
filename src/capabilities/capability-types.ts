export const CMS_IDS = ["squarespace", "wordpress", "wix"] as const;
export type CmsId = typeof CMS_IDS[number];

export const CAPABILITY_STATUSES = [
  "IMPLEMENTED_AND_TESTED",
  "IMPLEMENTED_BUT_UNVERIFIED",
  "PARTIALLY_IMPLEMENTED",
  "NOT_IMPLEMENTED",
  "UNSUPPORTED_OR_RESTRICTED",
  "UNKNOWN_NEEDS_INVESTIGATION",
] as const;
export type CapabilityStatus = typeof CAPABILITY_STATUSES[number];

export const CAPABILITY_OPERATIONS = ["read", "create", "update", "delete"] as const;
export type CapabilityOperation = typeof CAPABILITY_OPERATIONS[number];

export type ExecutionMechanism =
  | "official_api"
  | "browser_ui"
  | "hybrid"
  | "custom_code"
  | "manual"
  | "unknown";

export type HumanApprovalRequirement =
  | "never"
  | "required"
  | "policy_based"
  | "unavailable";

export type RecoveryStrategy =
  | "none"
  | "snapshot_restore"
  | "provider_rollback"
  | "manual_recovery";

export type CapabilityPermissionRequirement =
  | { readonly kind: "required"; readonly permissions: readonly string[] }
  | { readonly kind: "permissionless" }
  | { readonly kind: "unknown" };

export interface CapabilityDefinition {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly operations: readonly CapabilityOperation[];
}

export interface CapabilityOperationBinding {
  readonly status: CapabilityStatus;
  readonly toolNames: readonly string[];
  readonly mechanism: ExecutionMechanism;
  readonly permissions: readonly string[];
  readonly permissionRequirement?: CapabilityPermissionRequirement;
  readonly humanApproval: HumanApprovalRequirement;
  readonly verificationRequirements: readonly string[];
  readonly recoveryStrategy: RecoveryStrategy;
  readonly limitations: readonly string[];
}

export interface CapabilityEvidence {
  readonly kind: "implementation" | "test" | "audit" | "documentation";
  readonly source: string;
  readonly note: string;
}

export interface CmsCapabilityBinding {
  readonly cms: CmsId;
  readonly capabilityId: string;
  readonly status: CapabilityStatus;
  readonly operations: Readonly<Partial<Record<
    CapabilityOperation,
    CapabilityOperationBinding
  >>>;
  readonly evidence: readonly CapabilityEvidence[];
}

export interface RegisteredCapability {
  readonly cms: CmsId;
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly status: CapabilityStatus;
  readonly operations: Readonly<Partial<Record<
    CapabilityOperation,
    CapabilityOperationBinding
  >>>;
  readonly evidence: readonly CapabilityEvidence[];
}

export interface OperationEligibilityContext {
  readonly grantedPermissions?: readonly string[];
  readonly humanApprovalGranted?: boolean;
  readonly policyAuthorized?: boolean;
  readonly verificationCompleted?: boolean;
}

export interface OperationEligibility {
  readonly eligible: boolean;
  readonly reason: string | null;
}
