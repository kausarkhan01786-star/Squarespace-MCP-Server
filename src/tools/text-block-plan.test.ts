import { 
  computeTextContentHash,
  normalizeTextContent,
  TextBlockBaseline,
  TextBlockChangePlan,
  fingerprintTextBlockChangePlan,
  validateTextBlockBaseline,
  validateTextBlockChangePlan
} from "./text-block-plan";
import assert from "node:assert/strict";

import { test } from "node:test";

test("Text Block Baseline: creates valid baseline with stable content hash", () => {
    const baseline: TextBlockBaseline = {
      schema: "text_block_baseline/v1",
      capturedAt: new Date("2026-01-01T12:00:00.000Z").toISOString(),
      cms: "squarespace",
      siteId: "site-1",
      pageId: "page-1",
      sectionId: "sec-1",
      blockId: "block-1",
      blockType: "text",
      textContent: "Line1\r\nLine2\r\n\r\nLine3",
      contentHash: computeTextContentHash("Line1\r\nLine2\r\n\r\nLine3"),
    };
    const v = validateTextBlockBaseline(baseline);
    assert.ok(v.valid, v.reasonCodes?.join(", "));
    // Check normalization
    assert.equal(
      normalizeTextContent("abc\r\ndef\r\n\r\n\r\nxyz"),
      "abc\ndef\n\nxyz"
    );
  });

test("Text Block Baseline: rejects missing block/page", () => {
  const invalid = validateTextBlockBaseline({ cms: "squarespace", textContent: "t" });
  assert.ok(!invalid.valid);
  assert.ok(invalid.reasonCodes.includes("MISSING_PAGE_ID"));
  assert.ok(invalid.reasonCodes.includes("MISSING_BLOCK_ID"));
});

test("Text Block Baseline: produces different hashes for meaningful content changes", () => {
  const h1 = computeTextContentHash("alpha\nbeta");
  const h2 = computeTextContentHash("alpha beta");
  assert.notEqual(h1, h2);
});

test("Text Block Baseline: is stable to whitespace normalization", () => {
  const h1 = computeTextContentHash("a\nb\n\nc");
  const h2 = computeTextContentHash("a\r\nb\r\n\r\nc");
  assert.equal(h1, h2);
});


// --- Change Plan ---
const baseline: TextBlockBaseline = {
  schema: "text_block_baseline/v1",
  capturedAt: "2026-01-01T12:00:00.000Z",
  cms: "squarespace",
  siteId: "site-id",
  pageId: "p-id",
  blockId: "b-id",
  blockType: "text",
  textContent: "reference text",
  contentHash: computeTextContentHash("reference text"),
};
const planTemplate: Omit<TextBlockChangePlan, "planId" | "createdAt"> = {
  schema: "text_block_change_plan/v1",
  cms: baseline.cms,
  siteId: baseline.siteId,
  pageId: baseline.pageId,
  sectionId: undefined,
  blockId: baseline.blockId,
  blockType: baseline.blockType,
  operation: "replace_text",
  baselineContentHash: baseline.contentHash,
  proposedText: "new stuff!",
  proposedContentHash: computeTextContentHash("new stuff!"),
  changeSummary: "Replace text content with 'new stuff!'",
  preconditions: ["should edit a live text block"],
  validationStatus: undefined,
};

test("Text Block Change Plan: validates a correct plan", () => {
  const plan: TextBlockChangePlan = {
    ...planTemplate,
    planId: "plan-123",
    createdAt: "2026-02-01T12:00:00.000Z"
  };
  const result = validateTextBlockChangePlan(plan);
  assert.ok(result.valid, result.reasonCodes);
});

test("Text Block Change Plan: fails with missing baseline or block ids", () => {
  const invalid: Partial<TextBlockChangePlan> = {
    schema: "text_block_change_plan/v1",
    planId: "p",
    cms: "squarespace",
    blockType: "text",
    operation: "replace_text",
    baselineContentHash: "0".repeat(64),
    proposedText: "hi",
    proposedContentHash: computeTextContentHash("hi"),
    changeSummary: "Add hi"
  };
  const vr = validateTextBlockChangePlan(invalid);
  assert.ok(!vr.valid && Array.isArray(vr.reasonCodes));
  assert.ok(vr.reasonCodes.includes("MISSING_SITE_ID"));
  assert.ok(vr.reasonCodes.includes("MISSING_PAGE_ID"));
  assert.ok(vr.reasonCodes.includes("MISSING_BLOCK_ID"));
});

test("Text Block Change Plan: rejects unsupported operation type", () => {
  const bad: any = { ...planTemplate, operation: "remove_text", planId: "p2", createdAt: "t" };
  const vr = validateTextBlockChangePlan(bad);
  assert.ok(!vr.valid);
  assert.ok(vr.reasonCodes.includes("UNSUPPORTED_OPERATION"));
});

test("Text Block Change Plan: proposed hash must match computed", () => {
  const plan: TextBlockChangePlan = {
    ...planTemplate,
    planId: "zzz",
    createdAt: "2026-03-01T13:11:12Z",
    proposedContentHash: "f".repeat(64)
  };
  const vr = validateTextBlockChangePlan(plan);
  assert.ok(!vr.valid);
  assert.ok(vr.reasonCodes.includes("PROPOSED_HASH_MISMATCH"));
  });

  test("Text Plan Fingerprint: changes with material plan changes", () => {
  const ref = {
    schema: "text_block_change_plan/v1",
    planId: "z",
    createdAt: "2026-03-01",
    cms: "squarespace",
    siteId: "one",
    pageId: "p",
    blockId: "one",
    blockType: "text",
    operation: "replace_text",
    baselineContentHash: computeTextContentHash("old"),
    proposedText: "foo",
    proposedContentHash: computeTextContentHash("foo"),
    changeSummary: "Swap text",
  };
  const fp1 = fingerprintTextBlockChangePlan(ref as any);
  const fp2 = fingerprintTextBlockChangePlan({ ...ref, proposedText: "foo bar", proposedContentHash: computeTextContentHash("foo bar") });
  const fp3 = fingerprintTextBlockChangePlan({ ...ref, baselineContentHash: computeTextContentHash("oldest") });
  assert.notEqual(fp1, fp2);
  assert.notEqual(fp1, fp3);
  // Changing only planId/createdAt leaves fingerprint stable
  const fp4 = fingerprintTextBlockChangePlan({ ...ref, planId: "w", createdAt: "different date" });
  assert.equal(fp1, fp4);
});

test("Text Plan Fingerprint: rejects invalid or incomplete plans via validation", () => {
  const empty: any = {};
  const vr = validateTextBlockChangePlan(empty);
  assert.ok(!vr.valid);
  assert.ok(vr.reasonCodes.includes("INVALID_PLAN_ID"));
});
