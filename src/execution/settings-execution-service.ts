import { createHash, randomUUID } from "node:crypto";
import {
  type CapabilityStatus,
  type CmsId,
  type ExecutionMechanism,
  type RecoveryStrategy,
} from "../capabilities/capability-types.js";
import {
  capabilityRegistry,
  type CapabilityRegistry,
} from "../capabilities/capability-registry.js";
import {
  MutationApprovalError,
  MutationApprovalGuard,
} from "../approval/mutation-approval.js";
import type {
  PlannedValue,
  SettingsChangePlan,
  SettingsPlanningField,
} from "../planning/settings-change-types.js";
import type {
  ExecuteApprovedSettingsChangeInput,
  SettingsApprovalStatus,
  SettingsExecutionCapabilitySummary,
  SettingsExecutionPlanLookup,
  SettingsExecutionProvider,
  SettingsExecutionResult,
  SettingsExecutionStatusReport,
  SettingsRecoveryStatus,
  SettingsVerificationStatus,
} from "./settings-execution-types.js";

const AVAILABLE_VALUE_STATUSES = new Set(["AVAILABLE", "EMPTY"]);
const SETTINGS_UPDATE_SCOPE = "settings.update" as const;
const SETTINGS_UPDATE_ACTION = "settings.update";
const DEFAULT_UPDATE_TIMEOUT_MS = 30_000;

class SettingsUpdateTimeoutError extends Error {
  constructor() {
    super("Settings provider update timed out.");
    this.name = "SettingsUpdateTimeoutError";
  }
}

interface ExecutionServiceOptions {
  readonly planner: SettingsExecutionPlanLookup;
  readonly providers: ReadonlyMap<CmsId, SettingsExecutionProvider>;
  readonly approval: MutationApprovalGuard;
  readonly registry?: CapabilityRegistry;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly updateTimeoutMs?: number;
}

interface ChangeTarget {
  readonly planId: string;
  readonly changeId: string;
  readonly cmsProvider: CmsId | null;
  readonly siteId: string | null;
  readonly categoryId: string | null;
  readonly fieldId: string | null;
}

export class SettingsExecutionService {
  private readonly records = new Map<string, SettingsExecutionResult>();
  private readonly inFlight = new Set<string>();
  private readonly mutationStarted = new Set<string>();
  private readonly uncertainTargets = new Set<string>();
  private readonly registry: CapabilityRegistry;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly updateTimeoutMs: number;

