import { createHash } from "node:crypto";
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
  "add_text_block",
  "edit_text_block",
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
  add_text_block: {
    toolName: "add_text_block",
    readOnly: false,
    approvalRequired: true,
    retrySafe: false,
  },
  edit_text_block: {
    toolName: "edit_text_block",
    readOnly: false,
    approvalRequired: true,
    retrySafe: false,
  },
  create_page: {
    toolName: "create_page",
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
  "add_text_block",
  "edit_text_block",
  "create_page",
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
          limitation: null,
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
    if (action === "add_text_block" || action === "edit_text_block") {
      const pageId = required(args.page_id, action);
      const sectionId = required(args.section_id, action);
      const inspection = await this.services.pages.inspectPageSections(websiteId, pageId);
      if (inspection.sectionsTruncated || inspection.sections.some((section) =>
        section.blocksTruncated || section.textTruncated || section.blocks.some((block) => block.textTruncated))) {
        throw new SquarespaceBrowserError(
          "WORKFLOW_BASELINE_UNAVAILABLE",
          "The target page inspection is truncated; the Text Block target cannot be established safely.",
        );
      }
      const matchingSections = inspection.sections.filter((section) => section.id === sectionId);
      if (matchingSections.length !== 1) {
        throw new SquarespaceBrowserError(
          matchingSections.length ? "SECTION_NOT_FOUND" : "SECTION_NOT_FOUND",
          "The supplied section ID does not identify exactly one section on the selected page.",
        );
      }
      const section = matchingSections[0]!;
      if (action === "edit_text_block") {
        const matches = section.blocks.filter((block) => block.id === args.block_id);
        if (matches.length !== 1) {
          throw new SquarespaceBrowserError(
            matches.length ? "CONTENT_BLOCK_AMBIGUOUS" : "CONTENT_BLOCK_NOT_FOUND",
            "The supplied block ID does not identify exactly one block in the selected section.",
          );
        }
        if (!isTextBlock(matches[0]!)) {
          throw new SquarespaceBrowserError(
            "BLOCK_EDITOR_NOT_AVAILABLE",
            "Only an identified native Text Block can be edited by this workflow.",
          );
        }
      }
      return null;
    }
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

  async captureBaseline(
    action: WorkflowAction,
    websiteId: string,
    args: PlannedTaskInput,
  ): Promise<{ resourceKey: string; fingerprint: string } | null> {
    if (action === "create_page") {
      const pages = await this.services.pages.listPages(websiteId);
      return {
        resourceKey: `website:${websiteId}:page-list`,
        fingerprint: hashBaseline(pages.map((page) => ({
          id: page.id,
          name: page.name,
          url: page.url,
          type: page.type,
          group: page.group,
          parentId: page.parentId,
        }))),
      };
    }
    if (action === "add_text_block" || action === "edit_text_block") {
      const pageId = required(args.page_id, action);
      const sectionId = required(args.section_id, action);
      const inspection = await this.services.pages.inspectPageSections(websiteId, pageId);
      const section = inspection.sections.find((candidate) => candidate.id === sectionId);
      if (!section || inspection.sectionsTruncated || inspection.sections.some((candidate) =>
        candidate.blocksTruncated || candidate.textTruncated || candidate.blocks.some((block) => block.textTruncated))) {
        throw new SquarespaceBrowserError(
          "WORKFLOW_BASELINE_UNAVAILABLE",
          "The target section is missing or truncated; refusing to authorize a content mutation.",
        );
      }
      return {
        resourceKey: `page:${pageId}:section:${sectionId}`,
        fingerprint: hashBaseline({ websiteId, pageId, url: inspection.url, sections: inspection.sections }),
      };
    }
    if (action !== "add_text_section") return null;
    const pageId = required(args.page_id, action);
    const page = await this.services.pages.getPageDetails(websiteId, pageId);
    if (page.websiteId !== websiteId || !page.url || page.type !== "page") {
      throw new SquarespaceBrowserError(
        "WORKFLOW_BASELINE_UNAVAILABLE",
        "The requested page cannot be safely baselined on the selected website.",
      );
    }
    const inspection = await this.services.pages.inspectPageSections(websiteId, pageId);
    if (
      inspection.sectionsTruncated ||
      inspection.sections.some((section) =>
        section.textTruncated || section.blocksTruncated || section.blocks.some((block) => block.textTruncated))
    ) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_BASELINE_UNAVAILABLE",
        "The page is too large or truncated to establish a safe content baseline.",
      );
    }
    return {
      resourceKey: `page:${pageId}`,
      fingerprint: hashBaseline({
        websiteId,
        pageId,
        url: inspection.url,
        sections: inspection.sections,
      }),
    };
  }

  async verifyWebsite(
    websiteId: string,
    execution?: WorkflowExecutionContext,
  ): Promise<{
    id: string;
    name: string;
    url: string;
    sessionContextId?: string;
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
      ...(result.data.sessionContextId
        ? { sessionContextId: result.data.sessionContextId }
        : {}),
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
      case "create_page": {
        const title = (args.text ?? args.page_id ?? "New Page").trim();
        return this.services.pages.createPage(
          website.id,
          title,
          "page",
          "main_navigation",
        );
      }
      case "add_text_section":
        if (!args.text) {
          throw new SquarespaceBrowserError(
            "WORKFLOW_EXECUTION_FAILED",
            "The add_text_section task requires text.",
          );
        }
        return this.services.content.addTextSection({
          website_id: website.id,
          page_id: required(pageId, action),
          text: args.text,
          background_color: args.background_color ?? "#FFFFFF",
          text_color: args.text_color ?? "#000000",
          confirm_potentially_live_save: args.confirm_potentially_live_save,
        }, execution?.browser, execution?.taskAuthorization);
      case "add_text_block":
      case "edit_text_block":
        return this.services.content.mutateNativeTextBlock({
          website_id: website.id,
          page_id: required(pageId, action),
          section_id: required(args.section_id, action),
          ...(action === "edit_text_block" ? { block_id: required(args.block_id, action) } : {}),
          mode: action === "add_text_block" ? "create" : "edit",
          text: required(args.text, action),
        }, execution?.browser, execution?.taskAuthorization);
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

function hashBaseline(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isTextBlock(block: { type: string | null; definitionName?: string | null }): boolean {
  return /(?:^|[.\s_-])text(?:$|[.\s_-])/i.test(`${block.type ?? ""} ${block.definitionName ?? ""}`);
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
