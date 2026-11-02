import { z } from "zod";
import { SquarespaceBrowserError } from "../browser/browser-errors.js";
import {
  ExecutionStoppedError,
  stopReasonFromSignal,
  type BrowserExecutionContext,
} from "../browser/browser-execution-context.js";
import type {
  CommerceCapabilityReport,
  CommercePage,
  CommerceProvider,
  SafeOrderSummary,
} from "./commerce-provider.js";

const API_ORIGIN = "https://api.squarespace.com";
const USER_AGENT = "Squarespace-MCP-Server/0.1.0";
const cursorSchema = z.string().min(1).max(2048);
const offsetSchema = z.number().int().min(0).max(1_000_000);
const limitSchema = z.number().int().min(1).max(100);
const productIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

const capabilities: CommerceCapabilityReport = {
  provider: "squarespace_commerce_api",
  capabilities: [
    { operation: "list_products", apiSupported: true, toolAvailable: true, access: "read_only", note: "Official Products API." },
    { operation: "get_product_details", apiSupported: true, toolAvailable: true, access: "read_only", note: "Official Products API returns product variants and images." },
    { operation: "create_product", apiSupported: true, toolAvailable: false, access: "read_write", note: "Not exposed until commerce-specific backup and mutation safeguards are implemented." },
    { operation: "update_product", apiSupported: true, toolAvailable: false, access: "read_write", note: "Not exposed until commerce-specific backup and mutation safeguards are implemented." },
    { operation: "manage_product_images", apiSupported: true, toolAvailable: false, access: "read_write", note: "Official API supports image operations; upload and file verification are not implemented." },
    { operation: "manage_product_variants", apiSupported: true, toolAvailable: false, access: "read_write", note: "Official API supports variant operations; mutation safeguards are not implemented." },
    { operation: "manage_product_availability", apiSupported: true, toolAvailable: false, access: "read_write", note: "Product visibility can be updated through the Products API; guarded mutation is not implemented." },
    { operation: "list_inventory", apiSupported: true, toolAvailable: true, access: "read_only", note: "Official Inventory API." },
    { operation: "update_inventory", apiSupported: true, toolAvailable: false, access: "read_write", note: "Official API supports adjustments; guarded inventory mutations are not implemented." },
    { operation: "identify_out_of_stock", apiSupported: true, toolAvailable: false, access: "read_only", note: "Inventory is readable, but the stock response has not been normalized into verified availability semantics." },
    { operation: "inspect_inventory_settings", apiSupported: "unverified", toolAvailable: false, access: "unverified", note: "No inventory-settings endpoint or verified UI workflow was found in the reviewed documentation." },
    { operation: "list_product_categories", apiSupported: "unverified", toolAvailable: false, access: "unverified", note: "No Categories API was found in the reviewed official API documentation; product tags are not treated as categories." },
    { operation: "manage_product_categories", apiSupported: "unverified", toolAvailable: false, access: "unverified", note: "No Categories API was found in the reviewed official API documentation; collections are not assumed to be categories." },
    { operation: "list_collections", apiSupported: "unverified", toolAvailable: false, access: "unverified", note: "No collections endpoint was found in the reviewed official API documentation." },
    { operation: "manage_collections", apiSupported: "unverified", toolAvailable: false, access: "unverified", note: "No collections endpoint was found in the reviewed official API documentation." },
    { operation: "list_orders", apiSupported: true, toolAvailable: true, access: "read_only", note: "Official Orders API; customer contact and address fields are removed from results." },
    { operation: "get_order_details", apiSupported: "unverified", toolAvailable: false, access: "unverified", note: "A single-order endpoint was not verified in the reviewed documentation." },
    { operation: "manage_orders", apiSupported: true, toolAvailable: false, access: "read_write", note: "No order mutations, refunds, or fulfillment actions are exposed." },
    { operation: "list_discounts", apiSupported: true, toolAvailable: true, access: "read_only", note: "Official Discounts API; listing does not activate or modify discounts." },
    { operation: "manage_discounts", apiSupported: true, toolAvailable: false, access: "read_write", note: "Not exposed; creating or updating discounts requires dedicated backup and authorization controls." },
  ],
};

