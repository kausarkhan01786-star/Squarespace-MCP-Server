import type {
  CapabilityStatus,
  CmsId,
  ExecutionMechanism,
  RecoveryStrategy,
} from "../capabilities/capability-types.js";
import type {
  PlannedValue,
  PlannedValueType,
  SettingsChangePlan,
} from "../planning/settings-change-types.js";
import type { SettingsPlanningProvider } from "../planning/settings-change-types.js";

export type SettingsVerificationStatus =
  | "VERIFIED"
  | "FAILED"
  | "UNKNOWN"
  | "PARTIALLY_VERIFIED";

export type SettingsExecutionStatus =
  | "BLOCKED"
  | "VERIFIED"
  | "FAILED"
  | "UNKNOWN";

export type SettingsApprovalStatus =
  | "NOT_REQUESTED"
  | "ACCEPTED"
  | "REJECTED_OR_CANCELLED"
  | "UNAVAILABLE"
  | "EXPIRED";

export type SettingsRecoveryStatus =
  | "NOT_NEEDED"
  | "MANUAL_RECOVERY_REQUIRED"
  | "UNAVAILABLE";

export interface SettingsExecutionProvider extends SettingsPlanningProvider {
  updateField(input: {
    readonly siteId: string;
    readonly categoryId: string;
    readonly fieldId: string;
    readonly expectedCurrentValue: PlannedValue;
    readonly proposedValue: PlannedValue;
    readonly valueType: PlannedValueType;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

export interface ExecuteApprovedSettingsChangeInput {
  readonly planId: string;
  readonly changeId: string;
}

export interface SettingsExecutionResult {
  readonly executionId: string;
  readonly planId: string;
  readonly changeId: string;
  readonly cmsProvider: CmsId | null;
  readonly siteId: string | null;
  readonly categoryId: string | null;
  readonly fieldId: string | null;
  readonly status: SettingsExecutionStatus;
  readonly approvalStatus: SettingsApprovalStatus;
  readonly verificationStatus: SettingsVerificationStatus | null;
  readonly recoveryStatus: SettingsRecoveryStatus;
  readonly capabilityStatus: CapabilityStatus;
  readonly executionMechanism: ExecutionMechanism;
  readonly proposalFingerprint: string | null;
  readonly preExecutionSource: string | null;
  readonly preExecutionConfidence: number | null;
  readonly verificationSource: string | null;
  readonly verificationConfidence: number | null;
  readonly reasonCodes: readonly string[];
  readonly createdAt: string;
  readonly completedAt: string;
}

export interface SettingsExecutionCapabilitySummary {
  readonly capabilityId: string;
  readonly status: CapabilityStatus;
  readonly updateStatus: CapabilityStatus | null;
  readonly mechanism: ExecutionMechanism | null;
  readonly recoveryStrategy: RecoveryStrategy | null;
  readonly executable: false;
  readonly reasons: readonly string[];
}

export interface SettingsExecutionStatusReport {
  readonly cmsProvider: CmsId;
  readonly executionProviderConfigured: boolean;
  readonly mutationToolExposed: false;
  readonly capabilities: readonly SettingsExecutionCapabilitySummary[];
  readonly limitations: readonly string[];
}

export interface SettingsExecutionPlanLookup {
  getSettingsChangePlan(planId: string): SettingsChangePlan | undefined;
}
