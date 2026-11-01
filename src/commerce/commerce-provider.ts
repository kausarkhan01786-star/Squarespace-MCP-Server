export type CommerceOperation =
  | "list_products"
  | "get_product_details"
  | "create_product"
  | "update_product"
  | "manage_product_images"
  | "manage_product_variants"
  | "manage_product_availability"
  | "list_inventory"
  | "update_inventory"
  | "identify_out_of_stock"
  | "inspect_inventory_settings"
  | "list_product_categories"
  | "manage_product_categories"
  | "list_collections"
  | "manage_collections"
  | "list_orders"
  | "get_order_details"
  | "manage_orders"
  | "list_discounts"
  | "manage_discounts";

export interface CommerceCapability {
  operation: CommerceOperation;
  apiSupported: boolean | "unverified";
  toolAvailable: boolean;
  access: "read_only" | "read_write" | "unsupported" | "unverified";
  note: string;
}

export interface CommerceCapabilityReport {
  provider: string;
  capabilities: CommerceCapability[];
}

export interface CommercePage<T> {
  items: T[];
  hasNextPage: boolean | null;
  nextCursor: string | null;
  nextOffset?: number;
}

export interface CommerceProvider {
  readonly providerName: string;
  getCapabilities(): CommerceCapabilityReport;
  verifyWebsite(websiteId: string, websiteUrl: string): Promise<void>;
  listProducts?(cursor?: string): Promise<CommercePage<Record<string, unknown>>>;
  getProductDetails?(productId: string): Promise<Record<string, unknown>>;
  listInventory?(cursor?: string): Promise<CommercePage<Record<string, unknown>>>;
  listOrders?(cursor?: string): Promise<CommercePage<SafeOrderSummary>>;
  listDiscounts?(offset: number, limit: number): Promise<CommercePage<Record<string, unknown>>>;
}

export interface SafeOrderSummary {
  id: string;
  orderNumber: string | null;
  createdOn: string | null;
  modifiedOn: string | null;
  fulfillmentStatus: string | null;
  paymentState: string | null;
  grandTotal: { currency: string; value: number } | null;
  lineItems: Array<{
    id: string | null;
    productId: string | null;
    productName: string | null;
    quantity: number | null;
    sku: string | null;
    variantId: string | null;
    unitPricePaid: { currency: string; value: number } | null;
  }>;
  fulfillments: Array<{
    carrierName: string | null;
    service: string | null;
    shipDate: string | null;
  }>;
}
