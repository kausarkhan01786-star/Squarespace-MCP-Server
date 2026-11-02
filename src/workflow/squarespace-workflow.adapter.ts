import { SquarespaceBrowserError } from "../browser/browser-errors.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import type { BrowserProvider } from "../browser/browser-provider.js";
import type { PageBackupService } from "../backups/page-backup.service.js";
import type { SquarespaceCommerceService } from "../commerce/squarespace-commerce.service.js";
import type { SquarespaceContentService } from "../browser/squarespace-content.service.js";
import type { SquarespaceDesignService } from "../browser/squarespace-design.service.js";
import type { SquarespaceNavigationSeoSettingsService } from "../browser/squarespace-navigation-seo-settings.service.js";
import type { SquarespacePagesService } from "../browser/squarespace-pages.service.js";
import type {
  PlannedTaskInput,
  WorkflowAction,
  WorkflowAdapter,
  WorkflowCapability,
  WorkflowExecutionContext,
} from "./workflow-types.js";

type WorkflowServices = {
  browserProvider: BrowserProvider;
  pages: SquarespacePagesService;
  design: SquarespaceDesignService;
  settings: SquarespaceNavigationSeoSettingsService;
  backups: PageBackupService;
  content: SquarespaceContentService;
  commerce: SquarespaceCommerceService;
};

const ACTIONS: WorkflowAction[] = [
  "inspect_pages",
  "inspect_page",
  "inspect_page_sections",
  "inspect_responsive",
  "inspect_page_seo",
  "inspect_design",
  "backup_page",
  "inspect_products",
  "inspect_product",
  "inspect_inventory",
  "inspect_orders",
  "inspect_discounts",
  "add_text_section",
  "create_page",
  "edit_content_block",
  "manage_navigation",
  "set_site_design",
  "configure_custom_code",
  "publish_site",
  "manage_orders",
  "manage_products",
  "manage_inventory",
  "manage_discounts",
];

const IMPLEMENTED_TOOLS: Partial<Record<WorkflowAction, {
  toolName: string;
  readOnly: boolean;
  approvalRequired: boolean;
  retrySafe: boolean;
}>> = {
  inspect_pages: {
    toolName: "list_pages",
    readOnly: true,
    approvalRequired: false,
    retrySafe: true,
  },
  inspect_page: {
    toolName: "get_page_details",
    readOnly: true,
    approvalRequired: false,
    retrySafe: true,
  },
  inspect_page_sections: {
    toolName: "inspect_page_sections",
    readOnly: true,
    approvalRequired: false,
    retrySafe: true,
  },
  inspect_responsive: {
    toolName: "inspect_mobile_responsive",
    readOnly: true,
    approvalRequired: false,
    retrySafe: true,
  },
  inspect_page_seo: {
    toolName: "inspect_page_seo",
    readOnly: true,
    approvalRequired: false,
    retrySafe: true,
  },
  inspect_design: {
    toolName: "inspect_color_themes",
    readOnly: true,
    approvalRequired: false,
    retrySafe: true,
  },
  backup_page: {
    toolName: "create_page_snapshot",
    readOnly: true,
    approvalRequired: false,
    retrySafe: false,
  },
  add_text_section: {
    toolName: "add_text_section",
    readOnly: false,
    approvalRequired: true,
    retrySafe: false,
  },
};

const COMMERCE_TOOLS: Partial<Record<WorkflowAction, string>> = {
  inspect_products: "list_products",
  inspect_product: "get_product_details",
  inspect_inventory: "list_inventory",
  inspect_orders: "list_orders",
  inspect_discounts: "list_discounts",
};

const BROWSER_ACTIONS = new Set<WorkflowAction>([
  "inspect_pages",
  "inspect_page",
  "inspect_page_sections",
  "inspect_responsive",
  "inspect_page_seo",
  "inspect_design",
  "backup_page",
  "add_text_section",
]);

export class SquarespaceWorkflowAdapter implements WorkflowAdapter {
  readonly cms = "squarespace";

  constructor(
    private readonly services: WorkflowServices,
    private readonly browserOperationLock: BrowserOperationLock,
  ) {}

  getCapabilities(): WorkflowCapability[] {
    const commerceAvailability = new Map(
      this.services.commerce.getCapabilities().capabilities.map((capability) => [
        capability.operation,
        capability.toolAvailable,
      ]),
    );
    return ACTIONS.map((action) => {
      const implementation = IMPLEMENTED_TOOLS[action];
      if (implementation) {
        return {
          action,
          supported: true,
          ...implementation,
          limitation: action === "add_text_section"
            ? "Only the verified Kausar Mia Home-page workflow (pure white section and pure black text) is implemented; explicit task approval is mandatory."
            : null,
        };
      }
      const commerceTool = COMMERCE_TOOLS[action];
      if (commerceTool) {
        const operation = commerceOperationForAction(action);
        const available = commerceAvailability.get(operation) === true;
        return {
          action,
          supported: available,
          toolName: commerceTool,
          readOnly: true,
          approvalRequired: false,
          retrySafe: true,
          limitation: available
            ? null
            : "The Commerce API operation is not currently configured and exposed by this adapter.",
        };
      }
      return {
        action,
        supported: false,
        toolName: null,
        readOnly: false,
        approvalRequired: false,
        retrySafe: false,
        limitation: "No verified Squarespace workflow adapter operation is registered for this action.",
      };
    });
  }