  constructor(private readonly options: ExecutionServiceOptions) {
    this.registry = options.registry ?? capabilityRegistry;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.updateTimeoutMs = options.updateTimeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.updateTimeoutMs) || this.updateTimeoutMs <= 0) {
      throw new RangeError("updateTimeoutMs must be a positive safe integer.");
    }
  }

  getSettingsExecutionStatus(cmsProvider: CmsId): SettingsExecutionStatusReport {
    const executionProviderConfigured = this.options.providers.has(cmsProvider);
    const capabilities = this.registry.getCapabilitiesForCms(cmsProvider)
      .filter((capability) => capability.operations.update !== undefined)
      .map((capability): SettingsExecutionCapabilitySummary => {
        const operation = capability.operations.update;
        const reasons: string[] = [];
        if (!executionProviderConfigured) {
          reasons.push("No settings execution provider is configured for this CMS.");
        }
        if (!operation || operation.status !== "IMPLEMENTED_AND_TESTED") {
          reasons.push(
            `The registered update capability is ${operation?.status ?? "NOT_REGISTERED"}.`,
          );
        }
        if (!operation || operation.toolNames.length === 0) {
          reasons.push("No settings mutation tool is registered.");
        }
        if (operation?.mechanism === "unknown") {
          reasons.push("The update mechanism has not been verified.");
        }
        return {
          capabilityId: capability.id,
          status: capability.status,
          updateStatus: operation?.status ?? null,
          mechanism: operation?.mechanism ?? null,
          recoveryStrategy: operation?.recoveryStrategy ?? null,
          executable: false,
          reasons,
        };
      });
    return deepFreeze({
      cmsProvider,
      executionProviderConfigured,
      mutationToolExposed: false,
      capabilities,
      limitations: [
        "No functional settings mutation MCP tool is exposed.",
        "Registry status and fixture tests alone do not prove live CMS write compatibility.",
        "Recovery is not attempted unless a provider-specific recovery operation is implemented and verified.",
      ],
    });
  }

  getSettingsExecutionResult(
    executionId: string,
  ): SettingsExecutionResult | undefined {
    return this.records.get(executionId);
  }

  async executeApprovedSettingsChange(
    input: ExecuteApprovedSettingsChangeInput,
  ): Promise<SettingsExecutionResult> {
    const executionId = this.createId();
    const plan = this.options.planner.getSettingsChangePlan(input.planId);
    const change = plan?.changes.find((candidate) =>
      candidate.changeId === input.changeId);
    const target = targetFor(input.planId, plan, change);

    if (!plan || !change) {
      return this.record({
        executionId,
        target,
        status: "BLOCKED",
        reasonCodes: ["PLAN_OR_CHANGE_NOT_FOUND"],
      });
    }

    if (
      plan.cmsProvider &&
      plan.siteId &&
      change.categoryId &&
      change.fieldId &&
      this.uncertainTargets.has(settingTargetKey(
        plan.cmsProvider,
        plan.siteId,
        change.categoryId,
        change.fieldId,
      ))
    ) {
      return this.record({
        executionId,
        target,
        status: "BLOCKED",
        reasonCodes: ["TARGET_OUTCOME_UNCERTAIN_PROVIDER_STILL_RUNNING"],
      });
    }

    const attemptKey = `${plan.planId}:${change.changeId}`;
    if (this.inFlight.has(attemptKey)) {
      return this.record({
        executionId,
        target,
        status: "BLOCKED",
        reasonCodes: ["EXECUTION_ALREADY_IN_PROGRESS"],
      });
    }
    if (this.mutationStarted.has(attemptKey)) {
      return this.record({
        executionId,
        target,
        status: "BLOCKED",
        reasonCodes: ["MUTATION_ALREADY_ATTEMPTED"],
      });
    }

    this.inFlight.add(attemptKey);
    try {
      return await this.executePlanChange(executionId, plan, change, attemptKey);
    } finally {
      this.inFlight.delete(attemptKey);
    }
  }

  private async executePlanChange(
    executionId: string,
    plan: SettingsChangePlan,
    change: SettingsChangePlan["changes"][number],
    attemptKey: string,
  ): Promise<SettingsExecutionResult> {
    const target = targetFor(plan.planId, plan, change);
    let preExecutionSource: string | null = null;
    let preExecutionConfidence: number | null = null;
    const executionTargetKey = plan.cmsProvider && plan.siteId &&
        change.categoryId && change.fieldId
      ? settingTargetKey(
        plan.cmsProvider,
        plan.siteId,
        change.categoryId,
        change.fieldId,
      )
      : null;
    const blocked = (
      reasonCode: string,
      options: {
        readonly approvalStatus?: SettingsApprovalStatus;
        readonly proposalFingerprint?: string | null;
      } = {},
    ) => this.record({
      executionId,
      target,
      status: "BLOCKED",
      preExecutionSource,
      preExecutionConfidence,
      reasonCodes: [reasonCode],
      ...options,
    });

    if (
      plan.status !== "READY_FOR_APPROVAL" ||
      change.status !== "READY_FOR_APPROVAL" ||
      change.approvalRequired !== true ||
      change.comparison.status !== "COMPARABLE" ||
      change.comparison.changeRequired !== true
    ) {
      return blocked("PLAN_IS_NOT_A_READY_CHANGE");
    }
    if (
      !plan.cmsProvider ||
      !plan.siteId ||
      !change.categoryId ||
      !change.fieldId ||
      !change.evidence ||
      !AVAILABLE_VALUE_STATUSES.has(change.evidence.currentValueStatus) ||
      !valuesEqual(change.currentValue, change.comparison.currentValue) ||
      !valuesEqual(change.proposedValue, change.comparison.proposedValue) ||
      isSensitiveTarget(change.categoryId, change.fieldLabel)
    ) {
      return blocked("PLAN_TARGET_OR_CURRENT_VALUE_IS_UNSAFE");
    }

    const provider = this.options.providers.get(plan.cmsProvider);
    if (!provider || provider.cms !== plan.cmsProvider) {
      return blocked("EXECUTION_PROVIDER_NOT_CONFIGURED");
    }
    const capabilityId = provider.capabilityIdForCategory(change.categoryId);
    const capability = capabilityId
      ? this.registry.getCapability(plan.cmsProvider, capabilityId)
      : undefined;
    const operation = capability?.operations.update;
    if (
      !capability ||
      !operation ||
      change.capabilityCheck.capabilityId !== capabilityId ||
      operation.status !== "IMPLEMENTED_AND_TESTED"
    ) {
      return blocked("UPDATE_CAPABILITY_NOT_VERIFIED");
    }
    if (
      operation.mechanism === "unknown" ||
      operation.mechanism === "manual" ||
      operation.toolNames.length === 0
    ) {
      return blocked("UPDATE_MECHANISM_OR_TOOL_NOT_REGISTERED");
    }
    if (operation.humanApproval !== "required") {
      return blocked("EXPLICIT_HUMAN_APPROVAL_POLICY_NOT_REGISTERED");
    }
    if (
      operation.permissions.length === 0 ||
      operation.verificationRequirements.length === 0
    ) {
      return blocked("PERMISSIONS_OR_VERIFICATION_REQUIREMENTS_MISSING");
    }
    if (
      change.requiredPermissions.length !== operation.permissions.length ||
      !operation.permissions.every((permission) =>
        change.requiredPermissions.includes(permission))
    ) {
      return blocked("PLAN_PERMISSIONS_DO_NOT_MATCH_CURRENT_CAPABILITY");
    }

    let sites: Awaited<ReturnType<SettingsExecutionProvider["listSites"]>>;
    try {
      sites = await provider.listSites();
    } catch {
      return blocked("SITE_INVENTORY_UNAVAILABLE");
    }
    if (sites.filter((site) => site.id === plan.siteId).length !== 1) {
      return blocked("SITE_ID_NOT_VERIFIED");
    }

    if (!provider.getGrantedPermissions) {
      return blocked("GRANTED_PERMISSIONS_UNAVAILABLE");
    }
    let grantedPermissions: readonly string[] | null;
    try {
      grantedPermissions = await provider.getGrantedPermissions(plan.siteId);
    } catch {
      return blocked("GRANTED_PERMISSIONS_UNAVAILABLE");
    }
    if (grantedPermissions === null) {
      return blocked("GRANTED_PERMISSIONS_UNKNOWN");
    }
    const granted = new Set(grantedPermissions);
    if (operation.permissions.some((permission) => !granted.has(permission))) {
      return blocked("REQUIRED_PERMISSION_MISSING");
    }

    const expectedCurrentValue = change.currentValue;
    const currentInspection = await inspectExactField(
      provider,
      plan.siteId,
      change.categoryId,
      change.fieldId,
    );
    preExecutionSource = currentInspection.field?.source ?? null;
    preExecutionConfidence = currentInspection.field?.inspectionConfidence ?? null;
    if (currentInspection.error) {
      return blocked(currentInspection.error);
    }
    if (
      !currentInspection.field ||
      !isUsableField(currentInspection.field) ||
      !valuesEqual(currentInspection.field.currentValue, expectedCurrentValue)
    ) {
      return blocked("CURRENT_VALUE_STALE_OR_UNVERIFIED");
    }

    const planFingerprint = fingerprint({
      planId: plan.planId,
      changeId: change.changeId,
      cmsProvider: plan.cmsProvider,
      siteId: plan.siteId,
      categoryId: change.categoryId,
      fieldId: change.fieldId,
      fieldLabel: change.fieldLabel,
      currentValue: expectedCurrentValue,
      proposedValue: change.proposedValue,
      valueType: change.valueType,
    });
    const targetResource = `setting:${change.categoryId}:${change.fieldId}`;
    const proposalPayload = {
      planId: plan.planId,
      changeId: change.changeId,
      planFingerprint,
      categoryId: change.categoryId,
      fieldId: change.fieldId,
      fieldLabel: change.fieldLabel,
      valueType: change.valueType,
      currentValue: expectedCurrentValue,
      proposedValue: change.proposedValue,
    };

    let authorization;
    try {
      authorization = await this.options.approval.requestApproval({
        provider: plan.cmsProvider,
        websiteId: plan.siteId,
        action: SETTINGS_UPDATE_ACTION,
        targetResource,
        payload: proposalPayload,
        permissionScopes: [SETTINGS_UPDATE_SCOPE],
      });
    } catch (error) {
      const approvalStatus = error instanceof MutationApprovalError
        ? approvalStatusFor(error)
        : "UNAVAILABLE";
      return blocked("EXPLICIT_APPROVAL_NOT_GRANTED", {
        approvalStatus,
        proposalFingerprint: planFingerprint,
      });
    }

    const postApprovalSites = await verifySite(provider, plan.siteId);
    const postApprovalPermissions = await readPermissions(provider, plan.siteId);
    const postApprovalInspection = await inspectExactField(
      provider,
      plan.siteId,
      change.categoryId,
      change.fieldId,
    );
    if (
      !postApprovalSites ||
      postApprovalPermissions === null ||
      operation.permissions.some((permission) =>
        !postApprovalPermissions.includes(permission)) ||
      postApprovalInspection.error ||
      !postApprovalInspection.field ||
      !isUsableField(postApprovalInspection.field) ||
      !valuesEqual(postApprovalInspection.field.currentValue, expectedCurrentValue)
    ) {
      this.options.approval.revoke(authorization.receipt);
      return blocked("PRECONDITIONS_CHANGED_AFTER_APPROVAL", {
        approvalStatus: "ACCEPTED",
        proposalFingerprint: planFingerprint,
      });
    }

    const eligibility = this.registry.isOperationEligible(
      plan.cmsProvider,
      capabilityId,
      "update",
      {
        grantedPermissions: postApprovalPermissions,
        humanApprovalGranted: true,
        verificationCompleted: true,
      },
    );
    if (!eligibility.eligible) {
      this.options.approval.revoke(authorization.receipt);
      return blocked("CAPABILITY_NOT_ELIGIBLE_AFTER_APPROVAL", {
        approvalStatus: "ACCEPTED",
        proposalFingerprint: planFingerprint,
      });
    }

    let updateTimedOut = false;
    try {
      await this.options.approval.runAuthorized(
        authorization.proposal,
        authorization.receipt,
        async () => {
          this.options.approval.assertAuthorized({
            scope: SETTINGS_UPDATE_SCOPE,
            provider: plan.cmsProvider!,
            websiteId: plan.siteId!,
            action: SETTINGS_UPDATE_ACTION,
            targetResource,
            payload: proposalPayload,
          });
          this.mutationStarted.add(attemptKey);
          const controller = new AbortController();
          let timeout: NodeJS.Timeout | undefined;
          let providerOperation: Promise<void>;
          try {
            providerOperation = provider.updateField({
              siteId: plan.siteId!,
              categoryId: change.categoryId!,
              fieldId: change.fieldId!,
              expectedCurrentValue,
              proposedValue: change.proposedValue,
              valueType: change.valueType,
              signal: controller.signal,
            });
            void providerOperation.then(
              () => {
                if (updateTimedOut && executionTargetKey) {
                  this.uncertainTargets.delete(executionTargetKey);
                }
              },
              () => {
                if (updateTimedOut && executionTargetKey) {
                  this.uncertainTargets.delete(executionTargetKey);
                }
              },
            );
            await Promise.race([
              providerOperation,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                  updateTimedOut = true;
                  if (executionTargetKey) {
                    this.uncertainTargets.add(executionTargetKey);
                  }
                  const timeoutError = new SettingsUpdateTimeoutError();
                  controller.abort(timeoutError);
                  reject(timeoutError);
                }, this.updateTimeoutMs);
              }),
            ]);
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        },
      );
    } catch (error) {
      const approvalFailure = error instanceof MutationApprovalError;
      return this.record({
        executionId,
        target,
        status: approvalFailure ? "BLOCKED" : "UNKNOWN",
        approvalStatus: "ACCEPTED",
        verificationStatus: approvalFailure ? null : "UNKNOWN",
        recoveryStatus: approvalFailure
          ? "NOT_NEEDED"
          : recoveryStatusFor(operation.recoveryStrategy),
        capabilityStatus: capability.status,
        executionMechanism: operation.mechanism,
        proposalFingerprint: planFingerprint,
        preExecutionSource,
        preExecutionConfidence,
        reasonCodes: [
          approvalFailure
            ? "APPROVAL_SCOPE_VALIDATION_FAILED"
            : updateTimedOut || error instanceof SettingsUpdateTimeoutError
              ? "PROVIDER_UPDATE_TIMED_OUT"
              : "PROVIDER_UPDATE_OUTCOME_UNCERTAIN",
        ],
      });
    }

    const verification = await inspectExactField(
      provider,
      plan.siteId,
      change.categoryId,
      change.fieldId,
    );
    const verificationStatus = verificationStatusFor(
      verification.field,
      verification.error,
      change.proposedValue,
    );
    const verified = verificationStatus === "VERIFIED";
    return this.record({
      executionId,
      target,
      status: verified
        ? "VERIFIED"
        : verificationStatus === "FAILED"
          ? "FAILED"
          : "UNKNOWN",
      approvalStatus: "ACCEPTED",
      verificationStatus,
      recoveryStatus: verified
        ? "NOT_NEEDED"
        : recoveryStatusFor(operation.recoveryStrategy),
      capabilityStatus: capability.status,
      executionMechanism: operation.mechanism,
      proposalFingerprint: planFingerprint,
      preExecutionSource,
      preExecutionConfidence,
      verificationSource: verification.field?.source ?? null,
      verificationConfidence: verification.field?.inspectionConfidence ?? null,
      reasonCodes: verified
        ? []
        : verification.error
          ? [verification.error]
          : verificationStatus === "FAILED"
            ? ["POST_EXECUTION_VALUE_MISMATCH"]
            : ["POST_EXECUTION_VALUE_NOT_VERIFIABLE"],
    });
  }

  private record(input: {
    readonly executionId: string;
    readonly target: ChangeTarget;
    readonly status: SettingsExecutionResult["status"];
    readonly approvalStatus?: SettingsApprovalStatus;
    readonly verificationStatus?: SettingsVerificationStatus | null;
    readonly recoveryStatus?: SettingsRecoveryStatus;
    readonly capabilityStatus?: CapabilityStatus;
    readonly executionMechanism?: ExecutionMechanism;
    readonly proposalFingerprint?: string | null;
    readonly preExecutionSource?: string | null;
    readonly preExecutionConfidence?: number | null;
    readonly verificationSource?: string | null;
    readonly verificationConfidence?: number | null;
    readonly reasonCodes: readonly string[];
  }): SettingsExecutionResult {
    const result = deepFreeze({
      executionId: input.executionId,
      planId: input.target.planId,
      changeId: input.target.changeId,
      cmsProvider: input.target.cmsProvider,
      siteId: input.target.siteId,
      categoryId: input.target.categoryId,
      fieldId: input.target.fieldId,
      status: input.status,
      approvalStatus: input.approvalStatus ?? "NOT_REQUESTED",
      verificationStatus: input.verificationStatus ?? null,
      recoveryStatus: input.recoveryStatus ?? "NOT_NEEDED",
      capabilityStatus: input.capabilityStatus ?? "UNKNOWN_NEEDS_INVESTIGATION",
      executionMechanism: input.executionMechanism ?? "unknown",
      proposalFingerprint: input.proposalFingerprint ?? null,
      preExecutionSource: input.preExecutionSource ?? null,
      preExecutionConfidence: input.preExecutionConfidence ?? null,
      verificationSource: input.verificationSource ?? null,
      verificationConfidence: input.verificationConfidence ?? null,
      reasonCodes: [...input.reasonCodes],
      createdAt: this.now().toISOString(),
      completedAt: this.now().toISOString(),
    });
    this.records.set(result.executionId, result);
    return result;
  }
}

