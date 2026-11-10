import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { outputSchema, readOnlyAnnotations, runTool } from "./tool-helpers.js";
import { SquarespaceCommerceService } from "../commerce/squarespace-commerce.service.js";
import type { BrowserOperationLock } from "../browser/browser-operation-lock.js";

const websiteSchema = z.object({
  website_id: z.string().trim().min(1).describe("ID returned by list_websites in the authenticated browser session."),
});
const cursorSchema = z.string().min(1).max(2048).optional();
const listSchema = websiteSchema.extend({ cursor: cursorSchema });
const productDetailsSchema = websiteSchema.extend({
  product_id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
});
const discountsSchema = websiteSchema.extend({
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});

export function registerCommerceTools(
  server: McpServer,
  commerce: SquarespaceCommerceService,
  browserOperationLock: BrowserOperationLock,
): void {
  server.registerTool(
    "get_commerce_capabilities",
    {
      description: "Report verified Squarespace Commerce API support separately from operations currently exposed by this adapter.",
      inputSchema: z.object({}),
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => runTool("get_commerce_capabilities", async () => commerce.getCapabilities()),
  );
  server.registerTool(
    "list_products",
    {
      description: "List products from the verified Squarespace site using the official read-only Commerce API.",
      inputSchema: listSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, cursor }) =>
      runTool("list_products", () => commerce.listProducts(website_id, cursor), browserOperationLock),
  );
  server.registerTool(
    "get_product_details",
    {
      description: "Retrieve one product, including its variants and images, from the verified Squarespace site.",
      inputSchema: productDetailsSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, product_id }) =>
      runTool("get_product_details", () =>
        commerce.getProductDetails(website_id, product_id),
        browserOperationLock,
      ),
  );
  server.registerTool(
    "list_inventory",
    {
      description: "Read inventory by product variant from the verified Squarespace site.",
      inputSchema: listSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, cursor }) =>
      runTool("list_inventory", () => commerce.listInventory(website_id, cursor), browserOperationLock),
  );
  server.registerTool(
    "list_orders",
    {
      description: "List orders and fulfillment status from the verified Squarespace site. Customer names, addresses, contact details, tracking numbers, and notes are omitted.",
      inputSchema: listSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, cursor }) =>
      runTool("list_orders", () => commerce.listOrders(website_id, cursor), browserOperationLock),
  );
  server.registerTool(
    "list_discounts",
    {
      description: "List Squarespace discount records without creating, changing, or activating discounts.",
      inputSchema: discountsSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ website_id, offset, limit }) =>
      runTool("list_discounts", () =>
        commerce.listDiscounts(website_id, offset, limit),
        browserOperationLock,
      ),
  );
}