  async validateTask(
    action: WorkflowAction,
    websiteId: string,
    args: PlannedTaskInput,
  ): Promise<string | null> {
    if (action !== "add_text_section") return null;
    try {
      await this.services.content.verifyHomePageTarget(
        websiteId,
        required(args.page_id, action),
      );
      return null;
    } catch (error) {
      if (
        error instanceof SquarespaceBrowserError &&
        (error.code === "TEXT_SECTION_TARGET_MISMATCH" ||
          error.code === "PAGE_NOT_FOUND")
      ) {
        return error.message;
      }
      throw error;
    }
  }

  async verifyWebsite(
    websiteId: string,
    execution?: WorkflowExecutionContext,
  ): Promise<{
    id: string;
    name: string;
    url: string;
  }> {
    let result: Awaited<ReturnType<BrowserProvider["verifyWebsite"]>>;
    try {
      execution?.browser.checkpoint();
      result = await this.services.browserProvider.verifyWebsite(
        websiteId,
        execution?.browser,
      );
    } catch (error) {
      if (error instanceof SquarespaceBrowserError && error.code === "INVALID_URL") {
        throw new SquarespaceBrowserError(
          "WORKFLOW_CMS_UNAVAILABLE",
          "The selected website URL is not an allowed Squarespace website. No platform switching is permitted.",
          { cause: error },
        );
      }
      throw error;
    }
    if (result.status === "unsupported") {
      throw new SquarespaceBrowserError(
        "BROWSER_CAPABILITY_UNAVAILABLE",
        `Cannot verify the selected website: ${result.reason}`,
      );
    }
    return {
      id: result.data.id,
      name: result.data.name,
      url: result.data.url,
    };
  }

  async execute(
    action: WorkflowAction,
    websiteId: string,
    args: PlannedTaskInput,
    execution?: WorkflowExecutionContext,
  ): Promise<unknown> {
    const operation = () => this.executeTask(action, websiteId, args, execution);
    if (!execution) return operation();
    if (!BROWSER_ACTIONS.has(action)) {
      return operation();
    }
    return this.browserOperationLock.runExclusive(operation, {
      signal: execution.signal,
      deadlineAt: execution.deadlineAt,
      executionContext: execution.browser,
      onAbort: () => this.services.browserProvider.cancelActiveOperation?.(),
    });
  }

  private async executeTask(
    action: WorkflowAction,
    websiteId: string,
    args: PlannedTaskInput,
    execution?: WorkflowExecutionContext,
  ): Promise<unknown> {
    execution?.browser.checkpoint();
    const website = await this.verifyWebsite(websiteId, execution);
    const pageId = args.page_id;
    switch (action) {
      case "inspect_pages":
        return this.services.pages.listPages(website.id);
      case "inspect_page":
        return this.services.pages.getPageDetails(website.id, required(pageId, action));
      case "inspect_page_sections":
        return this.services.pages.inspectPageSections(website.id, required(pageId, action));
      case "inspect_responsive":
        return this.services.pages.inspectMobileResponsive(website.id, required(pageId, action));
      case "inspect_page_seo":
        return this.services.settings.inspectPageSeo(website.id, required(pageId, action));
      case "inspect_design":
        return this.services.design.inspectColorThemes(website.id, required(pageId, action));
      case "backup_page":
        return this.services.backups.createPageSnapshot(website.id, required(pageId, action));
      case "inspect_products":
        return this.services.commerce.listProducts(website.id, args.cursor, execution?.browser);
      case "inspect_product":
        return this.services.commerce.getProductDetails(
          website.id,
          required(args.product_id, action),
          execution?.browser,
        );
      case "inspect_inventory":
        return this.services.commerce.listInventory(website.id, args.cursor, execution?.browser);
      case "inspect_orders":
        return this.services.commerce.listOrders(website.id, args.cursor, execution?.browser);
      case "inspect_discounts":
        return this.services.commerce.listDiscounts(
          website.id,
          args.offset ?? 0,
          args.limit ?? 50,
          execution?.browser,
        );
      case "add_text_section":
        if (!args.text || args.confirm_potentially_live_save !== true) {
          throw new SquarespaceBrowserError(
            args.confirm_potentially_live_save !== true
              ? "CONFIRMATION_REQUIRED"
              : "WORKFLOW_EXECUTION_FAILED",
            args.confirm_potentially_live_save !== true
              ? "The workflow task must explicitly authorize a potentially live Squarespace Save."
              : "The add_text_section task requires text.",
          );
        }
        return this.services.content.addTextSection({
          website_id: website.id,
          page_id: required(pageId, action),
          text: args.text,
          background_color: "#FFFFFF",
          text_color: "#000000",
          confirm_potentially_live_save: args.confirm_potentially_live_save,
        }, execution?.browser);
      default:
        throw new SquarespaceBrowserError(
          "WORKFLOW_CMS_UNAVAILABLE",
          `Squarespace workflow action "${action}" is not supported by this adapter.`,
        );
    }
  }
}

function required(value: string | undefined, action: WorkflowAction): string {
  if (value) return value;
  throw new SquarespaceBrowserError(
    "WORKFLOW_EXECUTION_FAILED",
    `The ${action} task is missing a required identifier.`,
  );
}

function commerceOperationForAction(action: WorkflowAction):
  | "list_products"
  | "get_product_details"
  | "list_inventory"
  | "list_orders"
  | "list_discounts" {
  switch (action) {
    case "inspect_products":
      return "list_products";
    case "inspect_product":
      return "get_product_details";
    case "inspect_inventory":
      return "list_inventory";
    case "inspect_orders":
      return "list_orders";
    case "inspect_discounts":
      return "list_discounts";
    default:
      throw new SquarespaceBrowserError(
        "WORKFLOW_CMS_UNAVAILABLE",
        `No commerce operation is mapped for ${action}.`,
      );
  }
}
