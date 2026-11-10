import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import { addTextSectionInputSchema, SquarespaceContentService } from "../browser/squarespace-content.service.js";
import type { SquarespacePage } from "../browser/squarespace-pages.service.js";
import type { WebsiteSummary } from "../browser/squarespace-browser.service.js";
import { registerContentTools } from "./content-tools.js";
import { MutationApprovalGuard } from "../approval/mutation-approval.js";

const input = {
  website_id: "site-1",
  page_id: "home-1",
  text: "Kausar Mia",
  background_color: "#FFFFFF",
  text_color: "#000000",
  confirm_potentially_live_save: true,
};

const confirmedWebsite: WebsiteSummary = {
  id: "site-1",
  name: "Kausar Mia",
  url: "https://cobalt-spinach-eeah.squarespace.com/config",
};

const homePage: SquarespacePage = {
  id: "home-1",
  websiteId: "site-1",
  name: "Home",
  navigationTitle: "Home",
  type: "page",
  group: "main_navigation",
  groupLabel: "Main Navigation",
  parentId: null,
  parentPath: [],
  url: "https://cobalt-spinach-eeah.squarespace.com/",
  visibilityStatus: "enabled",
  enabled: true,
  identity: {
    kind: "synthetic",
    native_id: null,
    synthetic_id: "home-1",
    title: "Home",
    slug: "home",
    is_homepage: true,
  },
};

function createApprovalGuard(approve = true): MutationApprovalGuard {
  return new MutationApprovalGuard({
    requestApproval: async () => approve,
  });
}

test("validates the requested text and exact colors", () => {
  assert.deepEqual(addTextSectionInputSchema.parse(input), input);
  assert.throws(() => addTextSectionInputSchema.parse({ ...input, text: "   " }));
  assert.throws(() => addTextSectionInputSchema.parse({ ...input, text_color: "#000000 " }));
  assert.throws(() => addTextSectionInputSchema.parse({ ...input, background_color: "#fff" }));
});

test("validates the exact Home-page target without creating a backup or editing the page", async () => {
  let pageReads = 0;
  const service = new SquarespaceContentService(
    {
      getWebsite() {
        return confirmedWebsite;
      },
      async openWebsiteUrl() {
        throw new Error("Target validation must not navigate.");
      },
      async getCurrentPage() {
        throw new Error("Target validation must not open the editor.");
      },
    },
    {
      async getPageDetails() {
        pageReads += 1;
        return homePage;
      },
      async inspectPageSections() {
        throw new Error("Target validation must not inspect or edit sections.");
      },
      async savePageChanges() {
        throw new Error("Target validation must not save.");
      },
    },
    {
      async createPageSnapshot() {
        throw new Error("Target validation must not create a backup.");
      },
      async verifyFreshSnapshot() {
        throw new Error("Target validation must not verify a backup.");
      },
    },
    createApprovalGuard(),
  );

  await service.verifyHomePageTarget(input.website_id, input.page_id);
  assert.equal(pageReads, 1);
  await assert.rejects(
    service.verifyHomePageTarget(input.website_id, "not-home"),
    { code: "TEXT_SECTION_TARGET_MISMATCH" },
  );
  assert.equal(pageReads, 2);
});

test("confirmed: true and legacy confirm_potentially_live_save cannot authorize a mutation", async () => {
  let browserCalls = 0;
  let pageCalls = 0;
  let backupCalls = 0;
  const service = new SquarespaceContentService(
    {
      getWebsite() {
        browserCalls += 1;
        return confirmedWebsite;
      },
      async openWebsiteUrl() {
        browserCalls += 1;
      },
      async getCurrentPage() {
        browserCalls += 1;
        throw new Error("Not expected.");
      },
    },
    {
      async getPageDetails() {
        pageCalls += 1;
        return homePage;
      },
      async inspectPageSections() {
        throw new Error("Not expected.");
      },
      async savePageChanges() {
        throw new Error("Not expected.");
      },
    },
    {
      async createPageSnapshot() {
        backupCalls += 1;
        throw new Error("Not expected.");
      },
      async verifyFreshSnapshot() {
        backupCalls += 1;
        throw new Error("Not expected.");
      },
    },
    createApprovalGuard(),
  );

  for (const suppliedConfirmation of [
    { confirmed: true },
    { confirm_potentially_live_save: true },
  ]) {
    await assert.rejects(
      () => service.addTextSection({ ...input, ...suppliedConfirmation }),
      { reason: "unavailable" },
    );
  }
  assert.equal(browserCalls, 0);
  assert.equal(pageCalls, 0);
  assert.equal(backupCalls, 0);
});

