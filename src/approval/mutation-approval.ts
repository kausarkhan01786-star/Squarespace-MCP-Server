import { randomUUID, createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export type MutationPermissionScope =
  | "content.section.create"
  | "content.block.create"
  | "content.block.edit"
  | "content.save"
  | "content.publish"
  | "content.delete"
  | "page.create"
  | "page.update"
  | "page.delete"
  | "navigation.update"
  | "seo.update"
  | "design.update"
  | "settings.update";

export interface MutationProposalInput {
  readonly provider: string;
  readonly websiteId: string;
  readonly pageId?: string;
  readonly action: string;
  readonly targetResource: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly permissionScopes: readonly MutationPermissionScope[];
}

export interface MutationProposal extends MutationProposalInput {
  readonly id: string;
  readonly payloadHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

const receiptBrand: unique symbol = Symbol("mutation-approval-receipt");
export interface MutationApprovalReceipt {
  readonly [receiptBrand]: true;
}

export interface MutationAuthorization {
  proposal: MutationProposal;
  receipt: MutationApprovalReceipt;
}

export interface HumanApprovalPrompt {
  requestApproval(proposal: MutationProposal): Promise<boolean>;
}

interface ReceiptRecord {
  proposalFingerprint: string;
  expiresAt: number;
}

interface ActiveAuthorization {
  proposal: MutationProposal;
  coreFingerprint: string;
  expiresAt: number;
  taskId?: string;
}

const activeAuthorization = new AsyncLocalStorage<ActiveAuthorization>();
export const DEFAULT_APPROVAL_TTL_MS = 120_000;

export class MutationApprovalError extends Error {
  constructor(
    readonly reason:
      | "unavailable"
      | "rejected"
      | "invalid"
      | "expired"
      | "replayed"
      | "scope_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "MutationApprovalError";
  }
}

export function createMutationProposal(
  input: MutationProposalInput,
  now = new Date(),
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
): MutationProposal {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError("Approval TTL must be a positive safe integer in milliseconds.");
  }
  const core = {
    provider: input.provider,
    websiteId: input.websiteId,
    ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
    action: input.action,
    targetResource: input.targetResource,
    payload: structuredClone(input.payload),
    permissionScopes: [...new Set(input.permissionScopes)].sort(),
  };
  if (
    !core.provider.trim() ||
    !core.websiteId.trim() ||
    !core.action.trim() ||
    !core.targetResource.trim() ||
    core.permissionScopes.length === 0
  ) {
    throw new MutationApprovalError("invalid", "The mutation proposal is incomplete.");
  }
  if (
    core.permissionScopes.includes("content.save") &&
    core.permissionScopes.includes("content.publish")
  ) {
    throw new MutationApprovalError(
      "invalid",
      "Saving and publishing require separate approvals and cannot share one proposal.",
    );
  }
  if (
    core.permissionScopes.includes("settings.update") &&
    core.permissionScopes.length !== 1
  ) {
    throw new MutationApprovalError(
      "invalid",
      "A settings update requires its own exact approval proposal and scope.",
    );
  }
  return deepFreeze({
    ...core,
    id: randomUUID(),
    payloadHash: sha256(stableStringify(core.payload)),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

export class MutationApprovalGuard {
  private readonly receipts = new WeakMap<MutationApprovalReceipt, ReceiptRecord>();

  constructor(
    private readonly prompt: HumanApprovalPrompt,
    private readonly ttlMs = DEFAULT_APPROVAL_TTL_MS,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new RangeError("Approval TTL must be a positive safe integer in milliseconds.");
    }
  }

  hasActiveAuthorization(): boolean {
    return activeAuthorization.getStore() !== undefined;
  }

  async requestApproval(input: MutationProposalInput, ttlMs = this.ttlMs): Promise<{
    proposal: MutationProposal;
    receipt: MutationApprovalReceipt;
  }> {
    const proposal = createMutationProposal(input, this.now(), ttlMs);
    let accepted: boolean;
    try {
      accepted = await this.prompt.requestApproval(proposal);
    } catch (error) {
      if (error instanceof MutationApprovalError) throw error;
      throw new MutationApprovalError(
        "unavailable",
        "Trusted human approval is unavailable; the mutation was not authorized.",
      );
    }
    if (!accepted) {
      throw new MutationApprovalError(
        "rejected",
        "The human approval request was declined or canceled; the mutation was not authorized.",
      );
    }
    if (Date.parse(proposal.expiresAt) <= this.now().getTime()) {
      throw new MutationApprovalError(
        "expired",
        "The approval request expired before authorization could be issued.",
      );
    }

    const receipt = Object.freeze({
      [receiptBrand]: true as const,
    }) as MutationApprovalReceipt;
    this.receipts.set(receipt, {
      proposalFingerprint: fingerprintProposal(proposal),
      expiresAt: Date.parse(proposal.expiresAt),
    });
    return { proposal, receipt };
  }

  revoke(receipt: MutationApprovalReceipt | undefined): void {
    if (receipt) this.receipts.delete(receipt);
  }

  isAuthorizationValid(
    proposal: MutationProposal,
    receipt: MutationApprovalReceipt,
  ): boolean {
    const record = this.receipts.get(receipt);
    return Boolean(
      record &&
      record.expiresAt > this.now().getTime() &&
      record.proposalFingerprint === fingerprintProposal(proposal),
    );
  }

  async runAuthorized<T>(
    proposal: MutationProposal,
    receipt: MutationApprovalReceipt,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (proposal.action === "workflow.execute") {
      throw new MutationApprovalError(
        "invalid",
        "Workflow task grants must run through the task-scoped authorization boundary.",
      );
    }
    this.consume(proposal, receipt);
    return activeAuthorization.run(
      { proposal, coreFingerprint: fingerprintProposalCore(proposal), expiresAt: Date.parse(proposal.expiresAt) },
      operation,
    );
  }

  async runTaskAuthorized<T>(
    proposal: MutationProposal,
    receipt: MutationApprovalReceipt,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      proposal.action !== "workflow.execute" ||
      !Array.isArray(proposal.payload.operations) ||
      !Array.isArray(proposal.payload.tasks)
    ) {
      throw new MutationApprovalError("invalid", "A bounded workflow task authorization is required.");
    }
    if (!this.isAuthorizationValid(proposal, receipt)) {
      throw new MutationApprovalError("expired", "The task authorization is invalid, revoked, or expired.");
    }
    return activeAuthorization.run(
      { proposal, coreFingerprint: fingerprintProposalCore(proposal), expiresAt: Date.parse(proposal.expiresAt) },
      operation,
    );
  }

  async runWorkflowTaskAuthorized<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const active = activeAuthorization.getStore();
    if (!active || active.proposal.action !== "workflow.execute") {
      throw new MutationApprovalError("unavailable", "No active workflow task authorization exists.");
    }
    if (active.expiresAt <= this.now().getTime()) {
      throw new MutationApprovalError("expired", "The workflow task authorization has expired.");
    }
    const tasks = active.proposal.payload.tasks;
    if (
      !Array.isArray(tasks) ||
      !tasks.some((task) => task !== null && typeof task === "object" &&
        (task as Record<string, unknown>).taskId === taskId)
    ) {
      throw new MutationApprovalError("scope_mismatch", "This task ID is outside the authorized workflow scope.");
    }
    return activeAuthorization.run({ ...active, taskId }, operation);
  }

  assertAuthorized(input: {
    scope: MutationPermissionScope;
    provider: string;
    websiteId: string;
    targetResource?: string;
    pageId?: string;
    action?: string;
    payload?: Record<string, unknown>;
  }): void {
    const active = activeAuthorization.getStore();
    const proposal = active?.proposal;
    if (active && active.expiresAt <= this.now().getTime()) {
      throw new MutationApprovalError("expired", "The task or operation authorization has expired.");
    }
    if (!proposal) {
      throw new MutationApprovalError(
        "unavailable",
        "No trusted, proposal-specific human authorization is active; the mutation was blocked.",
      );
    }
    const expectedCore = {
      provider: input.provider,
      websiteId: input.websiteId,
      ...(input.targetResource === undefined ? {} : { targetResource: input.targetResource }),
      ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
      ...(input.action === undefined ? {} : { action: input.action }),
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      scope: input.scope,
    };
    const aggregateOperations = proposal.action === "workflow.execute"
      ? proposal.payload.operations
      : undefined;
    const aggregateMatch = proposal.provider === expectedCore.provider &&
      proposal.websiteId === expectedCore.websiteId &&
      expectedCore.action !== undefined &&
      expectedCore.targetResource !== undefined &&
      expectedCore.payload !== undefined &&
      Array.isArray(aggregateOperations) && aggregateOperations.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const operation = entry as Record<string, unknown>;
      const operationScopes = operation.permissionScopes;
      return operation.provider === expectedCore.provider &&
        operation.websiteId === expectedCore.websiteId &&
        operation.pageId === expectedCore.pageId &&
        operation.targetResource === expectedCore.targetResource &&
        operation.action === expectedCore.action &&
        operation.taskId === active.taskId &&
        stableStringify(operation.payload) === stableStringify(expectedCore.payload) &&
        Array.isArray(operationScopes) && operationScopes.includes(expectedCore.scope);
    });
    const exactMatch =
      proposal.provider === expectedCore.provider &&
      proposal.websiteId === expectedCore.websiteId &&
      (expectedCore.targetResource === undefined || proposal.targetResource === expectedCore.targetResource) &&
      (expectedCore.pageId === undefined || proposal.pageId === expectedCore.pageId) &&
      (expectedCore.action === undefined || proposal.action === expectedCore.action) &&
      (expectedCore.payload === undefined ||
        stableStringify(proposal.payload) === stableStringify(expectedCore.payload));
    if (
      (!exactMatch && !aggregateMatch) ||
      !proposal.permissionScopes.includes(expectedCore.scope) ||
      active.coreFingerprint !== fingerprintProposalCore(proposal)
    ) {
      throw new MutationApprovalError(
        "scope_mismatch",
        "The active approval does not cover this exact CMS, target, action, payload, and permission scope.",
      );
    }
  }

  private consume(
    proposal: MutationProposal,
    receipt: MutationApprovalReceipt,
  ): void {
    if (!receipt || typeof receipt !== "object") {
      throw new MutationApprovalError("invalid", "A valid server-issued approval is required.");
    }
    const stored = this.receipts.get(receipt);
    if (!stored) {
      throw new MutationApprovalError(
        "replayed",
        "The approval is invalid, revoked, or has already been consumed.",
      );
    }
    this.receipts.delete(receipt);
    if (stored.expiresAt <= this.now().getTime()) {
      throw new MutationApprovalError("expired", "The approval has expired.");
    }
    if (stored.proposalFingerprint !== fingerprintProposal(proposal)) {
      throw new MutationApprovalError(
        "scope_mismatch",
        "The approval does not match the exact authorized proposal.",
      );
    }
  }
}

function fingerprintProposal(proposal: MutationProposal): string {
  return sha256(stableStringify(proposal));
}

function fingerprintProposalCore(proposal: MutationProposal): string {
  return sha256(stableStringify({
    provider: proposal.provider,
    websiteId: proposal.websiteId,
    ...(proposal.pageId === undefined ? {} : { pageId: proposal.pageId }),
    action: proposal.action,
    targetResource: proposal.targetResource,
    payload: proposal.payload,
    permissionScopes: proposal.permissionScopes,
    payloadHash: proposal.payloadHash,
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
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
