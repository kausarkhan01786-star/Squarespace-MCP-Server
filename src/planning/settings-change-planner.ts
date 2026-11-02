import { randomUUID } from "node:crypto";
import {
  type CapabilityStatus,
  type CmsId,
  type ExecutionMechanism,
  type HumanApprovalRequirement,
  type RecoveryStrategy,
} from "../capabilities/capability-types.js";
import {
  capabilityRegistry,
  type CapabilityRegistry,
} from "../capabilities/capability-registry.js";
import { parseSettingsChangeInstruction } from "./settings-change-parser.js";
import type {
  AnalyzeSettingsChangeRequestInput,
  ChangeRiskLevel,
  ParsedSettingsChangeIntent,
  PlannedSettingsChange,
  PlannedValue,
  PlannedValueType,
  PreviewSettingsChangesInput,
  SettingsChangeEvidence,
  SettingsChangePlan,
  SettingsChangePlanStatus,
  SettingsChangeStatus,
  SettingsPlanningField,
  SettingsPlanningInspection,
  SettingsPlanningProvider,
  SettingsRiskAssessment,
} from "./settings-change-types.js";

const UNKNOWN_CAPABILITY_STATUS: CapabilityStatus = "UNKNOWN_NEEDS_INVESTIGATION";
const UNKNOWN_MECHANISM: ExecutionMechanism = "unknown";
const UNKNOWN_APPROVAL: HumanApprovalRequirement = "unavailable";
const NO_RECOVERY: RecoveryStrategy = "none";
const AVAILABLE_CURRENT_STATUSES = new Set(["AVAILABLE", "EMPTY"]);

interface ResolvedSite {
  provider: SettingsPlanningProvider | null;
  siteId: string | null;
  clarificationQuestions: string[];
  warnings: string[];
}

export class SettingsChangePlanner {
  private readonly plans = new Map<string, SettingsChangePlan>();

