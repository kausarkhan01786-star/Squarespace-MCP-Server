import assert from "node:assert/strict";
import { test } from "node:test";
import { SquarespaceCommerceProvider } from "./squarespace-commerce.provider.js";

const websiteUrl = "https://shop.example.squarespace.com";
const siteIdentity = { siteId: "api-site-1", url: websiteUrl };

function providerWithResponses(
  responses: unknown[],
  options: { apiKey?: string; expectedSiteId?: string } = {},
) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const provider = new SquarespaceCommerceProvider({
    apiKey: options.apiKey ?? "secret-api-key",
    expectedSiteId: options.expectedSiteId ?? "api-site-1",
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      const body = responses.shift();
      if (body === undefined) throw new Error("No response fixture remains.");
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  return { provider, requests };
}

test("reports only verified Squarespace API and exposed adapter capabilities", () => {
  const { provider } = providerWithResponses([]);
  const report = provider.getCapabilities();
  assert.equal(report.provider, "squarespace_commerce_api");
  assert.equal(
    report.capabilities.find((capability) => capability.operation === "list_products")?.toolAvailable,
    true,
  );
  assert.equal(
    report.capabilities.find((capability) => capability.operation === "create_product")?.apiSupported,
    true,
  );
  assert.equal(
    report.capabilities.find((capability) => capability.operation === "create_product")?.toolAvailable,
    false,
  );
  assert.equal(
    report.capabilities.find((capability) => capability.operation === "list_product_categories")?.apiSupported,
    "unverified",
  );
});

test("verifies the API-key-bound site against the selected browser website", async () => {
  const { provider, requests } = providerWithResponses([siteIdentity]);
  await provider.verifyWebsite("browser-site-hash", websiteUrl);
  assert.equal(requests[0]?.url, "https://api.squarespace.com/1.0/authorization/website");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer secret-api-key");
  assert.equal(requests[0]?.headers.get("user-agent"), "Squarespace-MCP-Server/0.1.0");
});

test("rejects a site mismatch before commerce data is read", async () => {
  const { provider } = providerWithResponses([
    { siteId: "other-api-site", url: websiteUrl },
  ]);
  await assert.rejects(
    () => provider.verifyWebsite("browser-site-hash", websiteUrl),
    { code: "COMMERCE_TARGET_MISMATCH" },
  );
});

test("rejects a URL mismatch between the browser listing and API key", async () => {
  const { provider } = providerWithResponses([siteIdentity]);
  await assert.rejects(
    () => provider.verifyWebsite("browser-site-hash", "https://other.example.squarespace.com"),
    { code: "COMMERCE_TARGET_MISMATCH" },
  );
});

test("requires API credentials without making a network request", async () => {
  let fetchCalls = 0;
  const provider = new SquarespaceCommerceProvider({
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    },
  });
  await assert.rejects(
    () => provider.verifyWebsite("site", websiteUrl),
    { code: "COMMERCE_API_NOT_CONFIGURED" },
  );
  assert.equal(fetchCalls, 0);
});

test("lists and retrieves products using documented endpoints and cursor pagination", async () => {
  const product = { id: "product-1", name: "Scarf", variants: [], images: [] };
  const { provider, requests } = providerWithResponses([
    {
      products: [product],
      pagination: { hasNextPage: true, nextPageCursor: "next-cursor" },
    },
    [product],
  ]);
  const page = await provider.listProducts("cursor one");
  assert.deepEqual(page, {
    items: [product],
    hasNextPage: true,
    nextCursor: "next-cursor",
  });
  assert.equal(
    requests[0]?.url,
    "https://api.squarespace.com/v2/commerce/products?cursor=cursor+one",
  );
  assert.deepEqual(await provider.getProductDetails("product-1"), product);
  assert.equal(
    requests[1]?.url,
    "https://api.squarespace.com/v2/commerce/products/product-1",
  );
});

