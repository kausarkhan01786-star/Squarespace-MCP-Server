import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommerceProvider } from "./commerce-provider.js";
import { SquarespaceCommerceService } from "./squarespace-commerce.service.js";

const website = {
  id: "browser-site-hash",
  name: "Shop",
  url: "https://shop.example.squarespace.com/config",
};

function makeProvider() {
  const calls: string[] = [];
  const provider: CommerceProvider = {
    providerName: "fixture",
    getCapabilities: () => ({
      provider: "fixture",
      capabilities: [
        "list_products",
        "get_product_details",
        "list_inventory",
        "list_orders",
        "list_discounts",
      ].map((operation) => ({
        operation: operation as
          | "list_products"
          | "get_product_details"
          | "list_inventory"
          | "list_orders"
          | "list_discounts",
        apiSupported: true,
        toolAvailable: true,
        access: "read_only" as const,
        note: "fixture",
      })),
    }),
    async verifyWebsite(websiteId, websiteUrl) {
      calls.push(`verify:${websiteId}:${websiteUrl}`);
    },
    async listProducts(cursor) {
      calls.push(`products:${cursor ?? ""}`);
      return { items: [], hasNextPage: false, nextCursor: null };
    },
    async getProductDetails(productId) {
      calls.push(`product:${productId}`);
      return { id: productId };
    },
    async listInventory(cursor) {
      calls.push(`inventory:${cursor ?? ""}`);
      return { items: [], hasNextPage: false, nextCursor: null };
    },
    async listOrders(cursor) {
      calls.push(`orders:${cursor ?? ""}`);
      return { items: [], hasNextPage: false, nextCursor: null };
    },
    async listDiscounts(offset, limit) {
      calls.push(`discounts:${offset}:${limit}`);
      return { items: [], hasNextPage: false, nextCursor: null };
    },
  };
  return { provider, calls };
}

test("verifies the selected browser website before every commerce API operation", async () => {
  const { provider, calls } = makeProvider();
  const service = new SquarespaceCommerceService(
    { getWebsite: () => website },
    provider,
  );
  await service.listProducts(website.id, "cursor");
  await service.getProductDetails(website.id, "product-1");
  assert.deepEqual(calls, [
    `verify:${website.id}:${website.url}`,
    "products:cursor",
    `verify:${website.id}:${website.url}`,
    "product:product-1",
  ]);
});

test("fails closed when the website is not from the latest authenticated browser listing", async () => {
  const { provider, calls } = makeProvider();
  const service = new SquarespaceCommerceService(
    {
      getWebsite() {
        throw new Error("Unknown website");
      },
    },
    provider,
  );
  await assert.rejects(() => service.listOrders("unlisted"), {
    code: "COMMERCE_TARGET_MISMATCH",
  });
  assert.deepEqual(calls, []);
});

test("returns an explicit unsupported-capability error rather than assuming adapter support", async () => {
  const provider: CommerceProvider = {
    providerName: "partial",
    getCapabilities: () => ({
      provider: "partial",
      capabilities: [{
        operation: "list_products",
        apiSupported: true,
        toolAvailable: true,
        access: "read_only",
        note: "fixture declares it but does not implement it",
      }],
    }),
    async verifyWebsite() {},
  };
  const service = new SquarespaceCommerceService(
    { getWebsite: () => website },
    provider,
  );
  await assert.rejects(() => service.listProducts(website.id), {
    code: "COMMERCE_CAPABILITY_UNAVAILABLE",
  });
});
