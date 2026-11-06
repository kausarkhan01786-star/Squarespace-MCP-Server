import assert from "node:assert/strict";
import test from "node:test";
import { adapterCapabilityDescriptorSchema } from "./adapter-capability.js";
import type {
  AdapterContext,
  Block,
  CMSAdapter,
  Page,
  PageOperations,
  BlockOperations,
  SectionOperations,
  Site,
  SiteInspector,
} from "./adapter-contract.js";
import {
  operationError,
  operationSuccess,
  redactSensitiveText,
  serializeOperationResult,
  unsupportedOperation,
  type OperationResult,
} from "./adapter-result.js";

const providerData = {
  providerId: "fixture-provider",
  originalPayload: { native: { type: "unknown-native-block", nested: [1, "raw"] } },
  sourceMetadata: { sourceType: "unknown-native-block", revision: 3 },
} as const;

const site: Site = {
  id: "site-1",
  name: "Fixture site",
  url: "https://example.invalid",
  providerData,
};

const page: Page = {
  id: "page-1",
  siteId: site.id,
  title: "Home",
  slug: "home",
  url: "https://example.invalid/",
  providerData,
};

const context: AdapterContext = {
  site: { cms: "squarespace", siteId: site.id },
  requestId: "request-1",
  signal: new AbortController().signal,
};

const fixtureAdapter: CMSAdapter & SiteInspector & PageOperations = {
  metadata: {
    cms: "squarespace",
    adapterId: "fixture-squarespace-adapter",
    contractVersion: "1",
  },
  async inspectSite() {
    return operationSuccess(site);
  },
  async listPages() {
    return operationSuccess([page]);
  },
  async inspectPage() {
    return unsupportedOperation("page.inspect");
  },
  async createPage() {
    return unsupportedOperation("page.create");
  },
  async updatePage() {
    return unsupportedOperation("page.update");
  },
  async deletePage() {
    return unsupportedOperation("page.delete");
  },
};

const sectionInspector: Pick<SectionOperations, "inspectSection"> = {
  async inspectSection() {
    return unsupportedOperation("section.inspect");
  },
};

const blockInspector: Pick<BlockOperations, "inspectBlock"> = {
  async inspectBlock() {
    return unsupportedOperation("block.inspect");
  },
};

test("operation results discriminate success, provider error, and unsupported", () => {
  const success: OperationResult<string> = operationSuccess("ok");
  const error = operationError("provider_unavailable", "Provider offline");
  const unsupported = unsupportedOperation("asset.upload");

  assert.deepEqual(success, { status: "success", value: "ok" });
  assert.equal(error.status, "error");
  if (error.status === "error") assert.equal(error.error.code, "provider_unavailable");
  assert.equal(unsupported.status, "unsupported");
  if (unsupported.status === "unsupported") {
    assert.equal(unsupported.error.code, "unsupported_operation");
    assert.equal(unsupported.error.operation, "asset.upload");
  }
});

test("capability dimensions validate independently", () => {
  const descriptor = {
    capabilityId: "website.pages",
    operationId: "create",
    support: "supported",
    access: "write",
    executionMechanism: "browser_automation",
    verification: "not_verified",
    approvalRequirement: "required",
    permissionRequirement: { kind: "required", permissions: ["pages.write"] },
    evidence: [],
  };

  assert.deepEqual(adapterCapabilityDescriptorSchema.parse(descriptor), descriptor);
  assert.equal(
    adapterCapabilityDescriptorSchema.safeParse({ ...descriptor, verification: "unknown" }).success,
    false,
  );
});

test("an adapter can expose granular groups and explicitly reject unsupported operations", async () => {
  assert.equal(fixtureAdapter.metadata.cms, "squarespace");
  assert.deepEqual(await fixtureAdapter.inspectSite(context), {
    status: "success",
    value: site,
  });
  assert.deepEqual(await fixtureAdapter.listPages(context), {
    status: "success",
    value: [page],
  });

  const result = await fixtureAdapter.createPage(context, { title: "New page" });
  assert.equal(result.status, "unsupported");
});

test("section and block inspection contracts return explicit unsupported results", async () => {
  const sectionResult = await sectionInspector.inspectSection(context, "section-1");
  const blockResult = await blockInspector.inspectBlock(context, "block-1");

  assert.equal(sectionResult.status, "unsupported");
  if (sectionResult.status === "unsupported") {
    assert.equal(sectionResult.error.operation, "section.inspect");
  }
  assert.equal(blockResult.status, "unsupported");
  if (blockResult.status === "unsupported") {
    assert.equal(blockResult.error.operation, "block.inspect");
  }
});

