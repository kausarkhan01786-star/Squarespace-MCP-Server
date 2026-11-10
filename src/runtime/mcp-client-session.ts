import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PageBackupService } from "../backups/page-backup.service.js";
import { MutationApprovalGuard } from "../approval/mutation-approval.js";
import { McpHumanApprovalPrompt } from "../approval/mcp-human-approval.js";
import { SquarespaceBrowserService } from "../browser/squarespace-browser.service.js";
import { PlaywrightBrowserProvider } from "../browser/playwright-browser.provider.js";
import { SquarespaceContentService } from "../browser/squarespace-content.service.js";
import { SquarespaceCommerceProvider } from "../commerce/squarespace-commerce.provider.js";
import { SquarespaceCommerceService } from "../commerce/squarespace-commerce.service.js";
import { SquarespaceDesignService } from "../browser/squarespace-design.service.js";
import { SquarespaceNavigationSeoSettingsService } from "../browser/squarespace-navigation-seo-settings.service.js";
import { SquarespacePagesService } from "../browser/squarespace-pages.service.js";
import { SettingsChangePlanner } from "../planning/settings-change-planner.js";
import { SquarespaceSettingsPlanningProvider } from "../planning/providers/squarespace-settings-planning-provider.js";
import { SettingsExecutionService } from "../execution/settings-execution-service.js";
import { SquarespaceWorkflowAdapter } from "../workflow/squarespace-workflow.adapter.js";
import { WebsiteWorkflowService } from "../workflow/website-workflow.service.js";
import { registerDesignTools } from "../tools/design-tools.js";
import { registerContentTools } from "../tools/content-tools.js";
import { registerCommerceTools } from "../tools/commerce-tools.js";
import { registerNavigationSeoSettingsTools } from "../tools/navigation-seo-settings-tools.js";
import { registerPagesTools } from "../tools/pages-tools.js";
import { registerWorkflowTools } from "../tools/workflow-tools.js";
import { registerHeroTools } from "../tools/hero-tools.js";
import { registerSettingsChangePlanningTools } from "../tools/settings-change-planning-tools.js";
import { registerSettingsExecutionTools } from "../tools/settings-execution-tools.js";
import type { SharedBrowserRuntime } from "./shared-browser-runtime.js";

export interface McpClientSession {
  readonly runtime: SharedBrowserRuntime;
  readonly browserOperationLock: SharedBrowserRuntime["operationLock"];
  readonly server: McpServer;
  readonly transport: Transport;
  readonly mutationApproval: MutationApprovalGuard;
  readonly workflow: WebsiteWorkflowService;
  /** Closes this MCP session only; shared browser ownership remains with the runtime. */
  close(): Promise<void>;
}

export interface McpClientSessionOptions {
  serverName?: string;
  serverVersion?: string;
}

/** Creates isolated authorization/workflow state over the process-shared browser runtime. */
export function createMcpClientSession(
  runtime: SharedBrowserRuntime,
  transport: Transport,
  options: McpClientSessionOptions = {},
): McpClientSession {
  const server = new McpServer({
    name: options.serverName ?? "squarespace-mcp-server",
    version: options.serverVersion ?? "0.1.0",
  });
  const mutationApproval = new MutationApprovalGuard(
    new McpHumanApprovalPrompt(server.server),
  );
  const browser: SquarespaceBrowserService = runtime.browser;
  const browserOperationLock = runtime.operationLock;
  const pages = new SquarespacePagesService(browser, mutationApproval);
  const browserProvider = new PlaywrightBrowserProvider(browser, pages);
  const design = new SquarespaceDesignService(browser, pages);
  const navigationSeoSettings =
    new SquarespaceNavigationSeoSettingsService(browser, pages);
  const settingsChangePlanner = new SettingsChangePlanner(new Map([
    ["squarespace", new SquarespaceSettingsPlanningProvider(browser, navigationSeoSettings)],
  ]));
  const settingsExecution = new SettingsExecutionService({
    planner: settingsChangePlanner,
    providers: new Map(),
  });
  const backups = new PageBackupService(pages, browser);
  const content = new SquarespaceContentService(browser, pages, backups, mutationApproval);
  const commerceProvider = new SquarespaceCommerceProvider({
    ...(process.env.SQUARESPACE_API_KEY
      ? { apiKey: process.env.SQUARESPACE_API_KEY }
      : {}),
    ...(process.env.SQUARESPACE_SITE_ID
      ? { expectedSiteId: process.env.SQUARESPACE_SITE_ID }
      : {}),
  });
  const commerce = new SquarespaceCommerceService(browser, commerceProvider);
  const workflow = new WebsiteWorkflowService(new Map([
    ["squarespace", new SquarespaceWorkflowAdapter({
      browserProvider,
      pages,
      design,
      settings: navigationSeoSettings,
      backups,
      content,
      commerce,
    }, browserOperationLock)],
  ]), mutationApproval);

  registerPagesTools(server, pages, backups, browserOperationLock);
  registerDesignTools(server, design, browserOperationLock);
  registerContentTools(server, content, browserOperationLock);
  registerCommerceTools(server, commerce, browserOperationLock);
  registerNavigationSeoSettingsTools(server, navigationSeoSettings, browserOperationLock);
  registerSettingsChangePlanningTools(server, settingsChangePlanner, browserOperationLock);
  registerSettingsExecutionTools(server, settingsExecution, browserOperationLock);
  registerWorkflowTools(server, workflow, browserOperationLock);
  registerHeroTools(server);

  let closePromise: Promise<void> | undefined;
  return {
    runtime,
    browserOperationLock,
    server,
    transport,
    mutationApproval,
    workflow,
    close() {
      closePromise ??= server.close();
      return closePromise;
    },
  };
}
