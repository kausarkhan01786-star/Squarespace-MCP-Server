import { createHash } from "node:crypto";
import type { CmsId } from "../../capabilities/capability-types.js";
import type { PlannedValue } from "../../planning/settings-change-types.js";
import type {
  AtomicSettingsUpdateRequest,
  AtomicSettingsUpdateResult,
  IndependentVerificationResult,
  ProviderCapabilityEvidence,
  ReadSettingResult,
  SettingsConflictEvidence,
  SettingsProviderAdapter,
  SettingsProviderDeclaration,
  SettingsTarget,
  SettingsProviderFeature,
  TimeoutReconciliationResult,
} from "./settings-provider-contract.js";

export interface SyntheticSettingsProviderOptions {
  readonly cms?: CmsId;
  readonly siteId?: string;
  readonly principalId?: string;
  readonly categoryId?: string;
  readonly settingId?: string;
  readonly initialValue?: PlannedValue;
  readonly permissions?: readonly string[];
  readonly timeoutAfterApply?: "reconcile_committed" | "reconcile_pending" | "unresolved";
  readonly timeoutBeforeApply?: "reconcile_not_committed" | "reconcile_pending";
  readonly providerAvailable?: boolean;
}

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly updateResult: AtomicSettingsUpdateResult;
  readonly reconciliationResult: TimeoutReconciliationResult;
}

interface SyntheticProviderCallCounts {
  resolveSite: number;
  read: number;
  update: number;
  mutation: number;
  verify: number;
  reconcile: number;
}

export class SyntheticSettingsProvider implements SettingsProviderAdapter {
  readonly declaration: SettingsProviderDeclaration;

  private readonly cms: CmsId;
  private readonly siteId: string;
  private readonly principalId: string;
  private readonly categoryId: string;
  private readonly settingId: string;
  private readonly permissions: readonly string[];
  private readonly timeoutAfterApply: SyntheticSettingsProviderOptions["timeoutAfterApply"];
  private readonly timeoutBeforeApply: SyntheticSettingsProviderOptions["timeoutBeforeApply"];
  private readonly providerAvailable: boolean;
  private readonly idempotencyRecords = new Map<string, IdempotencyRecord>();
  private currentValue: PlannedValue;
  private version = 1;
  private queue: Promise<void> = Promise.resolve();
  private calls: SyntheticProviderCallCounts = {
    resolveSite: 0,
    read: 0,
    update: 0,
    mutation: 0,
    verify: 0,
    reconcile: 0,
  };

  constructor(options: SyntheticSettingsProviderOptions = {}) {
    this.cms = options.cms ?? "squarespace";
    this.siteId = options.siteId ?? "synthetic-site";
    this.principalId = options.principalId ?? "synthetic-principal";
    this.categoryId = options.categoryId ?? "website";
    this.settingId = options.settingId ?? "timezone";
    this.currentValue = clone(options.initialValue ?? "UTC");
    this.permissions = Object.freeze([...(options.permissions ?? ["settings.website.write"])]);
    this.timeoutAfterApply = options.timeoutAfterApply;
    this.timeoutBeforeApply = options.timeoutBeforeApply;
    this.providerAvailable = options.providerAvailable ?? true;
    const evidence = (feature: SettingsProviderFeature): ProviderCapabilityEvidence => ({
      status: "VERIFIED",
      evidence: [{
        evidenceId: `synthetic-fixture-${feature.toLowerCase()}`,
        type: "SYNTHETIC_FIXTURE",
        reference: "synthetic-provider-conformance-fixture",
        cms: this.cms,
        adapterId: "synthetic-in-memory",
        feature,
        operations: feature === "READ_SETTING" || feature === "INDEPENDENT_READBACK"
          ? ["read"]
          : ["update"],
        publisherAuthority: "synthetic-test-fixture",
        claim: "SYNTHETIC_ONLY",
        scope: "in-memory simulation only; not a CMS provider",
        retrievedAt: "2025-01-01T00:00:00.000Z",
        reviewedAt: "2025-01-01T00:00:00.000Z",
        reviewStatus: "APPROVED",
        reviewerAuthority: "synthetic-test-suite",
        validity: "ACTIVE",
        validUntil: null,
        supersededBy: null,
        conflictsWith: [],
        limitations: ["Fixture behavior does not prove any live CMS capability."],
        verificationNotes: ["Validated only against an in-memory deterministic fixture."],
      }],
    });
    const features: Record<SettingsProviderFeature, ProviderCapabilityEvidence> = {
      READ_SETTING: evidence("READ_SETTING"),
      WRITE_SETTING: evidence("WRITE_SETTING"),
      ATOMIC_COMPARE_AND_SET: evidence("ATOMIC_COMPARE_AND_SET"),
      IDEMPOTENT_WRITE: evidence("IDEMPOTENT_WRITE"),
      INDEPENDENT_READBACK: evidence("INDEPENDENT_READBACK"),
      CONFLICT_DETECTION: evidence("CONFLICT_DETECTION"),
      TIMEOUT_RECONCILIATION: evidence("TIMEOUT_RECONCILIATION"),
    };
    this.declaration = Object.freeze({
      cms: this.cms,
      adapterId: "synthetic-in-memory",
      contractVersion: "1",
      providerKind: "synthetic",
      preconditionMode: {
        kind: "version_token" as const,
        evidenceReference: "synthetic-provider-conformance-fixture",
      },
      features: Object.freeze(features),
    });
  }

