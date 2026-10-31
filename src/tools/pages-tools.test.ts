import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SquarespacePagesService } from "../browser/squarespace-pages.service.js";
import type { WebsiteSummary } from "../browser/squarespace-browser.service.js";
import { registerPagesTools } from "./pages-tools.js";

test("registers the seven inspection tools as read-only and returns structured JSON", async () => {
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
  });
  const server = new McpServer({ name: "tool-registry-test", version: "1.0.0" });
  const client = new Client({ name: "tool-registry-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerPagesTools(server, pages);

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listedTools = await client.listTools();
    assert.deepEqual(
      listedTools.tools.map((tool) => tool.name).sort(),
      [
        "get_navigation_structure",
        "get_page_details",
        "get_page_url",
        "inspect_page_sections",
        "list_not_linked_pages",
        "list_pages",
        "list_websites",
      ],
    );
    assert.ok(listedTools.tools.every((tool) => tool.annotations?.readOnlyHint === true));

    const result = await client.callTool({ name: "list_websites", arguments: {} });
    assert.deepEqual(result.structuredContent, { result: [website] });
  } finally {
    await client.close();
    await server.close();
  }
});
