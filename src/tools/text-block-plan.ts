import { randomUUID, createHash } from "node:crypto";

/**
 * Squarespace CMS ID types for reference. Extend or reuse from registry/types if available.
 */
export type CMSId = string; // caution: treat as opaque/immutable
export type SiteId = string;
export type PageId = string;
export type SectionId = string;
export type BlockId = string;
export type BlockType = "text" | string; // others possible, focus on "text"

/**
 * Baseline for a Squarespace Text Block (capture/read-only only)
 */
export interface TextBlockBaseline {
  readonly schema: "text_block_baseline/v1";
  readonly capturedAt: string; // ISO datetime
  readonly cms: string; // "squarespace"
  readonly siteId: SiteId;
  readonly pageId: PageId;
  readonly sectionId?: SectionId;
  readonly blockId: BlockId;
  readonly blockType: BlockType;
  readonly textContent: string;
  readonly contentHash: string; // sha256(raw textContent, after normalization)
}

/** Normalize and hash text content deterministically for content hash */
export function normalizeTextContent(content: string): string {
  // Normalize: trim trailing newlines, normalize inner whitespace but preserve intentional leading/trailing (do NOT silently rewrap)
  // Allow exact change detection, reject classic JS string normalization pitfalls
  // For now, use: replace CR+LF -> LF, collapse sequences of 3+ newlines to 2, preserve all other chars
  return content.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

export function computeTextContentHash(content: string): string {
  const normalized = normalizeTextContent(content);
  return createHash("sha256").update(normalized, "utf-8").digest("hex");
}

/**
 * Text Block Change Plan: immutable, purely additive, never marks as approved, executable, or committed
 */
export interface TextBlockChangePlan {
  readonly schema: "text_block_change_plan/v1";
  readonly planId: string;
  readonly createdAt: string;
  readonly cms: string;
  readonly siteId: SiteId;
  readonly pageId: PageId;
  readonly sectionId?: SectionId;
  readonly blockId: BlockId;
  readonly blockType: BlockType;
  readonly operation: "replace_text";
  readonly baselineContentHash: string;
  readonly proposedText: string;
  readonly proposedContentHash: string;
  readonly changeSummary: string; // plain English
  readonly preconditions?: readonly string[];
  readonly validationStatus?: PlanValidationResult;
}

/** Only include meaningful fields (not timestamps) for fingerprinting */
export function canonicalizePlanForFingerprint(plan: TextBlockChangePlan): object {
  // Exclude planId, createdAt, validationStatus
  return {
    schema: plan.schema,
    cms: plan.cms,
    siteId: plan.siteId,
    pageId: plan.pageId,
    sectionId: plan.sectionId,
    blockId: plan.blockId,
    blockType: plan.blockType,
    operation: plan.operation,
    baselineContentHash: plan.baselineContentHash,
    proposedText: plan.proposedText,
    proposedContentHash: plan.proposedContentHash,
    changeSummary: plan.changeSummary,
    preconditions: plan.preconditions,
  };
}

export function stableStringify(value: unknown): string {
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

export function fingerprintTextBlockChangePlan(plan: TextBlockChangePlan): string {
  const obj = canonicalizePlanForFingerprint(plan);
  return createHash("sha256").update(stableStringify(obj), "utf-8").digest("hex");
}

/** Pure validation result and reason codes for plans */
export interface PlanValidationResult {
  readonly valid: boolean;
  readonly reasonCodes: readonly string[];
}

export function validateTextBlockBaseline(baseline: Partial<TextBlockBaseline>): PlanValidationResult {
  const reasons: string[] = [];
  if (!baseline.cms || typeof baseline.cms !== "string") reasons.push("INVALID_CMS_ID");
  if (!baseline.siteId) reasons.push("MISSING_SITE_ID");
  if (!baseline.pageId) reasons.push("MISSING_PAGE_ID");
  if (!baseline.blockId) reasons.push("MISSING_BLOCK_ID");
  if (!baseline.blockType) reasons.push("MISSING_BLOCK_TYPE");
  if (typeof baseline.textContent !== "string" || baseline.textContent.length < 1) reasons.push("MISSING_TEXT_CONTENT");
  if (!baseline.contentHash || !/^[a-f0-9]{64}$/i.test(baseline.contentHash)) reasons.push("INVALID_CONTENT_HASH");
  if (!baseline.capturedAt || isNaN(Date.parse(baseline.capturedAt))) reasons.push("INVALID_CAPTURE_TIMESTAMP");
  if (baseline.schema !== "text_block_baseline/v1") reasons.push("INVALID_SCHEMA_VERSION");
  return { valid: reasons.length === 0, reasonCodes: reasons };
}

export function validateTextBlockChangePlan(plan: Partial<TextBlockChangePlan>): PlanValidationResult {
  const reasons: string[] = [];
  if (!plan.planId) reasons.push("INVALID_PLAN_ID");
  if (!plan.cms) reasons.push("INVALID_CMS_ID");
  if (!plan.siteId) reasons.push("MISSING_SITE_ID");
  if (!plan.pageId) reasons.push("MISSING_PAGE_ID");
  if (!plan.blockId) reasons.push("MISSING_BLOCK_ID");
  if (!plan.blockType) reasons.push("MISSING_BLOCK_TYPE");
  if (plan.operation !== "replace_text") reasons.push("UNSUPPORTED_OPERATION");
  if (!plan.baselineContentHash || !/^[a-f0-9]{64}$/i.test(plan.baselineContentHash)) reasons.push("INVALID_BASELINE_HASH");
  if (typeof plan.proposedText !== "string" || plan.proposedText.length < 1) reasons.push("MISSING_PROPOSED_TEXT");
  if (!plan.proposedContentHash || !/^[a-f0-9]{64}$/i.test(plan.proposedContentHash)) reasons.push("INVALID_PROPOSED_CONTENT_HASH");
  // Canonical schema version check
  if (plan.schema !== "text_block_change_plan/v1") reasons.push("INVALID_SCHEMA_VERSION");
  // Optionally revalidate fingerprint
  if (typeof plan.proposedText === "string" && plan.proposedContentHash !== computeTextContentHash(plan.proposedText)) reasons.push("PROPOSED_HASH_MISMATCH");
  return { valid: reasons.length === 0, reasonCodes: reasons };
}