  constructor(
    private readonly providers: ReadonlyMap<CmsId, SettingsPlanningProvider>,
    private readonly registry: CapabilityRegistry = capabilityRegistry,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async analyzeSettingsChangeRequest(
    input: AnalyzeSettingsChangeRequestInput,
  ): Promise<SettingsChangePlan> {
    const intents = parseSettingsChangeInstruction(input.instruction);
    return this.createPlan(
      input.instruction,
      input.cmsProvider,
      input.siteId,
      intents,
    );
  }

  async previewSettingsChanges(
    input: PreviewSettingsChangesInput,
  ): Promise<SettingsChangePlan> {
    const intents: ParsedSettingsChangeIntent[] = input.changes.map((change) => ({
      categoryId: change.categoryId,
      fieldId: change.fieldId ?? null,
      fieldLabel: change.fieldLabel,
      proposedValue: change.proposedValue,
      valueType: change.valueType,
      operation: "update",
      confidence: 1,
      status: "RESOLVED",
      warnings: ["Target identity and current value must still be verified through read-only inspection."],
    }));
    return this.createPlan(
      input.originalInstruction,
      input.cmsProvider,
      input.siteId,
      intents,
    );
  }

  getSettingsChangePlan(planId: string): SettingsChangePlan | undefined {
    return this.plans.get(planId);
  }

  private async createPlan(
    originalInstruction: string,
    cmsProvider: CmsId | undefined,
    siteId: string | undefined,
    intents: readonly ParsedSettingsChangeIntent[],
  ): Promise<SettingsChangePlan> {
    const planId = this.createId();
    const clarificationQuestions: string[] = [];
    const warnings: string[] = [];
    const changes: PlannedSettingsChange[] = [];
    const evidence: SettingsChangeEvidence[] = [];
    const resolved = await this.resolveSite(cmsProvider, siteId);
    clarificationQuestions.push(...resolved.clarificationQuestions);
    warnings.push(...resolved.warnings);

    for (const intent of intents) {
      if (intent.status !== "RESOLVED" || !resolved.provider || !resolved.siteId) {
        if (intent.clarification) clarificationQuestions.push(intent.clarification);
        const change = this.unresolvedChange(
          intent,
          resolved.provider?.cms ?? cmsProvider ?? null,
          resolved.siteId ?? siteId ?? null,
          resolved.provider
            ? "The instruction did not identify a settings category and field."
            : "No provider and site were resolved; no settings were inspected.",
        );
        changes.push(change);
        if (change.evidence) evidence.push(change.evidence);
        continue;
      }

      const change = await this.planIntent(
        planId,
        resolved.provider,
        resolved.siteId,
        intent,
      );
      changes.push(change);
      if (change.evidence) evidence.push(change.evidence);
      clarificationQuestions.push(...change.warnings.filter((warning) =>
        warning.startsWith("Clarification required:")));
    }

    const uniqueClarifications = unique(clarificationQuestions);
    const uniqueWarnings = unique([
      ...warnings,
      ...intents.flatMap((intent) => intent.warnings),
      ...changes.flatMap((change) => change.warnings),
    ]);
    const requiredPermissions = unique(changes.flatMap((change) =>
      change.requiredPermissions));
    const approvalRequirements = unique(changes
      .filter((change) => change.status !== "NO_CHANGE_REQUIRED")
      .map((change) =>
      change.capabilityCheck.approvalPolicy === "required"
        ? "Trusted human approval is required by the registered capability policy."
        : change.capabilityCheck.approvalPolicy === "policy_based"
          ? "A matching authorization policy is required by the registered capability policy."
          : change.capabilityCheck.approvalPolicy === "never"
            ? "The registered capability policy does not require execution approval; this planner still does not execute changes."
            : "No compatible approval policy is registered."));
    const riskAssessment = aggregateRisk(changes);
    const blockedReasons = unique(changes.flatMap((change) =>
      change.blockedReasons));
    const status = overallStatus(changes, uniqueClarifications);
    const plan: SettingsChangePlan = deepFreeze({
      planId,
      originalInstruction,
      cmsProvider: resolved.provider?.cms ?? cmsProvider ?? null,
      siteId: resolved.siteId ?? siteId ?? null,
      status,
      changes,
      parsedIntents: intents,
      clarificationQuestions: uniqueClarifications,
      currentSettingsEvidence: evidence,
      riskAssessment,
      requiredPermissions,
      approvalRequirements,
      blockedReasons,
      warnings: uniqueWarnings,
      createdAt: this.now().toISOString(),
      executionEnabled: false,
      limitations: [
        "This planner only constructs proposals and cannot execute CMS mutations.",
        "A plan marked READY_FOR_APPROVAL is not an approval and does not authorize or execute a change.",
        "Live CMS compatibility depends on provider-specific read and write implementations; fixtures do not establish live support.",
      ],
    });
    this.plans.set(planId, plan);
    return plan;
  }

  private async resolveSite(
    cmsProvider: CmsId | undefined,
    siteId: string | undefined,
  ): Promise<ResolvedSite> {
    if (cmsProvider && !this.providers.has(cmsProvider)) {
      return {
        provider: null,
        siteId: siteId ?? null,
        clarificationQuestions: [
          `No read-only settings provider is configured for ${cmsProvider}.`,
        ],
        warnings: ["No provider was selected as a fallback."],
      };
    }
    const candidates = cmsProvider
      ? [[cmsProvider, this.providers.get(cmsProvider)!] as const]
      : [...this.providers.entries()];
    const discovered: Array<{
      provider: SettingsPlanningProvider;
      site: { id: string; name: string };
    }> = [];
    const warnings: string[] = [];
    for (const [, provider] of candidates) {
      try {
        const sites = await provider.listSites();
        for (const site of sites) {
          if (!siteId || site.id === siteId) discovered.push({ provider, site });
        }
      } catch {
        warnings.push(`Site inventory for ${provider.cms} could not be verified.`);
      }
    }

    if (siteId) {
      if (discovered.length === 1) {
        const resolved = discovered[0]!;
        return {
          provider: resolved.provider,
          siteId: resolved.site.id,
          clarificationQuestions: [],
          warnings,
        };
      }
      const question = discovered.length > 1
        ? "The site ID matches more than one connected CMS provider; specify the CMS provider."
        : "The requested site ID was not found in the selected provider's current site inventory.";
      return {
        provider: null,
        siteId: null,
        clarificationQuestions: [question],
        warnings,
      };
    }

    if (discovered.length === 1) {
      const resolved = discovered[0]!;
      return {
        provider: resolved.provider,
        siteId: resolved.site.id,
        clarificationQuestions: [],
        warnings,
      };
    }
    if (discovered.length > 1) {
      return {
        provider: null,
        siteId: null,
        clarificationQuestions: [
          "Multiple sites are available; provide the exact site ID before planning a change.",
        ],
        warnings,
      };
    }
    const question = candidates.length === 0
      ? `No read-only settings provider is configured for ${cmsProvider ?? "the requested CMS"}.`
      : "No connected site was resolved; provide a site ID after connecting a provider.";
    return {
      provider: null,
      siteId: null,
      clarificationQuestions: [question],
      warnings,
    };
  }

  private async planIntent(
    planId: string,
    provider: SettingsPlanningProvider,
    siteId: string,
    intent: ParsedSettingsChangeIntent,
  ): Promise<PlannedSettingsChange> {
    const baseId = `${planId}:${provider.cms}:${siteId}:${intent.categoryId ?? "unknown"}:${intent.fieldLabel}`;
    const categoryId = intent.categoryId;
    if (!categoryId) {
      return this.unresolvedChange(
        intent,
        provider.cms,
        siteId,
        "The category is not known; the planner will not search unrelated settings categories or guess a target.",
        baseId,
      );
    }

    let inspection: Awaited<ReturnType<SettingsPlanningProvider["inspectCategory"]>>;
    try {
      inspection = await provider.inspectCategory(siteId, categoryId);
    } catch {
      inspection = {
        status: "ERROR",
        fields: [],
        source: "settings_inspection",
        limitations: ["Read-only inspection failed; no current value was assumed."],
        errors: ["INSPECTION_FAILED"],
      };
    }
    const inspectionLimitations = unique([
      ...inspection.limitations,
      ...(inspection.errors.length > 0
        ? [`Read-only settings inspection reported ${inspection.errors.length} error(s).`]
        : []),
    ]);

    const inspectionAllowsValues = ![
      "ACCESS_DENIED",
      "ERROR",
      "NOT_AVAILABLE",
    ].includes(inspection.status);
    const match = inspectionAllowsValues
      ? inspection.fields.find((field) =>
      intent.fieldId
        ? field.fieldId === intent.fieldId
        : normalize(field.fieldLabel) === normalize(intent.fieldLabel))
      : undefined;
    let currentField = match;
    let knownFieldInspectionError = false;
    if (
      inspection.status !== "ACCESS_DENIED" &&
      inspection.status !== "ERROR" &&
      inspection.status !== "NOT_AVAILABLE" &&
      !intent.fieldId &&
      !currentField &&
      provider.inspectKnownField
    ) {
      try {
        currentField = await provider.inspectKnownField(
          siteId,
          categoryId,
          intent.fieldLabel,
        ) ?? undefined;
      } catch {
        currentField = undefined;
        knownFieldInspectionError = true;
      }
    }

    if (!currentField) {
      const evidence = evidenceFor(
        categoryId,
        intent,
        null,
        inspection.source,
        statusForMissingField(inspection.status),
      );
      const capability = await this.capabilityCheck(provider, categoryId, null, siteId);
      const reasons = knownFieldInspectionError
        ? ["The provider's targeted read-only inspection failed."]
        : inspection.status === "ACCESS_DENIED"
          ? ["Access to the requested settings category is denied."]
          : inspection.status === "ERROR"
            ? ["The settings inspection returned an error."]
            : inspection.status === "NOT_AVAILABLE"
              ? ["The provider does not expose this settings category for inspection."]
              : [`No inspected field exactly matched "${intent.fieldLabel}".`];
      return this.createChange(
        baseId,
        provider.cms,
        siteId,
        intent,
        null,
        evidence,
        capability,
        reasons,
        inspectionLimitations,
        inspection.status === "ACCESS_DENIED" ||
          inspection.status === "ERROR" ||
          knownFieldInspectionError
          ? "BLOCKED"
          : "NEEDS_INVESTIGATION",
      );
    }

    const evidence = evidenceFor(categoryId, intent, currentField, inspection.source);
    const capability = await this.capabilityCheck(provider, categoryId, currentField, siteId);
    const sensitiveTarget = currentField.isSensitive ||
      isSensitiveTarget(categoryId, currentField.fieldLabel);
    const comparison = sensitiveTarget
      ? {
        fieldLabel: currentField.fieldLabel,
        currentValue: null,
        proposedValue: intent.proposedValue,
        changeRequired: null,
        status: "UNAVAILABLE" as const,
      }
      : compareValues(currentField, intent.proposedValue, intent.valueType);
    const risk = assessChangeRisk(categoryId, currentField, capability, comparison);
    const reasons: string[] = [];
    if (currentField.isSensitive || isSensitiveTarget(categoryId, currentField.fieldLabel)) {
      reasons.push("Sensitive settings cannot be planned for change without provider-specific investigation.");
    }
    if (currentField.valueStatus !== "AVAILABLE" && currentField.valueStatus !== "EMPTY") {
      reasons.push(`The current field value is ${currentField.valueStatus}; no before/after comparison is safe.`);
    }
    if (currentField.inspectionConfidence < 0.7) {
      reasons.push("Current-state inspection confidence is below the planning threshold.");
    }
    if (comparison.status === "UNAVAILABLE") {
      reasons.push(`The proposed ${intent.valueType} value does not match the inspected field's ${currentField.valueType} type or validation evidence.`);
    }
    reasons.push(...capability.reasons);

    let status: SettingsChangeStatus;
    if (
      comparison.status === "NO_CHANGE_REQUIRED" &&
      currentField.valueStatus !== "UNKNOWN" &&
      currentField.inspectionConfidence >= 0.7 &&
      !sensitiveTarget
    ) {
      status = "NO_CHANGE_REQUIRED";
    } else if (capability.capabilityStatus === "UNKNOWN_NEEDS_INVESTIGATION" ||
      capability.operationStatus === "UNKNOWN_NEEDS_INVESTIGATION") {
      status = "NEEDS_INVESTIGATION";
    } else if (
      capability.capabilityStatus === "UNSUPPORTED_OR_RESTRICTED" ||
      capability.operationStatus === "UNSUPPORTED_OR_RESTRICTED"
    ) {
      status = "UNSUPPORTED";
    } else if (
      sensitiveTarget ||
      reasons.some((reason) => /sensitive/i.test(reason))
    ) {
      status = "BLOCKED";
    } else if (reasons.length === 0) {
      status = "READY_FOR_APPROVAL";
    } else if (
      currentField.valueStatus === "UNKNOWN" ||
      currentField.valueStatus === "ERROR"
    ) {
      status = "NEEDS_INVESTIGATION";
    } else {
      status = "BLOCKED";
    }

    return this.createChange(
      baseId,
      provider.cms,
      siteId,
      intent,
      currentField,
      evidence,
      capability,
      status === "NO_CHANGE_REQUIRED" ? [] : reasons,
      [...inspectionLimitations, ...currentField.limitations],
      status,
      risk,
      comparison,
    );
  }

  private async capabilityCheck(
    provider: SettingsPlanningProvider,
    categoryId: string,
    currentField: SettingsPlanningField | null,
    siteId: string,
  ): Promise<PlannedSettingsChange["capabilityCheck"]> {
    const capabilityId = provider.capabilityIdForCategory(categoryId) ?? null;
    const capability = capabilityId
      ? this.registry.getCapability(provider.cms, capabilityId)
      : undefined;
    const operation = capability?.operations.update;
    const capabilityStatus = capability?.status ?? UNKNOWN_CAPABILITY_STATUS;
    const operationStatus = operation?.status ?? null;
    const requiredPermissions = operation?.permissions ?? [];
    const reasons: string[] = [];
    if (!capabilityId || !capability) {
      reasons.push("No audited capability is registered for the requested category.");
    } else if (capability.status === "UNKNOWN_NEEDS_INVESTIGATION") {
      reasons.push("The provider capability has not been audited.");
    } else if (capability.status === "UNSUPPORTED_OR_RESTRICTED") {
      reasons.push("The provider capability is unsupported or restricted.");
    }
    if (!operation) {
      reasons.push("No update operation is registered for this capability.");
    } else if (operation.status !== "IMPLEMENTED_AND_TESTED") {
      reasons.push(`The update operation is ${operation.status}; it is not supported for execution.`);
    }
    if (!operation || operation.mechanism === "unknown" || operation.toolNames.length === 0) {
      reasons.push("No registered update tool and known execution mechanism are available.");
    }
    if (!operation || operation.permissions.length === 0) {
      reasons.push("Required update permissions are not defined.");
    } else if (!provider.getGrantedPermissions) {
      reasons.push("The provider cannot verify which required permissions are currently granted.");
    }
    if (!operation || operation.verificationRequirements.length === 0) {
      reasons.push("Update verification requirements are not defined.");
    }
    if (!operation || operation.humanApproval === "unavailable") {
      reasons.push("The registered approval policy is unavailable or incompatible.");
    } else if (operation.humanApproval === "never") {
      reasons.push("The registered update policy does not require human approval and is incompatible with proposal readiness.");
    }

    let missingPermissions: string[] = [];
    let permissionStatus: PlannedSettingsChange["capabilityCheck"]["permissionStatus"] =
      "UNKNOWN";
    if (operation?.permissions.length && provider.getGrantedPermissions) {
      try {
        const granted = await provider.getGrantedPermissions(siteId);
        if (granted !== null) {
          const grantedSet = new Set(granted);
          missingPermissions = operation.permissions.filter((permission) =>
            !grantedSet.has(permission));
          permissionStatus = missingPermissions.length === 0 ? "KNOWN" : "MISSING";
          if (missingPermissions.length > 0) {
            reasons.push(`Missing required permission(s): ${missingPermissions.join(", ")}.`);
          }
        } else {
          reasons.push("Granted permissions are unknown.");
        }
      } catch {
        reasons.push("Granted permissions could not be verified.");
      }
    }
    const currentValueVerified = currentField !== null &&
      AVAILABLE_CURRENT_STATUSES.has(currentField.valueStatus) &&
      currentField.inspectionConfidence >= 0.7;
    if (!currentValueVerified) {
      reasons.push("Current setting state is not sufficiently verified.");
    }

    return {
      capabilityId,
      capabilityStatus,
      operationStatus,
      executionMechanism: operation?.mechanism ?? UNKNOWN_MECHANISM,
      registeredTools: operation?.toolNames ?? [],
      requiredPermissions,
      missingPermissions,
      permissionStatus,
      approvalPolicy: operation?.humanApproval ?? UNKNOWN_APPROVAL,
      verificationRequirements: operation?.verificationRequirements ?? [],
      recoveryStrategy: operation?.recoveryStrategy ?? NO_RECOVERY,
      eligibleForExecution: false,
      reasons: unique(reasons),
    };
  }

  private createChange(
    changeId: string,
    cmsProvider: CmsId,
    siteId: string,
    intent: ParsedSettingsChangeIntent,
    currentField: SettingsPlanningField | null,
    evidence: SettingsChangeEvidence,
    capabilityCheck: PlannedSettingsChange["capabilityCheck"],
    blockedReasons: readonly string[],
    limitations: readonly string[],
    status: SettingsChangeStatus,
    riskAssessment?: SettingsRiskAssessment,
    comparison?: PlannedSettingsChange["comparison"],
  ): PlannedSettingsChange {
    const actualComparison = comparison ?? {
      fieldLabel: intent.fieldLabel,
      currentValue: null,
      proposedValue: intent.proposedValue,
      changeRequired: null,
      status: "UNAVAILABLE" as const,
    };
    const actualRisk = riskAssessment ??
      assessChangeRisk(evidence.categoryId, currentField, capabilityCheck, actualComparison);
    return deepFreeze({
      changeId,
      cmsProvider,
      siteId,
      categoryId: evidence.categoryId,
      fieldId: currentField?.fieldId ?? intent.fieldId,
      fieldLabel: currentField?.fieldLabel ?? intent.fieldLabel,
      currentValue: AVAILABLE_CURRENT_STATUSES.has(evidence.currentValueStatus)
        ? evidence.currentValue
        : null,
      proposedValue: intent.proposedValue,
      valueType: currentField?.valueType ?? intent.valueType,
      changeType: "update",
      source: currentField?.source ?? evidence.source,
      inspectionConfidence: currentField?.inspectionConfidence ?? evidence.inspectionConfidence,
      riskLevel: actualRisk.riskLevel,
      requiredPermissions: capabilityCheck.requiredPermissions,
      executionMechanism: capabilityCheck.executionMechanism,
      capabilityStatus: capabilityCheck.capabilityStatus,
      approvalRequired: status !== "NO_CHANGE_REQUIRED",
      status,
      comparison: actualComparison,
      evidence,
      riskAssessment: actualRisk,
      capabilityCheck,
      limitations: unique(limitations),
      warnings: intent.warnings,
      blockedReasons: unique(blockedReasons),
    });
  }

  private unresolvedChange(
    intent: ParsedSettingsChangeIntent,
    cmsProvider: CmsId | null,
    siteId: string | null,
    reason: string,
    changeId = this.createId(),
    categoryId = intent.categoryId,
  ): PlannedSettingsChange {
    const resolvedCategory = categoryId ?? "unknown";
    const capabilityId = cmsProvider
      ? this.providers.get(cmsProvider)?.capabilityIdForCategory(resolvedCategory)
      : undefined;
    const capability = cmsProvider && capabilityId
      ? this.registry.getCapability(cmsProvider, capabilityId)
      : undefined;
    const operation = capability?.operations.update;
    const capabilityStatus = capability?.status ?? UNKNOWN_CAPABILITY_STATUS;
    const evidence: SettingsChangeEvidence = {
      categoryId: resolvedCategory,
      fieldId: intent.fieldId,
      fieldLabel: intent.fieldLabel,
      currentValue: null,
      currentValueStatus: "NOT_INSPECTED",
      valueType: intent.valueType,
      source: null,
      inspectionConfidence: 0,
      limitations: [reason],
    };
    const capabilityReasons = [
      reason,
      ...(operation
        ? [`The update operation status is ${operation.status}.`]
        : ["No provider update operation is registered."]),
    ];
    const riskAssessment = assessChangeRisk(
      resolvedCategory,
      null,
      {
        requiredPermissions: operation?.permissions ?? [],
        executionMechanism: operation?.mechanism ?? UNKNOWN_MECHANISM,
        verificationRequirements: operation?.verificationRequirements ?? [],
        recoveryStrategy: operation?.recoveryStrategy ?? NO_RECOVERY,
        operationStatus: operation?.status ?? null,
      },
      {
        fieldLabel: intent.fieldLabel,
        currentValue: null,
        proposedValue: intent.proposedValue,
        changeRequired: null,
        status: "UNAVAILABLE",
      },
    );
    const status: SettingsChangeStatus =
      capabilityStatus === "UNKNOWN_NEEDS_INVESTIGATION" ||
        operation?.status === "UNKNOWN_NEEDS_INVESTIGATION"
        ? "NEEDS_INVESTIGATION"
        : capabilityStatus === "UNSUPPORTED_OR_RESTRICTED" ||
            operation?.status === "UNSUPPORTED_OR_RESTRICTED"
          ? "UNSUPPORTED"
          : "BLOCKED";
    return deepFreeze({
      changeId,
      cmsProvider,
      siteId,
      categoryId: intent.categoryId,
      fieldId: intent.fieldId,
      fieldLabel: intent.fieldLabel,
      currentValue: null,
      proposedValue: intent.proposedValue,
      valueType: intent.valueType,
      changeType: "update",
      source: null,
      inspectionConfidence: 0,
      riskLevel: riskAssessment.riskLevel,
      requiredPermissions: operation?.permissions ?? [],
      executionMechanism: operation?.mechanism ?? UNKNOWN_MECHANISM,
      capabilityStatus,
      approvalRequired: true,
      status,
      comparison: {
        fieldLabel: intent.fieldLabel,
        currentValue: null,
        proposedValue: intent.proposedValue,
        changeRequired: null,
        status: "UNAVAILABLE",
      },
      evidence,
      riskAssessment,
      capabilityCheck: {
        capabilityId: capabilityId ?? null,
        capabilityStatus,
        operationStatus: operation?.status ?? null,
        executionMechanism: operation?.mechanism ?? UNKNOWN_MECHANISM,
        registeredTools: operation?.toolNames ?? [],
        requiredPermissions: operation?.permissions ?? [],
        missingPermissions: [],
        permissionStatus: "UNKNOWN",
        approvalPolicy: operation?.humanApproval ?? UNKNOWN_APPROVAL,
        verificationRequirements: operation?.verificationRequirements ?? [],
        recoveryStrategy: operation?.recoveryStrategy ?? NO_RECOVERY,
        eligibleForExecution: false,
        reasons: unique(capabilityReasons),
      },
      limitations: [reason],
      warnings: intent.warnings,
      blockedReasons: unique(capabilityReasons),
    });
  }
}

function evidenceFor(
  categoryId: string,
  intent: ParsedSettingsChangeIntent,
  field: SettingsPlanningField | null,
  source: string,
  missingValueStatus: SettingsChangeEvidence["currentValueStatus"] = "NOT_INSPECTED",
): SettingsChangeEvidence {
  return {
    categoryId,
    fieldId: field?.fieldId ?? intent.fieldId,
    fieldLabel: field?.fieldLabel ?? intent.fieldLabel,
    currentValue: field &&
      AVAILABLE_CURRENT_STATUSES.has(field.valueStatus) &&
      !field.isSensitive &&
      !isSensitiveTarget(categoryId, field.fieldLabel)
      ? field.currentValue
      : null,
    currentValueStatus: field?.valueStatus ?? missingValueStatus,
    valueType: field?.valueType ?? intent.valueType,
    source: field?.source ?? source,
    inspectionConfidence: field?.inspectionConfidence ?? 0,
    limitations: field?.limitations ?? ["The target field was not found in inspection results."],
  };
}

function compareValues(
  field: SettingsPlanningField,
  proposedValue: PlannedValue,
  proposedType: PlannedValueType,
): PlannedSettingsChange["comparison"] {
  if (!AVAILABLE_CURRENT_STATUSES.has(field.valueStatus)) {
    return {
      fieldLabel: field.fieldLabel,
      currentValue: null,
      proposedValue,
      changeRequired: null,
      status: "UNAVAILABLE",
    };
  }
  if (!isTypeCompatible(field, proposedValue, proposedType)) {
    return {
      fieldLabel: field.fieldLabel,
      currentValue: field.currentValue,
      proposedValue,
      changeRequired: null,
      status: "UNAVAILABLE",
    };
  }
  const same = valuesEqual(field.currentValue, proposedValue);
  return {
    fieldLabel: field.fieldLabel,
    currentValue: field.currentValue,
    proposedValue,
    changeRequired: !same,
    status: same ? "NO_CHANGE_REQUIRED" : "COMPARABLE",
  };
}

function isTypeCompatible(
  field: SettingsPlanningField,
  value: PlannedValue,
  requestedType: PlannedValueType,
): boolean {
  if (requestedType === "unknown" || requestedType !== field.valueType) return false;
  switch (field.valueType) {
    case "string":
    case "enum":
    case "url":
      if (typeof value !== "string") return false;
      if (field.valueType === "url") {
        try {
          const parsed = new URL(value);
          if (
            !["http:", "https:"].includes(parsed.protocol) ||
            parsed.username ||
            parsed.password ||
            parsed.search ||
            parsed.hash
          ) return false;
        } catch {
          return false;
        }
      }
      if (field.valueType === "enum") {
        return field.allowedValues?.some((candidate) => valuesEqual(candidate, value)) === true;
      }
      return true;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string_list":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "object":
      return value !== null && typeof value === "object";
  }
}

function assessChangeRisk(
  categoryId: string,
  field: SettingsPlanningField | null,
  capability: {
    readonly requiredPermissions: readonly string[];
    readonly executionMechanism: ExecutionMechanism;
    readonly verificationRequirements: readonly string[];
    readonly recoveryStrategy: RecoveryStrategy;
    readonly operationStatus: CapabilityStatus | null;
  },
  comparison: PlannedSettingsChange["comparison"],
): SettingsRiskAssessment {
  const factors: string[] = [];
  const sensitive = field?.isSensitive === true ||
    isSensitiveTarget(categoryId, field?.fieldLabel ?? "");
  if (sensitive) {
    factors.push("Sensitive account, payment, ownership, or credential data is involved.");
  }
  if (["billing", "permissions_ownership"].includes(categoryId)) {
    factors.push("The category can affect billing, permissions, or ownership.");
  }
  if (categoryId === "selling" || categoryId === "commerce") {
    factors.push("The change may affect commerce or payments.");
  }
  if ([
    "domains_email",
    "marketing",
    "developer_tools",
    "seo",
    "brand",
    "navigation",
    "extensions",
    "third_party_tools",
    "customer_notifications",
  ].includes(categoryId)) {
    factors.push("The change may affect public visibility, customer communications, or external integrations.");
  }
  if (categoryId === "website") {
    factors.push("Website-level settings may affect the entire site.");
  }
  if (
    comparison.status === "UNAVAILABLE" ||
    !field ||
    !AVAILABLE_CURRENT_STATUSES.has(field.valueStatus) ||
    field.inspectionConfidence < 0.7
  ) {
    factors.push("The current value or requested value has not been verified for comparison.");
  }
  if (capability.operationStatus !== "IMPLEMENTED_AND_TESTED") {
    factors.push("The provider update capability is not implemented and tested.");
  }
  if (capability.executionMechanism === "unknown") {
    factors.push("The future execution mechanism is unknown.");
  }
  if (capability.verificationRequirements.length === 0) {
    factors.push("No post-change verification requirements are registered.");
  }
  if (capability.recoveryStrategy === "none") {
    factors.push("No provider rollback or recovery strategy is registered.");
  }
  if (sensitive || ["billing", "permissions_ownership", "selling", "commerce"].includes(categoryId)) {
    return { riskLevel: "CRITICAL", factors };
  }
  if ([
    "domains_email",
    "marketing",
    "developer_tools",
    "seo",
    "website",
    "brand",
    "navigation",
    "extensions",
    "third_party_tools",
    "customer_notifications",
  ].includes(categoryId)) {
    return { riskLevel: "HIGH", factors };
  }
  if (factors.some((factor) => /not verified|unknown|not implemented/i.test(factor))) {
    return { riskLevel: "UNKNOWN", factors };
  }
  if (capability.recoveryStrategy === "none") return { riskLevel: "MEDIUM", factors };
  return {
    riskLevel: "LOW",
    factors: factors.length > 0 ? factors : ["No elevated risk factor identified."],
  };
}

function statusForMissingField(
  status: SettingsPlanningInspection["status"],
): SettingsChangeEvidence["currentValueStatus"] {
  switch (status) {
    case "ACCESS_DENIED":
      return "ACCESS_DENIED";
    case "ERROR":
      return "ERROR";
    case "NOT_AVAILABLE":
      return "UNSUPPORTED";
    case "AVAILABLE":
    case "PARTIALLY_AVAILABLE":
    case "UNKNOWN":
      return "UNKNOWN";
  }
}

function isSensitiveTarget(categoryId: string, fieldLabel: string): boolean {
  return ["billing", "permissions_ownership"].includes(categoryId) ||
    /password|secret|token|api[\s_-]*key|credential|cookie|payment|credit card|bank|owner|personal|email|phone|address/i
      .test(fieldLabel);
}

function overallStatus(
  changes: readonly PlannedSettingsChange[],
  clarifications: readonly string[],
): SettingsChangePlanStatus {
  if (changes.length === 0) return "NEEDS_CLARIFICATION";
  if (changes.every((change) => change.status === "NO_CHANGE_REQUIRED")) {
    return "NO_CHANGE_REQUIRED";
  }
  if (changes.every((change) => change.status === "READY_FOR_APPROVAL")) {
    return "READY_FOR_APPROVAL";
  }
  if (new Set(changes.map((change) => change.status)).size > 1) return "PARTIAL";
  if (clarifications.length > 0 && changes.every((change) =>
    change.status === "NEEDS_INVESTIGATION" || change.status === "BLOCKED")) {
    return "NEEDS_CLARIFICATION";
  }
  if (changes.some((change) => change.status === "READY_FOR_APPROVAL" ||
    change.status === "NO_CHANGE_REQUIRED")) {
    return "PARTIAL";
  }
  if (changes.every((change) => change.status === "UNSUPPORTED")) return "UNSUPPORTED";
  if (changes.some((change) => change.status === "NEEDS_INVESTIGATION")) {
    return "NEEDS_INVESTIGATION";
  }
  if (changes.some((change) => change.status === "UNSUPPORTED")) return "UNSUPPORTED";
  return "BLOCKED";
}

function aggregateRisk(changes: readonly PlannedSettingsChange[]): SettingsRiskAssessment {
  const rank: Record<ChangeRiskLevel, number> = {
    LOW: 0,
    MEDIUM: 1,
    UNKNOWN: 2,
    HIGH: 3,
    CRITICAL: 4,
  };
  const highest = changes.reduce<ChangeRiskLevel>((current, change) =>
    rank[change.riskLevel] > rank[current] ? change.riskLevel : current, "LOW");
  return {
    riskLevel: changes.length === 0 ? "UNKNOWN" : highest,
    factors: unique(changes.flatMap((change) => change.riskAssessment.factors)),
  };
}

function valuesEqual(left: PlannedValue, right: PlannedValue): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]!));
  }
  const leftRecord = left as Readonly<Record<string, PlannedValue>>;
  const rightRecord = right as Readonly<Record<string, PlannedValue>>;
  const keys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return keys.length === Object.keys(rightRecord).length &&
    keys.every((key, index) =>
      key === rightKeys[index] &&
      valuesEqual(leftRecord[key]!, rightRecord[key]!));
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