async function inspectExactField(
  provider: SettingsExecutionProvider,
  siteId: string,
  categoryId: string,
  fieldId: string,
): Promise<{ field?: SettingsPlanningField; error?: string }> {
  try {
    const inspection = await provider.inspectCategory(siteId, categoryId);
    if (inspection.status === "ACCESS_DENIED") {
      return { error: "SETTINGS_ACCESS_DENIED" };
    }
    if (inspection.status === "ERROR") return { error: "SETTINGS_INSPECTION_FAILED" };
    if (inspection.status === "NOT_AVAILABLE") {
      return { error: "SETTINGS_INSPECTION_UNAVAILABLE" };
    }
    const field = inspection.fields.find((candidate) => candidate.fieldId === fieldId);
    return field ? { field } : {};
  } catch {
    return { error: "SETTINGS_INSPECTION_FAILED" };
  }
}

function isUsableField(field: SettingsPlanningField): boolean {
  return AVAILABLE_VALUE_STATUSES.has(field.valueStatus) &&
    field.inspectionConfidence >= 0.7 &&
    !field.isSensitive &&
    !isSensitiveTarget("", field.fieldLabel);
}

async function verifySite(
  provider: SettingsExecutionProvider,
  siteId: string,
): Promise<boolean> {
  try {
    return (await provider.listSites()).filter((site) => site.id === siteId).length === 1;
  } catch {
    return false;
  }
}

