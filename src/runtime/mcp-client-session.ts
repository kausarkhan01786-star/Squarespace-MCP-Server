import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MutationApprovalGuard } from "../approval/mutation-approval.js";
import { McpHumanApprovalPrompt } from "../approval/mcp-human-approval.js";
import { PageBackupService } from "../backups/page-backup.service.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import { PlaywrightBrowserProvider } from "../browser/playwright-browser.provider.js";
import { SquarespaceBrowserService } from "../browser/squarespace-browser.service.js";
import { SquarespaceContentService } from "../browser/squarespace-content.service.js";
import { SquarespaceDesignService } from "../browser/squarespace-design.service.js";
import { SquarespaceNavigationSeoSettingsService } from "../browser/squarespace-navigation-seo-settings.service.js";
import { SquarespacePagesService } from "../browser/squarespace-pages.service.js";
import { SquarespaceCommerceProvider } from "../commerce/squarespace-commerce.provider.js";
import { SquarespaceCommerceService } from "../commerce/squarespace-commerce.service.js";
import { SettingsExecutionService } from "../execution/settings-execution-service.js";
import { SettingsChangePlanner } from "../planning/settings-change-planner.js";
import { SquarespaceSettingsPlanningProvider } from "../planning/providers/squarespace-settings-planning-provider.js";
import { registerCommerceTools } from "../tools/commerce-tools.js";
import { registerContentTools } from "../tools/content-tools.js";
import { registerDesignTools } from "../tools/design-tools.js";
import { registerHeroTools } from "../tools/hero-tools.js";
import { registerNavigationSeoSettingsTools } from "../tools/navigation-seo-settings-tools.js";
import { registerPagesTools } from "../tools/pages-tools.js";
import { registerSettingsChangePlanningTools } from "../tools/settings-change-planning-tools.js";
import { registerSettingsExecutionTools } from "../tools/settings-execution-tools.js";
import { registerWorkflowTools } from "../tools/workflow-tools.js";
import { SquarespaceWorkflowAdapter } from "../workflow/squarespace-workflow.adapter.js";
import { WebsiteWorkflowService } from "../workflow/website-workflow.service.js";
import type { SharedBrowserRuntime } from "./shared-browser-runtime.js";

export interface McpClientSessionOptions {
  sessionId?: string | undefined;
  sharedRuntime: SharedBrowserRuntime;
  operationLock: BrowserOperationLock;
  serverName?: string | undefined;
  serverVersion?: string | undefined;
}

export class McpClientSession {
  public readonly sessionId: string;
  public readonly server: McpServer;
  public readonly mutationApproval: MutationApprovalGuard;
  public readonly workflow: WebsiteWorkflowService;
  public isClosed = false;

  constructor(options: McpClientSessionOptions) {
    this.sessionId = options.sessionId ?? randomUUID();
    const serverName = options.serverName ?? "squarespace-mcp-server";
    const serverVersion = options.serverVersion ?? "0.1.0";

    this.server = new McpServer({
      name: serverName,
      version: serverVersion,
    });

    // Approval guard is isolated per MCP session
    this.mutationApproval = new MutationApprovalGuard(
      new McpHumanApprovalPrompt(this.server.server),
    );

    const browser = options.sharedRuntime.browserService;
    const lock = options.operationLock;

    const pages = new SquarespacePagesService(browser, this.mutationApproval);
    const browserProvider = new PlaywrightBrowserProvider(browser, pages);
    const design = new SquarespaceDesignService(browser, pages);
    const navigationSeoSettings = new SquarespaceNavigationSeoSettingsService(browser, pages);

    const settingsChangePlanner = new SettingsChangePlanner(
      new Map([
        ["squarespace", new SquarespaceSettingsPlanningProvider(browser, navigationSeoSettings)],
      ]),
    );

    const settingsExecution = new SettingsExecutionService({
      planner: settingsChangePlanner,
      providers: new Map(),
    });

    const backups = new PageBackupService(pages, browser);
    const content = new SquarespaceContentService(
      browser,
      pages,
      backups,
      this.mutationApproval,
    );

    const commerceProvider = new SquarespaceCommerceProvider({
      ...(process.env.SQUARESPACE_API_KEY
        ? { apiKey: process.env.SQUARESPACE_API_KEY }
        : {}),
      ...(process.env.SQUARESPACE_SITE_ID
        ? { expectedSiteId: process.env.SQUARESPACE_SITE_ID }
        : {}),
    });
    const commerce = new SquarespaceCommerceService(browser, commerceProvider);

    // Workflow state is isolated per MCP session
    this.workflow = new WebsiteWorkflowService(
      new Map([
        [
          "squarespace",
          new SquarespaceWorkflowAdapter(
            {
              browserProvider,
              pages,
              design,
              settings: navigationSeoSettings,
              backups,
              content,
              commerce,
            },
            lock,
          ),
        ],
      ]),
      this.mutationApproval,
    );

    // Register all 9 production tool groups onto this session's McpServer
    registerPagesTools(this.server, pages, backups, lock);
    registerDesignTools(this.server, design, lock);
    registerContentTools(this.server, content, lock);
    registerCommerceTools(this.server, commerce);
    registerNavigationSeoSettingsTools(this.server, navigationSeoSettings, lock);
    registerSettingsChangePlanningTools(this.server, settingsChangePlanner, lock);
    registerSettingsExecutionTools(this.server, settingsExecution, lock);
    registerWorkflowTools(this.server, this.workflow, lock);
    registerHeroTools(this.server);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      await this.server.close();
    } catch {
      // Ignore cleanup error on session close
    }
  }
}
