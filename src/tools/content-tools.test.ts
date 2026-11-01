import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addTextSectionInputSchema, SquarespaceContentService } from "../browser/squarespace-content.service.js";
import type { SquarespacePage } from "../browser/squarespace-pages.service.js";
import type { WebsiteSummary } from "../browser/squarespace-browser.service.js";
import { registerContentTools } from "./content-tools.js";
import { z } from "zod";

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
};

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
  );

  await service.verifyHomePageTarget(input.website_id, input.page_id);
  assert.equal(pageReads, 1);
  await assert.rejects(
    service.verifyHomePageTarget(input.website_id, "not-home"),
    { code: "TEXT_SECTION_TARGET_MISMATCH" },
  );
  assert.equal(pageReads, 2);
});

test("requires explicit potentially-live-save approval before any site or backup access", async () => {
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
  );

  await assert.rejects(
    () => service.addTextSection({ ...input, confirm_potentially_live_save: false }),
    { code: "CONFIRMATION_REQUIRED" },
  );
  assert.equal(browserCalls, 0);
  assert.equal(pageCalls, 0);
  assert.equal(backupCalls, 0);
});

test("rejects a different website before creating a backup or opening the editor", async () => {
  let openCalls = 0;
  let backupCalls = 0;
  const service = new SquarespaceContentService(
    {
      getWebsite() {
        return { ...confirmedWebsite, name: "Different site" };
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
  );

  await assert.rejects(
    () => service.addTextSection(input),
    { code: "TEXT_SECTION_TARGET_MISMATCH" },
  );
  assert.equal(openCalls, 0);
  assert.equal(backupCalls, 0);
});

test("registers one guarded mutation tool and reports missing live-save approval", async () => {
  let browserCalls = 0;
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
        throw new Error("Not expected.");
      },
    },
    {
      async createPageSnapshot() {
        throw new Error("Not expected.");
      },
      async verifyFreshSnapshot() {
        throw new Error("Not expected.");
      },
    },
  );
  const server = new McpServer({ name: "content-tools-test", version: "1.0.0" });
  const client = new Client({ name: "content-tools-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerContentTools(server, service);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["add_text_section"]);
    assert.equal(listed.tools[0]?.annotations?.readOnlyHint, false);
    assert.equal(listed.tools[0]?.annotations?.destructiveHint, true);

    const result = await client.callTool({
      name: "add_text_section",
      arguments: { ...input, confirm_potentially_live_save: false },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(
      z.object({
        error: z.object({ code: z.string() }),
      }).parse(JSON.parse(result.content[0]?.text ?? "{}")).error.code,
      "CONFIRMATION_REQUIRED",
    );
    assert.equal(browserCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