interface SquarespaceSiteIdentity {
  siteId: string;
  url: string;
}

export interface SquarespaceCommerceProviderOptions {
  apiKey?: string;
  expectedSiteId?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class SquarespaceCommerceProvider implements CommerceProvider {
  readonly providerName = "squarespace";
  private readonly apiKey: string | undefined;
  private readonly expectedSiteId: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: SquarespaceCommerceProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.expectedSiteId = options.expectedSiteId?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs must be a positive safe integer in milliseconds.");
    }
  }

  getCapabilities(): CommerceCapabilityReport {
    return structuredClone(capabilities);
  }

  async verifyWebsite(
    websiteId: string,
    websiteUrl: string,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    this.requireConfiguration();
    if (!websiteId.trim()) {
      throw new SquarespaceBrowserError("COMMERCE_TARGET_MISMATCH", "A website ID is required.");
    }

    const data = await this.request("/1.0/authorization/website", execution);
    const identity = parseSiteIdentity(data);
    if (identity.siteId !== this.expectedSiteId) {
      throw new SquarespaceBrowserError(
        "COMMERCE_TARGET_MISMATCH",
        "The API key is associated with a different configured Squarespace site.",
      );
    }

    let browserOrigin: string;
    let apiOrigin: string;
    try {
      browserOrigin = new URL(websiteUrl).origin;
      apiOrigin = new URL(identity.url).origin;
    } catch (error) {
      throw new SquarespaceBrowserError(
        "COMMERCE_TARGET_MISMATCH",
        "The selected Squarespace website has an invalid URL.",
        { cause: error },
      );
    }
    if (browserOrigin !== apiOrigin) {
      throw new SquarespaceBrowserError(
        "COMMERCE_TARGET_MISMATCH",
        "The selected browser website does not match the website bound to the Commerce API key.",
      );
    }
  }

  async listProducts(cursor?: string, execution?: BrowserExecutionContext): Promise<CommercePage<Record<string, unknown>>> {
    const query = new URLSearchParams();
    if (cursor !== undefined) query.set("cursor", cursorSchema.parse(cursor));
    const data = await this.request(`/v2/commerce/products${queryString(query)}`, execution);
    return parseCursorPage(data, ["products", "result"], "product");
  }

  async getProductDetails(productId: string, execution?: BrowserExecutionContext): Promise<Record<string, unknown>> {
    const id = productIdSchema.parse(productId);
    const data = await this.request(`/v2/commerce/products/${encodeURIComponent(id)}`, execution);
    const products = parseItems(data, ["products", "result"], "product details");
    const matching = products.filter((product) => product.id === id);
    if (matching.length !== 1) {
      throw new SquarespaceBrowserError(
        "COMMERCE_RESPONSE_INVALID",
        "Squarespace did not return exactly one product matching the requested ID.",
      );
    }
    return matching[0]!;
  }

  async listInventory(cursor?: string, execution?: BrowserExecutionContext): Promise<CommercePage<Record<string, unknown>>> {
    const query = new URLSearchParams();
    if (cursor !== undefined) query.set("cursor", cursorSchema.parse(cursor));
    const data = await this.request(`/1.0/commerce/inventory${queryString(query)}`, execution);
    return parseCursorPage(data, ["inventory", "result"], "inventory item", true);
  }

  async listOrders(cursor?: string, execution?: BrowserExecutionContext): Promise<CommercePage<SafeOrderSummary>> {
    const query = new URLSearchParams();
    if (cursor !== undefined) query.set("cursor", cursorSchema.parse(cursor));
    const data = await this.request(`/1.0/commerce/orders${queryString(query)}`, execution);
    const page = parseCursorPage(data, ["result", "orders"], "order");
    return { ...page, items: page.items.map(toSafeOrderSummary) };
  }

  async listDiscounts(
    offset: number,
    limit: number,
    execution?: BrowserExecutionContext,
  ): Promise<CommercePage<Record<string, unknown>>> {
    const query = new URLSearchParams({
      offset: String(offsetSchema.parse(offset)),
      limit: String(limitSchema.parse(limit)),
    });
    const data = await this.request(`/v1/commerce/discounts?${query.toString()}`, execution);
    const record = asRecord(data, "discount page");
    const items = parseItemsFromRecord(record, ["discounts", "result"], "discount");
    const pageInfo = asRecord(record.pagination, "discount pagination");
    if (typeof pageInfo.hasNextPage !== "boolean") {
      throw invalidResponse("Squarespace returned invalid discount pagination metadata.");
    }
    return {
      items,
      hasNextPage: pageInfo.hasNextPage,
      nextCursor: null,
      ...(pageInfo.hasNextPage ? { nextOffset: offset + items.length } : {}),
    };
  }

  private requireConfiguration(): void {
    if (!this.apiKey || !this.expectedSiteId) {
      throw new SquarespaceBrowserError(
        "COMMERCE_API_NOT_CONFIGURED",
        "Read-only Squarespace Commerce tools require SQUARESPACE_API_KEY and SQUARESPACE_SITE_ID in the server process environment.",
      );
    }
  }

  private async request(
    path: string,
    execution?: BrowserExecutionContext,
  ): Promise<unknown> {
    this.requireConfiguration();
    execution?.checkpoint();
    const timeoutMs = Math.max(
      1,
      Math.min(this.requestTimeoutMs, execution?.remainingMs ?? this.requestTimeoutMs),
    );
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = execution
      ? AbortSignal.any([execution.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_ORIGIN}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": USER_AGENT,
        },
        signal,
      });
    } catch (error) {
      if (execution?.signal.aborted) throw stopReasonFromSignal(execution.signal);
      if (timeoutSignal.aborted) {
        throw new ExecutionStoppedError("api_request_timeout");
      }
      throw new SquarespaceBrowserError(
        "COMMERCE_API_REQUEST_FAILED",
        "The Squarespace Commerce API request could not be completed.",
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new SquarespaceBrowserError(
        response.status === 401 || response.status === 403
          ? "COMMERCE_API_AUTHORIZATION_FAILED"
          : "COMMERCE_API_REQUEST_FAILED",
        response.status === 401 || response.status === 403
          ? "Squarespace rejected the Commerce API credentials or their read permissions."
          : `Squarespace Commerce API request failed with HTTP ${response.status}.`,
      );
    }
    try {
      const body: unknown = await response.json();
      return body;
    } catch (error) {
      if (execution?.signal.aborted) throw stopReasonFromSignal(execution.signal);
      if (timeoutSignal.aborted) {
        throw new ExecutionStoppedError("api_request_timeout");
      }
      throw invalidResponse("Squarespace returned a response that was not valid JSON.");
    }
  }
}