  async resolveAuthorizedSite(siteId: string) {
    this.calls.resolveSite += 1;
    if (!this.providerAvailable || siteId !== this.siteId) return null;
    return {
      cms: this.cms,
      siteId: this.siteId,
      principalId: this.principalId,
      verified: true,
      grantedPermissions: [...this.permissions],
    };
  }

  async readSetting(target: SettingsTarget): Promise<ReadSettingResult> {
    this.calls.read += 1;
    this.assertTarget(target);
    return {
      target: clone(target),
      value: clone(this.currentValue),
      version: String(this.version),
      observedAt: new Date(0).toISOString(),
    };
  }

  async updateAtomically(
    request: AtomicSettingsUpdateRequest,
  ): Promise<AtomicSettingsUpdateResult> {
    this.calls.update += 1;
    return this.withLock(() => this.applyAtomically(request));
  }

  async verifyIndependently(
    target: SettingsTarget,
    proposedValue: PlannedValue,
  ): Promise<IndependentVerificationResult> {
    this.calls.verify += 1;
    this.assertTarget(target);
    const value = clone(this.currentValue);
    return {
      target: clone(target),
      value,
      version: String(this.version),
      matchesProposedValue: equal(value, proposedValue),
      verifiedAt: new Date(0).toISOString(),
    };
  }

  async reconcileTimeout(
    target: SettingsTarget,
    idempotencyKey: string,
  ): Promise<TimeoutReconciliationResult> {
    this.calls.reconcile += 1;
    if (!this.matchesTarget(target)) return { outcome: "UNKNOWN" };
    const record = this.idempotencyRecords.get(idempotencyKey);
    return record?.reconciliationResult ?? { outcome: "UNKNOWN" };
  }

  getState(): {
    readonly value: PlannedValue;
    readonly version: string;
    readonly calls: Readonly<SyntheticProviderCallCounts>;
    readonly idempotencyKeys: readonly string[];
  } {
    return {
      value: clone(this.currentValue),
      version: String(this.version),
      calls: Object.freeze({ ...this.calls }),
      idempotencyKeys: Object.freeze([...this.idempotencyRecords.keys()]),
    };
  }

  setFixtureValue(value: PlannedValue): void {
    this.currentValue = clone(value);
    this.version += 1;
  }

