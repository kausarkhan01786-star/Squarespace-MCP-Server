import { SquarespaceBrowserError } from "../browser/browser-errors.js";
import type { SquarespaceBrowserService, WebsiteSummary } from "../browser/squarespace-browser.service.js";
import type {
  CommerceOperation,
  CommerceCapabilityReport,
  CommercePage,
  CommerceProvider,
  SafeOrderSummary,
} from "./commerce-provider.js";

type CommerceBrowser = Pick<SquarespaceBrowserService, "getWebsite">;

export class SquarespaceCommerceService {
  constructor(
    private readonly browser: CommerceBrowser,
    private readonly provider: CommerceProvider,
  ) {}

  getCapabilities(): CommerceCapabilityReport {
    return this.provider.getCapabilities();
  }

  async listProducts(websiteId: string, cursor?: string): Promise<CommercePage<Record<string, unknown>>> {
    this.assertAvailable("list_products");
    await this.verifyTarget(websiteId);
    if (!this.provider.listProducts) this.throwUnavailable("list_products");
    const result = await this.provider.listProducts(cursor);
    this.logResult("list_products", websiteId, result.items.length);
    return result;
  }

  async getProductDetails(websiteId: string, productId: string): Promise<Record<string, unknown>> {
    this.assertAvailable("get_product_details");
    await this.verifyTarget(websiteId);
    if (!this.provider.getProductDetails) this.throwUnavailable("get_product_details");
    const result = await this.provider.getProductDetails(productId);
    this.logResult("get_product_details", websiteId, 1);
    return result;
  }

  async listInventory(websiteId: string, cursor?: string): Promise<CommercePage<Record<string, unknown>>> {
    this.assertAvailable("list_inventory");
    await this.verifyTarget(websiteId);
    if (!this.provider.listInventory) this.throwUnavailable("list_inventory");
    const result = await this.provider.listInventory(cursor);
    this.logResult("list_inventory", websiteId, result.items.length);
    return result;
  }

  async listOrders(websiteId: string, cursor?: string): Promise<CommercePage<SafeOrderSummary>> {
    this.assertAvailable("list_orders");
    await this.verifyTarget(websiteId);
    if (!this.provider.listOrders) this.throwUnavailable("list_orders");
    const result = await this.provider.listOrders(cursor);
    this.logResult("list_orders", websiteId, result.items.length);
    return result;
  }

  async listDiscounts(
    websiteId: string,
    offset: number,
    limit: number,
  ): Promise<CommercePage<Record<string, unknown>>> {
    this.assertAvailable("list_discounts");
    await this.verifyTarget(websiteId);
    if (!this.provider.listDiscounts) this.throwUnavailable("list_discounts");
    const result = await this.provider.listDiscounts(offset, limit);
    this.logResult("list_discounts", websiteId, result.items.length);
    return result;
  }

  private async verifyTarget(websiteId: string): Promise<void> {
    let website: WebsiteSummary;
    try {
      website = this.browser.getWebsite(websiteId);
    } catch (error) {
      if (error instanceof SquarespaceBrowserError) throw error;
      throw new SquarespaceBrowserError(
        "COMMERCE_TARGET_MISMATCH",
        "The selected website could not be verified in the authenticated browser session.",
        { cause: error },
      );
    }
    await this.provider.verifyWebsite(websiteId, website.url);
  }

  private assertAvailable(operation: CommerceOperation): void {
    if (!this.provider.getCapabilities().capabilities.some(
      (capability) => capability.operation === operation && capability.toolAvailable,
    )) {
      throw new SquarespaceBrowserError(
        "COMMERCE_CAPABILITY_UNAVAILABLE",
        `The ${operation} operation is not exposed by the selected commerce provider.`,
      );
    }
  }

  private throwUnavailable(operation: CommerceOperation): never {
    throw new SquarespaceBrowserError(
      "COMMERCE_CAPABILITY_UNAVAILABLE",
      `The ${operation} operation is declared available but not implemented by the selected commerce provider.`,
    );
  }

  private logResult(operation: CommerceOperation, websiteId: string, resultCount: number): void {
    console.info("[Squarespace commerce]", { operation, websiteId, resultCount });
  }
}