function parseSiteIdentity(value: unknown): SquarespaceSiteIdentity {
  const record = asRecord(value, "website identity");
  if (
    typeof record.siteId !== "string" ||
    record.siteId.length === 0 ||
    typeof record.url !== "string" ||
    record.url.length === 0
  ) {
    throw invalidResponse("Squarespace returned incomplete website identity data.");
  }
  return { siteId: record.siteId, url: record.url };
}

function parseCursorPage(
  value: unknown,
  itemKeys: string[],
  itemLabel: string,
  allowUnpaginatedArray = false,
): CommercePage<Record<string, unknown>> {
  if (Array.isArray(value) && allowUnpaginatedArray) {
    return {
      items: validateItems(value, itemLabel),
      hasNextPage: null,
      nextCursor: null,
    };
  }
  const record = asRecord(value, `${itemLabel} page`);
  const items = parseItemsFromRecord(record, itemKeys, itemLabel);
  const pagination = asRecord(record.pagination, `${itemLabel} pagination`);
  if (
    typeof pagination.hasNextPage !== "boolean" ||
    (pagination.nextPageCursor !== undefined &&
      pagination.nextPageCursor !== null &&
      typeof pagination.nextPageCursor !== "string")
  ) {
    throw invalidResponse(`Squarespace returned invalid ${itemLabel} pagination metadata.`);
  }
  const nextCursor = pagination.nextPageCursor ?? null;
  if (pagination.hasNextPage && !nextCursor) {
    throw invalidResponse(`Squarespace indicated more ${itemLabel} results without a cursor.`);
  }
  return { items, hasNextPage: pagination.hasNextPage, nextCursor };
}

