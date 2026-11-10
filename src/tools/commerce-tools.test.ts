import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommerceProvider } from "../commerce/commerce-provider.js";
import { SquarespaceCommerceService } from "../commerce/squarespace-commerce.service.js";
import { registerCommerceTools } from "./commerce-tools.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";

test("registers only read-only commerce tools with strict target and pagination inputs", async () => {
  const provider: CommerceProvider = {
    providerName: "fixture",
    getCapabilities: () => ({ provider: "fixture", capabilities: [] }),
    async verifyWebsite() {},
    async listProducts() {
      return { items: [], hasNextPage: false, nextCursor: null };
    },
    async getProductDetails(productId) {
      return { id: productId };
    },
    async listInventory() {
      return { items: [], hasNextPage: false, nextCursor: null };
    },
    async listOrders() {
      return { items: [], hasNextPage: false, nextCursor: null };
    },
    async listDiscounts() {
      return { items: [], hasNextPage: false, nextCursor: null };
    },
  };
  const commerce = new SquarespaceCommerceService(
    { getWebsite: () => ({
      id: "site-1",
      name: "Shop",
      url: "https://shop.example.squarespace.com",
    }) },
    provider,
  );
  const server = new McpServer({ name: "commerce-tools-test", version: "1.0.0" });
  const client = new Client({ name: "commerce-tools-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerCommerceTools(server, commerce, new BrowserOperationLock());
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [
        "get_commerce_capabilities",
        "list_products",
        "get_product_details",
        "list_inventory",
        "list_orders",
        "list_discounts",
      ],
    );
    assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true));
    const details = await client.callTool({
      name: "get_product_details",
      arguments: { website_id: "site-1", product_id: "../bad" },
    });
    assert.equal(details.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
