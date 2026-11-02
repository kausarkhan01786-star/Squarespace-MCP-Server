import type {
  CapabilityStatus,
  CmsId,
  ExecutionMechanism,
  HumanApprovalRequirement,
  RecoveryStrategy,
} from "../capabilities/capability-types.js";

export type PlannedValueType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "url"
  | "string_list"
  | "object"
  | "unknown";

export type PlannedValue =
  | string
  | number
  | boolean
  | null
  | readonly PlannedValue[]
  | { readonly [key: string]: PlannedValue };

export type ChangeRiskLevel =
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL"
  | "UNKNOWN";

export type SettingsChangeStatus =
  | "PLANNED"
  | "READY_FOR_APPROVAL"
  | "BLOCKED"
  | "UNSUPPORTED"
  | "NEEDS_INVESTIGATION"
  | "NO_CHANGE_REQUIRED";

export type SettingsChangePlanStatus =
  | SettingsChangeStatus
  | "NEEDS_CLARIFICATION"
  | "PARTIAL";

export interface SettingsPlanningSite {
  readonly id: string;
  readonly name: string;
}

export interface SettingsPlanningField {
  readonly fieldId: string;
  readonly fieldLabel: string;
  readonly currentValue: PlannedValue;
  readonly valueType: PlannedValueType;
  readonly valueStatus:
    | "AVAILABLE"
    | "EMPTY"
    | "MASKED"
    | "REDACTED"
    | "ACCESS_DENIED"
    | "UNSUPPORTED"
    | "UNKNOWN"
    | "ERROR";
  readonly source: string;
  readonly inspectionConfidence: number;
  readonly isSensitive: boolean;
  readonly limitations: readonly string[];
  readonly allowedValues?: readonly PlannedValue[];
}

export interface SettingsPlanningInspection {
  readonly status:
    | "AVAILABLE"
    | "PARTIALLY_AVAILABLE"
    | "NOT_AVAILABLE"
    | "ACCESS_DENIED"
    | "UNKNOWN"
    | "ERROR";
  readonly fields: readonly SettingsPlanningField[];
  readonly source: string;
  readonly limitations: readonly string[];
  readonly errors: readonly string[];
}

export interface SettingsPlanningProvider {
  readonly cms: CmsId;
  listSites(): Promise<readonly SettingsPlanningSite[]>;
  inspectCategory(
    siteId: string,
    categoryId: string,
  ): Promise<SettingsPlanningInspection>;
  capabilityIdForCategory(categoryId: string): string | undefined;
  getGrantedPermissions?(siteId: string): Promise<readonly string[] | null>;
  inspectKnownField?(
    siteId: string,
    categoryId: string,
    fieldLabel: string,
  ): Promise<SettingsPlanningField | null>;
}

export interface ParsedSettingsChangeIntent {
  readonly categoryId: string | null;
  readonly fieldId: string | null;
  readonly fieldLabel: string;
  readonly proposedValue: PlannedValue;
  readonly valueType: PlannedValueType;
  readonly operation: "update";
  readonly confidence: number;
  readonly status: "RESOLVED" | "NEEDS_CLARIFICATION";
  readonly clarification?: string;
  readonly warnings: readonly string[];
}

export interface SettingsChangeEvidence {
  readonly categoryId: string;
  readonly fieldId: string | null;
  readonly fieldLabel: string;
  readonly currentValue: PlannedValue | null;
  readonly currentValueStatus: SettingsPlanningField["valueStatus"] | "NOT_INSPECTED";
  readonly valueType: PlannedValueType;
  readonly source: string | null;
  readonly inspectionConfidence: number;
  readonly limitations: readonly string[];
}

export interface SettingsChangeComparison {
  readonly fieldLabel: string;
  readonly currentValue: PlannedValue | null;
  readonly proposedValue: PlannedValue;
  readonly changeRequired: boolean | null;
  readonly status: "COMPARABLE" | "NO_CHANGE_REQUIRED" | "UNAVAILABLE";
}

export interface SettingsRiskAssessment {
  readonly riskLevel: ChangeRiskLevel;
  readonly factors: readonly string[];
}

export interface SettingsCapabilityCheck {
  readonly capabilityId: string | null;
  readonly capabilityStatus: CapabilityStatus;
  readonly operationStatus: CapabilityStatus | null;
  readonly executionMechanism: ExecutionMechanism;
  readonly registeredTools: readonly string[];
  readonly requiredPermissions: readonly string[];
  readonly missingPermissions: readonly string[];
  readonly permissionStatus: "KNOWN" | "MISSING" | "UNKNOWN";
  readonly approvalPolicy: HumanApprovalRequirement;
  readonly verificationRequirements: readonly string[];
  readonly recoveryStrategy: RecoveryStrategy;
  readonly eligibleForExecution: false;
  readonly reasons: readonly string[];
}

export interface PlannedSettingsChange {
  readonly changeId: string;
  readonly cmsProvider: CmsId | null;
  readonly siteId: string | null;
  readonly categoryId: string | null;
  readonly fieldId: string | null;
  readonly fieldLabel: string;
  readonly currentValue: PlannedValue | null;
  readonly proposedValue: PlannedValue;
  readonly valueType: PlannedValueType;
  readonly changeType: "update";
  readonly source: string | null;
  readonly inspectionConfidence: number;
  readonly riskLevel: ChangeRiskLevel;
  readonly requiredPermissions: readonly string[];
  readonly executionMechanism: ExecutionMechanism;
  readonly capabilityStatus: CapabilityStatus;
  readonly approvalRequired: boolean;
  readonly status: SettingsChangeStatus;
  readonly comparison: SettingsChangeComparison;
  readonly evidence: SettingsChangeEvidence | null;
  readonly riskAssessment: SettingsRiskAssessment;
  readonly capabilityCheck: SettingsCapabilityCheck;
  readonly limitations: readonly string[];
  readonly warnings: readonly string[];
  readonly blockedReasons: readonly string[];
}

export interface SettingsChangePlan {
  readonly planId: string;
  readonly originalInstruction: string;
  readonly cmsProvider: CmsId | null;
  readonly siteId: string | null;
  readonly status: SettingsChangePlanStatus;
  readonly changes: readonly PlannedSettingsChange[];
  readonly parsedIntents: readonly ParsedSettingsChangeIntent[];
  readonly clarificationQuestions: readonly string[];
  readonly currentSettingsEvidence: readonly SettingsChangeEvidence[];
  readonly riskAssessment: SettingsRiskAssessment;
  readonly requiredPermissions: readonly string[];
  readonly approvalRequirements: readonly string[];
  readonly blockedReasons: readonly string[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
  readonly executionEnabled: false;
  readonly limitations: readonly string[];
}

export interface AnalyzeSettingsChangeRequestInput {
  readonly instruction: string;
  readonly cmsProvider?: CmsId;
  readonly siteId?: string;
}

export interface PreviewSettingsChangesInput {
  readonly originalInstruction: string;
  readonly cmsProvider: CmsId;
  readonly siteId: string;
  readonly changes: readonly {
    readonly categoryId: string;
    readonly fieldId?: string;
    readonly fieldLabel: string;
    readonly proposedValue: PlannedValue;
    readonly valueType: PlannedValueType;
  }[];
}
