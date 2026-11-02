import { randomUUID } from "node:crypto";
import type { CmsId } from "../capabilities/capability-types.js";
import {
  capabilityRegistry,
  type CapabilityRegistry,
} from "../capabilities/capability-registry.js";
import type {
  SettingsChangePlan,
} from "../planning/settings-change-types.js";
import type {
  ExecuteApprovedSettingsChangeInput,
  SettingsExecutionCapabilitySummary,
  SettingsExecutionPlanLookup,
  SettingsExecutionProvider,
  SettingsExecutionResult,
  SettingsExecutionStatusReport,
} from "./settings-execution-types.js";

interface ExecutionServiceOptions {
  readonly planner: SettingsExecutionPlanLookup;
  readonly providers: ReadonlyMap<CmsId, SettingsExecutionProvider>;
  readonly registry?: CapabilityRegistry;
  readonly now?: () => Date;
  readonly createId?: () => string;
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
  private readonly registry: CapabilityRegistry;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: ExecutionServiceOptions) {
    this.registry = options.registry ?? capabilityRegistry;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  getSettingsExecutionStatus(cmsProvider: CmsId): SettingsExecutionStatusReport {
    const capabilities = this.registry.getCapabilitiesForCms(cmsProvider)
      .filter((capability) => capability.operations.update !== undefined)
      .map((capability): SettingsExecutionCapabilitySummary => {
        const operation = capability.operations.update;
        const reasons = [
          "Atomic provider execution is not integrated; settings mutations are disabled.",
        ];
        if (this.options.providers.has(cmsProvider)) {
          reasons.push(
            "The configured provider is read-only and is not an atomic execution adapter.",
          );
        }
        if (!operation || operation.status !== "IMPLEMENTED_AND_TESTED") {
          reasons.push(
            `The registered update capability is ${operation?.status ?? "NOT_REGISTERED"}.`,
          );
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
      executionProviderConfigured: false,
      mutationToolExposed: false,
      capabilities,
      limitations: [
        "All settings execution requests are blocked until atomic provider integration is implemented.",
        "No legacy non-CAS update path is available.",
        "No functional settings mutation MCP tool is exposed.",
        "Synthetic fixtures do not establish live CMS write compatibility.",
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
        reasonCodes: ["PLAN_OR_CHANGE_NOT_FOUND"],
      });
    }

    return this.record({
      executionId,
      target,
      reasonCodes: ["ATOMIC_PROVIDER_ADAPTER_NOT_INTEGRATED"],
    });
  }

  private record(input: {
    readonly executionId: string;
    readonly target: ChangeTarget;
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
      status: "BLOCKED" as const,
      approvalStatus: "NOT_REQUESTED" as const,
      verificationStatus: null,
      recoveryStatus: "NOT_NEEDED" as const,
      capabilityStatus: "UNKNOWN_NEEDS_INVESTIGATION" as const,
      executionMechanism: "unknown" as const,
      proposalFingerprint: null,
      preExecutionSource: null,
      preExecutionConfidence: null,
      verificationSource: null,
      verificationConfidence: null,
      reasonCodes: [...input.reasonCodes],
      createdAt: this.now().toISOString(),
      completedAt: this.now().toISOString(),
    });
    this.records.set(result.executionId, result);
    return result;
  }
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
