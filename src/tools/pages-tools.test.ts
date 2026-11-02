import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PageBackupService } from "../backups/page-backup.service.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import { SquarespacePagesService } from "../browser/squarespace-pages.service.js";
import type { WebsiteSummary } from "../browser/squarespace-browser.service.js";
import { registerPagesTools } from "./pages-tools.js";

test("registers page tools with correct annotations and returns structured JSON", async () => {
  const website: WebsiteSummary = {
    id: "site-1",
    name: "Example site",
    url: "https://example.squarespace.com/config",
  };
  const pages = new SquarespacePagesService({
    async listWebsites() {
      return [website];
    },
    getWebsite() {
      return website;
    },
    async openWebsitePages() {},
    async openWebsiteUrl() {},
    async getCurrentPage() {
      throw new Error("Page access is not expected in this registration test.");
    },
    async captureScreenshot() {
      return "fixture-screenshot.png";
    },
  });
  const backups = new PageBackupService(pages, {
    getWebsite() {
      return website;
    },
    async openWebsiteUrl() {},
    async getCurrentPage() {
      throw new Error("Page access is not expected in this registration test.");
    },
  }, { backupDirectory: "C:\\temp\\squarespace-test-backups" });
  const server = new McpServer({ name: "tool-registry-test", version: "1.0.0" });
  const client = new Client({ name: "tool-registry-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerPagesTools(server, pages, backups, new BrowserOperationLock());

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listedTools = await client.listTools();
    assert.deepEqual(
      listedTools.tools.map((tool) => tool.name).sort(),
      [
        "create_page_snapshot",
        "get_navigation_structure",
        "get_page_details",
        "get_page_url",
        "get_snapshot",
        "inspect_mobile_responsive",
        "inspect_page_sections",
        "inspect_section",
        "list_not_linked_pages",
        "list_page_sections",
        "list_pages",
        "list_snapshots",
        "list_websites",
      ],
    );
    assert.ok(listedTools.tools.every((tool) => tool.annotations?.readOnlyHint === true));
    const disabledMutationTools = [
      "create_page",
      "delete_page",
      "duplicate_page",
      "move_page",
      "save_page_changes",
      "update_page_title",
      "update_page_url",
      "add_content_section",
      "update_text_block",
      "update_image_block",
      "update_button_block",
      "update_section_background",
      "update_section_spacing",
      "update_section_layout",
      "reorder_sections",
      "remove_section",
      "manage_custom_css",
      "manage_custom_code_injection",
      "customize_header",
      "customize_footer",
    ];
    for (const name of disabledMutationTools) {
      assert.equal(
        listedTools.tools.some((tool) => tool.name === name),
        false,
        `${name} must not be registered as an MCP tool`,
      );
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, `${name} must be rejected by the MCP server`);
    }

    const invalidSectionRequest = await client.callTool({
      name: "inspect_section",
      arguments: {
        website_id: "site-1",
        page_id: "page-1",
        section_id: " ",
      },
    });
    assert.equal(invalidSectionRequest.isError, true);

    const invalidSnapshotRequest = await client.callTool({
      name: "get_snapshot",
      arguments: { snapshot_id: "../../outside" },
    });
    assert.equal(invalidSnapshotRequest.isError, true);

    const result = await client.callTool({ name: "list_websites", arguments: {} });
    assert.deepEqual(result.structuredContent, { result: [website] });
  } finally {
    await client.close();
    await server.close();
  }
});