test("unknown CMS block payload and source identity are preserved", () => {
  const rawBlock = {
    id: "block-1",
    sectionId: "section-1",
    content: {
      kind: "unknown",
      originalSourceType: "fluid_engine_gallery_v4",
      originalPayload: { layout: { columns: 7 }, proprietary: ["kept"] },
    },
    providerData,
  } satisfies Block;

  assert.equal(rawBlock.content.kind, "unknown");
  if (rawBlock.content.kind === "unknown") {
    assert.equal(rawBlock.content.originalSourceType, "fluid_engine_gallery_v4");
    assert.deepEqual(rawBlock.content.originalPayload, {
      layout: { columns: 7 },
      proprietary: ["kept"],
    });
  }
  assert.equal(rawBlock.providerData.providerId, "fixture-provider");
  assert.equal(rawBlock.providerData.originalPayload, providerData.originalPayload);
  assert.deepEqual(rawBlock.providerData.sourceMetadata, providerData.sourceMetadata);
});

test("provider errors expose controlled messages and runtime-allow-listed metadata", () => {
  const untrustedMetadata = {
    httpStatus: 502,
    retryAfterMs: 1000,
    apiKey: "api-secret",
    nested: { token: "nested-secret" },
  };
  const result = operationError(
    "execution_failure",
    "Authorization: Bearer bearer-secret api_key=api-secret; password: \"pw-secret\"",
    untrustedMetadata,
  );
  assert.equal(result.status, "error");
  if (result.status !== "error") return;

  const serialized = JSON.stringify(result.error);
  assert.equal(result.error.message, "The provider could not complete the operation.");
  assert.doesNotMatch(serialized, /bearer-secret|api-secret|pw-secret|nested-secret/);
  assert.notEqual(result.error.metadata, untrustedMetadata);
  assert.deepEqual(result.error.metadata, { httpStatus: 502, retryAfterMs: 1000 });

  const invalidMetadata = operationError("execution_failure", "ignored", {
    httpStatus: 999,
    retryAfterMs: -1,
    unexpected: "not retained",
  });
  assert.equal(invalidMetadata.status, "error");
  if (invalidMetadata.status === "error") assert.equal(invalidMetadata.error.metadata, undefined);
});

test("serialization sanitizes direct untrusted results and operation metadata", () => {
  const directError = serializeOperationResult({
    status: "error",
    error: {
      code: "execution_failure",
      message: "Authorization: Basic dXNlcjpwYXNz",
      metadata: {
        httpStatus: 500,
        apiKey: "direct-secret",
        nested: { password: "nested-secret" },
      },
    },
  });
  assert.equal(directError.status, "error");
  if (directError.status === "error") {
    assert.equal(directError.error.message, "The provider could not complete the operation.");
    assert.deepEqual(directError.error.metadata, { httpStatus: 500 });
  }

  const directSuccess = serializeOperationResult({
    status: "success",
    value: "ok",
    metadata: {
      operationId: "pages.list",
      durationMs: 12,
      apiKey: "direct-secret",
      nested: { token: "nested-secret" },
    },
  });
  assert.equal(directSuccess.status, "success");
  if (directSuccess.status === "success") {
    assert.deepEqual(directSuccess.metadata, { operationId: "pages.list", durationMs: 12 });
  }
  assert.doesNotMatch(JSON.stringify([directError, directSuccess]), /direct-secret|nested-secret/);
});

test("best-effort diagnostic redaction covers Basic and Digest authorization headers", () => {
  const basic = redactSensitiveText("Authorization: Basic dXNlcjpwYXNz");
  const digest = redactSensitiveText(
    'Authorization: Digest username="user", realm="example", nonce="digest-secret", response="response-secret"',
  );

  assert.equal(basic, "Authorization: [REDACTED]");
  assert.equal(digest, "Authorization: [REDACTED]");
  assert.doesNotMatch(`${basic} ${digest}`, /dXNlcjpwYXNz|digest-secret|response-secret/);
});

test("operation identifiers are filtered and unsupported results remain explicit", () => {
  const success = operationSuccess("ok", {
    operationId: "session_token=operation-secret",
  } as { readonly operationId?: string; readonly durationMs?: number });
  const unsupported = unsupportedOperation("api_key=operation-secret");
  assert.doesNotMatch(serializeOperationResult(success).status === "success"
    ? JSON.stringify(serializeOperationResult(success))
    : "", /operation-secret/);
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.error.code, "unsupported_operation");
  assert.doesNotMatch(JSON.stringify(serializeOperationResult(unsupported)), /operation-secret/);
});