function parseItems(
  value: unknown,
  itemKeys: string[],
  itemLabel: string,
): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return validateItems(value, itemLabel);
  return parseItemsFromRecord(asRecord(value, `${itemLabel} list`), itemKeys, itemLabel);
}

function parseItemsFromRecord(
  record: Record<string, unknown>,
  itemKeys: string[],
  itemLabel: string,
): Array<Record<string, unknown>> {
  for (const key of itemKeys) {
    if (Object.hasOwn(record, key)) {
      if (!Array.isArray(record[key])) {
        throw invalidResponse(`Squarespace returned an invalid ${itemLabel} list.`);
      }
      return validateItems(record[key], itemLabel);
    }
  }
  throw invalidResponse(`Squarespace response did not contain the documented ${itemLabel} list.`);
}

function validateItems(value: unknown, itemLabel: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw invalidResponse(`Squarespace returned an invalid ${itemLabel} list.`);
  }
  return value.map((item) => asRecord(item, itemLabel));
}

function toSafeOrderSummary(order: Record<string, unknown>): SafeOrderSummary {
  if (typeof order.id !== "string" || !order.id) {
    throw invalidResponse("Squarespace returned an order without an ID.");
  }
  if (!Array.isArray(order.lineItems)) {
    throw invalidResponse("Squarespace returned an order without line items.");
  }
  if (order.fulfillments !== undefined && !Array.isArray(order.fulfillments)) {
    throw invalidResponse("Squarespace returned invalid order fulfillment data.");
  }
  const lineItems = order.lineItems;
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  return {
    id: order.id,
    orderNumber: optionalString(order.orderNumber),
    createdOn: optionalString(order.createdOn),
    modifiedOn: optionalString(order.modifiedOn),
    fulfillmentStatus: optionalString(order.fulfillmentStatus),
    paymentState: optionalString(order.paymentState),
    grandTotal: safeMoney(order.grandTotal, "order total"),
    lineItems: lineItems.map((item) => {
      const line = asRecord(item, "order line item");
      return {
        id: optionalString(line.id),
        productId: optionalString(line.productId),
        productName: optionalString(line.productName),
        quantity: typeof line.quantity === "number" ? line.quantity : null,
        sku: optionalString(line.sku),
        variantId: optionalString(line.variantId),
        unitPricePaid: safeMoney(line.unitPricePaid, "line-item price"),
      };
    }),
    fulfillments: fulfillments.map((item) => {
      const fulfillment = asRecord(item, "order fulfillment");
      return {
        carrierName: optionalString(fulfillment.carrierName),
        service: optionalString(fulfillment.service),
        shipDate: optionalString(fulfillment.shipDate),
      };
    }),
  };
}

function safeMoney(
  value: unknown,
  label: string,
): { currency: string; value: number } | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value, label);
  if (
    typeof record.currency !== "string" ||
    !/^[A-Z]{3}$/.test(record.currency) ||
    typeof record.value !== "number" ||
    !Number.isFinite(record.value)
  ) {
    throw invalidResponse(`Squarespace returned an invalid ${label}.`);
  }
  return { currency: record.currency, value: record.value };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidResponse(`Squarespace returned an invalid ${label}.`);
  }
  return value;
}

function queryString(query: URLSearchParams): string {
  return query.size > 0 ? `?${query.toString()}` : "";
}

function invalidResponse(message: string): SquarespaceBrowserError {
  return new SquarespaceBrowserError("COMMERCE_RESPONSE_INVALID", message);
}