  private applyAtomically(
    request: AtomicSettingsUpdateRequest,
  ): AtomicSettingsUpdateResult {
    const fingerprint = requestFingerprint(request);
    const existing = this.idempotencyRecords.get(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { outcome: "REJECTED", reasonCode: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH" };
      }
      return clone(existing.updateResult);
    }

    if (!this.providerAvailable) {
      return this.remember(request, fingerprint, {
        outcome: "REJECTED",
        reasonCode: "PROVIDER_UNAVAILABLE",
      }, { outcome: "NOT_COMMITTED" });
    }
    if (!this.matchesTarget(request.target)) {
      return this.remember(request, fingerprint, {
        outcome: "REJECTED",
        reasonCode: "SITE_OR_SETTING_IDENTITY_MISMATCH",
      }, { outcome: "NOT_COMMITTED" });
    }
    if (!this.permissions.includes("settings.website.write")) {
      return this.remember(request, fingerprint, {
        outcome: "REJECTED",
        reasonCode: "REQUIRED_PERMISSION_MISSING",
      }, { outcome: "NOT_COMMITTED" });
    }

    const conflict = this.comparePrecondition(request);
    if (conflict) {
      return this.remember(request, fingerprint, {
        outcome: "CONFLICT",
        evidence: conflict,
      }, { outcome: "NOT_COMMITTED" });
    }

    if (this.timeoutBeforeApply) {
      const reconciliationResult: TimeoutReconciliationResult =
        this.timeoutBeforeApply === "reconcile_not_committed"
          ? { outcome: "NOT_COMMITTED" }
          : { outcome: "PENDING" };
      return this.remember(request, fingerprint, {
        outcome: "UNKNOWN",
        reasonCode: "SIMULATED_RESPONSE_LOST_BEFORE_COMMIT",
        mayHaveApplied: true,
      }, reconciliationResult);
    }

    this.currentValue = clone(request.proposedValue);
    this.version += 1;
    this.calls.mutation += 1;
    const providerOperationId = `synthetic-operation-${this.calls.mutation}`;
    const committedVersion = String(this.version);
    if (this.timeoutAfterApply) {
      const result: AtomicSettingsUpdateResult = {
        outcome: "UNKNOWN",
        reasonCode: "SIMULATED_RESPONSE_LOST_AFTER_COMMIT",
        mayHaveApplied: true,
      };
      const reconciliationResult: TimeoutReconciliationResult =
        this.timeoutAfterApply === "reconcile_committed"
          ? { outcome: "COMMITTED", providerOperationId, committedVersion }
          : this.timeoutAfterApply === "reconcile_pending"
            ? { outcome: "PENDING" }
            : { outcome: "UNKNOWN" };
      this.idempotencyRecords.set(request.idempotencyKey, {
        fingerprint,
        updateResult: clone(result),
        reconciliationResult,
      });
      return result;
    }

    return this.remember(request, fingerprint, {
      outcome: "APPLIED",
      providerOperationId,
      committedVersion,
      replayed: false,
    }, {
      outcome: "COMMITTED",
      providerOperationId,
      committedVersion,
    });
  }

  private comparePrecondition(
    request: AtomicSettingsUpdateRequest,
  ): SettingsConflictEvidence | null {
    if (!equal(this.currentValue, request.expectedValue)) {
      return {
        kind: "VALUE_MISMATCH",
        observedValue: clone(this.currentValue),
        observedVersion: String(this.version),
      };
    }
    if (
      request.precondition.kind !== "version_token" ||
      request.precondition.version !== String(this.version)
    ) {
      return {
        kind: "VERSION_MISMATCH",
        observedValue: clone(this.currentValue),
        observedVersion: String(this.version),
      };
    }
    return null;
  }

  private remember(
    request: AtomicSettingsUpdateRequest,
    fingerprint: string,
    updateResult: AtomicSettingsUpdateResult,
    reconciliationResult: TimeoutReconciliationResult,
  ): AtomicSettingsUpdateResult {
    this.idempotencyRecords.set(request.idempotencyKey, {
      fingerprint,
      updateResult: clone(updateResult),
      reconciliationResult: clone(reconciliationResult),
    });
    return updateResult;
  }

  private matchesTarget(target: SettingsTarget): boolean {
    return target.cms === this.cms &&
      target.siteId === this.siteId &&
      target.categoryId === this.categoryId &&
      target.settingId === this.settingId;
  }

  private assertTarget(target: SettingsTarget): void {
    if (!this.providerAvailable) throw new Error("Synthetic provider is unavailable.");
    if (!this.matchesTarget(target)) throw new Error("Synthetic target identity mismatch.");
  }

  private async withLock<T>(operation: () => T): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}

function requestFingerprint(request: AtomicSettingsUpdateRequest): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

function equal(left: PlannedValue, right: PlannedValue): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