test("rejects a product response that does not match the requested ID", async () => {
  const { provider } = providerWithResponses([[{ id: "different-product" }]]);
  await assert.rejects(
    () => provider.getProductDetails("product-1"),
    { code: "COMMERCE_RESPONSE_INVALID" },
  );
});

test("lists inventory items using the documented cursor endpoint", async () => {
  const inventory = { variantId: "variant-1", quantity: 3 };
  const { provider, requests } = providerWithResponses([
    { inventory: [inventory], pagination: { hasNextPage: false, nextPageCursor: null } },
  ]);
  assert.deepEqual(await provider.listInventory(), {
    items: [inventory],
    hasNextPage: false,
    nextCursor: null,
  });
  assert.equal(requests[0]?.url, "https://api.squarespace.com/1.0/commerce/inventory");
});

test("marks inventory pagination unknown when Squarespace returns its documented array form", async () => {
  const { provider } = providerWithResponses([[{ variantId: "variant-1", quantity: 3 }]]);
  assert.deepEqual(await provider.listInventory(), {
    items: [{ variantId: "variant-1", quantity: 3 }],
    hasNextPage: null,
    nextCursor: null,
  });
});

test("strips customer-sensitive order fields while retaining status and fulfillment data", async () => {
  const { provider } = providerWithResponses([{
    result: [{
      id: "order-1",
      orderNumber: "1001",
      customerEmail: "customer@example.com",
      customerId: "private-customer-id",
      shippingAddress: { address1: "private address" },
      internalNotes: [{ content: "private note" }],
      createdOn: "2026-01-01T00:00:00Z",
      fulfillmentStatus: "PENDING",
      paymentState: "PAID",
      grandTotal: { currency: "USD", value: 5 },
      lineItems: [{
        id: "line-1",
        productId: "product-1",
        productName: "Scarf",
        quantity: 1,
        customizations: [{ value: "private answer" }],
        unitPricePaid: { currency: "USD", value: 5 },
      }],
      fulfillments: [{
        carrierName: "Carrier",
        trackingNumber: "private-tracking",
        trackingUrl: "https://carrier.example/track/private",
      }],
    }],
    pagination: { hasNextPage: false, nextPageCursor: null },
  }]);

  const page = await provider.listOrders();
  assert.equal(page.items[0]?.fulfillmentStatus, "PENDING");
  assert.equal(page.items[0]?.lineItems[0]?.productName, "Scarf");
  assert.equal(page.items[0]?.fulfillments[0]?.carrierName, "Carrier");
  assert.doesNotMatch(JSON.stringify(page), /customer@example\.com|private-customer-id|private address|private note|private answer|private-tracking|carrier\.example/);
});

test("lists discounts with bounded offset pagination", async () => {
  const discount = { id: "discount-1", name: "Seasonal" };
  const { provider, requests } = providerWithResponses([{
    result: [discount],
    pagination: { hasNextPage: true },
  }]);
  assert.deepEqual(await provider.listDiscounts(4, 20), {
    items: [discount],
    hasNextPage: true,
    nextCursor: null,
    nextOffset: 5,
  });
  assert.equal(
    requests[0]?.url,
    "https://api.squarespace.com/v1/commerce/discounts?offset=4&limit=20",
  );
  await assert.rejects(() => provider.listDiscounts(-1, 20));
  await assert.rejects(() => provider.listDiscounts(0, 101));
});

test("does not include response bodies or credentials in API errors", async () => {
  const provider = new SquarespaceCommerceProvider({
    apiKey: "secret-api-key",
    expectedSiteId: "api-site-1",
    fetchImpl: async () => new Response("secret-api-key private response", { status: 403 }),
  });
  await assert.rejects(
    () => provider.verifyWebsite("site", websiteUrl),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("read permissions") &&
      !error.message.includes("secret-api-key") &&
      error.message !== "secret-api-key private response",
  );
});
