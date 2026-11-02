import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PageBackupService } from "./backups/page-backup.service.js";
import { SquarespaceBrowserService } from "./browser/squarespace-browser.service.js";
import { BrowserOperationLock } from "./browser/browser-operation-lock.js";
import { PlaywrightBrowserProvider } from "./browser/playwright-browser.provider.js";
import { SquarespaceContentService } from "./browser/squarespace-content.service.js";
import { SquarespaceCommerceProvider } from "./commerce/squarespace-commerce.provider.js";
import { SquarespaceCommerceService } from "./commerce/squarespace-commerce.service.js";
import { SquarespaceDesignService } from "./browser/squarespace-design.service.js";
import { SquarespaceNavigationSeoSettingsService } from "./browser/squarespace-navigation-seo-settings.service.js";
import { SquarespacePagesService } from "./browser/squarespace-pages.service.js";
import { registerDesignTools } from "./tools/design-tools.js";
import { registerContentTools } from "./tools/content-tools.js";
import { registerCommerceTools } from "./tools/commerce-tools.js";
import { registerNavigationSeoSettingsTools } from "./tools/navigation-seo-settings-tools.js";
import { registerPagesTools } from "./tools/pages-tools.js";
import { registerWorkflowTools } from "./tools/workflow-tools.js";
import { registerHeroTools } from "./tools/hero-tools.js";
import { registerSettingsChangePlanningTools } from "./tools/settings-change-planning-tools.js";
import { SettingsChangePlanner } from "./planning/settings-change-planner.js";
import { SquarespaceSettingsPlanningProvider } from "./planning/providers/squarespace-settings-planning-provider.js";
import { SettingsExecutionService } from "./execution/settings-execution-service.js";
import { registerSettingsExecutionTools } from "./tools/settings-execution-tools.js";
import { SquarespaceWorkflowAdapter } from "./workflow/squarespace-workflow.adapter.js";
import { WebsiteWorkflowService } from "./workflow/website-workflow.service.js";
import { logError } from "./utils/logger.js";
import { MutationApprovalGuard } from "./approval/mutation-approval.js";
import { McpHumanApprovalPrompt } from "./approval/mcp-human-approval.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "squarespace-mcp-server",
    version: "0.1.0",
  });
  const mutationApproval = new MutationApprovalGuard(
    new McpHumanApprovalPrompt(server.server),
  );
  const browserOperationLock = new BrowserOperationLock();
  const browser = new SquarespaceBrowserService();
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
    approval: mutationApproval,
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
  const transport = new StdioServerTransport();

  registerPagesTools(server, pages, backups, browserOperationLock);
  registerDesignTools(server, design, browserOperationLock);
  registerContentTools(server, content, browserOperationLock);
  registerCommerceTools(server, commerce);
  registerNavigationSeoSettingsTools(server, navigationSeoSettings, browserOperationLock);
  registerSettingsChangePlanningTools(
    server,
    settingsChangePlanner,
    browserOperationLock,
  );
  registerSettingsExecutionTools(server, settingsExecution, browserOperationLock);
  registerWorkflowTools(server, workflow, browserOperationLock);
  registerHeroTools(server);
  transport.onclose = () => {
    void browserOperationLock.runExclusive(() => browser.close()).catch((error: unknown) => {
      logError("browser_close_failed", error);
    });
  };
  await server.connect(transport);

  const shutdown = async (): Promise<void> => {
    await server.close();
    await browserOperationLock.runExclusive(() => browser.close());
  };
  process.once("SIGINT", () => {
    void shutdown().catch((error: unknown) => {
      logError("server_shutdown_failed", error);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    void shutdown().catch((error: unknown) => {
      logError("server_shutdown_failed", error);
      process.exitCode = 1;
    });
  });
}

main().catch((error: unknown) => {
  logError("server_start_failed", error);
  process.exitCode = 1;
});