async function readPermissions(
  provider: SettingsExecutionProvider,
  siteId: string,
): Promise<readonly string[] | null> {
  if (!provider.getGrantedPermissions) return null;
  try {
    return await provider.getGrantedPermissions(siteId);
  } catch {
    return null;
  }
}

function verificationStatusFor(
  field: SettingsPlanningField | undefined,
  error: string | undefined,
  proposedValue: PlannedValue,
): SettingsVerificationStatus {
  if (error || !field || !AVAILABLE_VALUE_STATUSES.has(field.valueStatus)) {
    return "UNKNOWN";
  }
  if (!field.isSensitive && valuesEqual(field.currentValue, proposedValue)) {
    return field.inspectionConfidence >= 0.7 ? "VERIFIED" : "PARTIALLY_VERIFIED";
  }
  return "FAILED";
}

function approvalStatusFor(error: MutationApprovalError): SettingsApprovalStatus {
  if (error.reason === "expired") return "EXPIRED";
  if (error.reason === "rejected") return "REJECTED_OR_CANCELLED";
  return "UNAVAILABLE";
}

function recoveryStatusFor(
  strategy: RecoveryStrategy,
): SettingsRecoveryStatus {
  if (strategy === "none" || strategy === "manual_recovery") {
    return "MANUAL_RECOVERY_REQUIRED";
  }
  return "UNAVAILABLE";
}

function targetFor(
  requestedPlanId: string,
  plan: SettingsChangePlan | undefined,
  change: SettingsChangePlan["changes"][number] | undefined,
): ChangeTarget {
  return {
    planId: plan?.planId ?? requestedPlanId,
    changeId: change?.changeId ?? "",
    cmsProvider: plan?.cmsProvider ?? null,
    siteId: plan?.siteId ?? null,
    categoryId: change?.categoryId ?? null,
    fieldId: change?.fieldId ?? null,
  };
}

function settingTargetKey(
  cmsProvider: CmsId,
  siteId: string,
  categoryId: string,
  fieldId: string,
): string {
  return JSON.stringify([cmsProvider, siteId, categoryId, fieldId]);
}

function isSensitiveTarget(categoryId: string, fieldLabel: string): boolean {
  return ["billing", "permissions_ownership"].includes(categoryId) ||
    /password|secret|token|api[\s_-]*key|credential|cookie|payment|credit card|bank|owner|personal|email|phone|address/i
      .test(fieldLabel);
}

function valuesEqual(left: PlannedValue | null, right: PlannedValue | null): boolean {
  return stableStringify(left) === stableStringify(right);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
