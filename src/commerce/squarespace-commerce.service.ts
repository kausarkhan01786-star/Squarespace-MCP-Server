import { SquarespaceBrowserError } from "../browser/browser-errors.js";
import type { BrowserExecutionContext } from "../browser/browser-execution-context.js";
import { logInfo } from "../utils/logger.js";
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

  async listProducts(websiteId: string, cursor?: string, execution?: BrowserExecutionContext): Promise<CommercePage<Record<string, unknown>>> {
    this.assertAvailable("list_products");
    await this.verifyTarget(websiteId, execution);
    if (!this.provider.listProducts) this.throwUnavailable("list_products");
    const result = await this.provider.listProducts(cursor, execution);
    this.logResult("list_products", result.items.length);
    return result;
  }

  async getProductDetails(websiteId: string, productId: string, execution?: BrowserExecutionContext): Promise<Record<string, unknown>> {
    this.assertAvailable("get_product_details");
    await this.verifyTarget(websiteId, execution);
    if (!this.provider.getProductDetails) this.throwUnavailable("get_product_details");
    const result = await this.provider.getProductDetails(productId, execution);
    this.logResult("get_product_details", 1);
    return result;
  }

  async listInventory(websiteId: string, cursor?: string, execution?: BrowserExecutionContext): Promise<CommercePage<Record<string, unknown>>> {
    this.assertAvailable("list_inventory");
    await this.verifyTarget(websiteId, execution);
    if (!this.provider.listInventory) this.throwUnavailable("list_inventory");
    const result = await this.provider.listInventory(cursor, execution);
    this.logResult("list_inventory", result.items.length);
    return result;
  }

  async listOrders(websiteId: string, cursor?: string, execution?: BrowserExecutionContext): Promise<CommercePage<SafeOrderSummary>> {
    this.assertAvailable("list_orders");
    await this.verifyTarget(websiteId, execution);
    if (!this.provider.listOrders) this.throwUnavailable("list_orders");
    const result = await this.provider.listOrders(cursor, execution);
    this.logResult("list_orders", result.items.length);
    return result;
  }

  async listDiscounts(
    websiteId: string,
    offset: number,
    limit: number,
    execution?: BrowserExecutionContext,
  ): Promise<CommercePage<Record<string, unknown>>> {
    this.assertAvailable("list_discounts");
    await this.verifyTarget(websiteId, execution);
    if (!this.provider.listDiscounts) this.throwUnavailable("list_discounts");
    const result = await this.provider.listDiscounts(offset, limit, execution);
    this.logResult("list_discounts", result.items.length);
    return result;
  }

  private async verifyTarget(
    websiteId: string,
    execution?: BrowserExecutionContext,
  ): Promise<void> {
    execution?.checkpoint();
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
    await this.provider.verifyWebsite(websiteId, website.url, execution);
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

  private logResult(operation: CommerceOperation, resultCount: number): void {
    logInfo("squarespace_commerce_result", { operation, resultCount });
  }
}