test("an approval for one exact text cannot authorize different content", async () => {
  let pageReads = 0;
  const service = new SquarespaceContentService(
    {
      getWebsite() {
        return confirmedWebsite;
      },
      async openWebsiteUrl() {
        throw new Error("A payload mismatch must block before navigation.");
      },
      async getCurrentPage() {
        throw new Error("A payload mismatch must block before page access.");
      },
    },
    {
      async getPageDetails() {
        pageReads += 1;
        return homePage;
      },
      async inspectPageSections() {
        throw new Error("A payload mismatch must block before section inspection.");
      },
      async savePageChanges() {
        throw new Error("A payload mismatch must block before saving.");
      },
    },
    {
      async createPageSnapshot() {
        throw new Error("A payload mismatch must block before backup creation.");
      },
      async verifyFreshSnapshot() {
        throw new Error("A payload mismatch must block before backup verification.");
      },
    },
    createApprovalGuard(),
  );
  const authorization = await service.requestTextSectionApproval(input);
  await assert.rejects(
    service.addTextSection({ ...input, text: "Different content" }, undefined, authorization),
    { reason: "scope_mismatch" },
  );
  assert.equal(pageReads, 0);
});

test("rejects an invalid website URL before creating a backup or opening the editor", async () => {
  let openCalls = 0;
  let backupCalls = 0;
  const service = new SquarespaceContentService(
    {
      getWebsite() {
        return { ...confirmedWebsite, url: "http://untrusted.invalid" };
      },
      async openWebsiteUrl() {
        openCalls += 1;
      },
      async getCurrentPage() {
        throw new Error("Not expected.");
      },
    },
    {
      async getPageDetails() {
        return homePage;
      },
      async inspectPageSections() {
        throw new Error("Not expected.");
      },
      async savePageChanges() {
        throw new Error("Not expected.");
      },
    },
    {
      async createPageSnapshot() {
        backupCalls += 1;
        throw new Error("Not expected.");
      },
      async verifyFreshSnapshot() {
        backupCalls += 1;
        throw new Error("Not expected.");
      },
    },
    createApprovalGuard(),
  );

  await assert.rejects(
    () => service.requestTextSectionApproval(input),
    { code: "TEXT_SECTION_TARGET_MISMATCH" },
  );
  assert.equal(openCalls, 0);
  assert.equal(backupCalls, 0);
});

test("registers one guarded mutation tool and rejects without host approval", async () => {
  let browserCalls = 0;
  let saveCalls = 0;
  let backupCalls = 0;
  const service = new SquarespaceContentService(
    {
      getWebsite() {
        browserCalls += 1;
        return confirmedWebsite;
      },
      async openWebsiteUrl() {
        browserCalls += 1;
      },
      async getCurrentPage() {
        browserCalls += 1;
        throw new Error("Not expected.");
      },
    },
    {
      async getPageDetails() {
        browserCalls += 1;
        return homePage;
      },
      async inspectPageSections() {
        throw new Error("Not expected.");
      },
      async savePageChanges() {
        saveCalls += 1;
        throw new Error("A declined approval must not reach Save.");
      },
    },
    {
      async createPageSnapshot() {
        backupCalls += 1;
        throw new Error("Not expected.");
      },
      async verifyFreshSnapshot() {
        backupCalls += 1;
        throw new Error("Not expected.");
      },
    },
    createApprovalGuard(false),
  );
  const server = new McpServer({ name: "content-tools-test", version: "1.0.0" });
  const client = new Client({ name: "content-tools-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerContentTools(server, service, new BrowserOperationLock());
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["add_text_section"]);
    assert.equal(listed.tools[0]?.annotations?.readOnlyHint, false);
    assert.equal(listed.tools[0]?.annotations?.destructiveHint, true);

    const result = await client.callTool({
      name: "add_text_section",
      arguments: {
        ...input,
        confirmed: true,
        confirm_potentially_live_save: true,
      },
    });
    assert.equal(result.isError, true);
    assert.equal(browserCalls, 1);
    assert.equal(saveCalls, 0);
    assert.equal(backupCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
