import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PageBackupService } from "./backups/page-backup.service.js";
import { SquarespaceBrowserService } from "./browser/squarespace-browser.service.js";
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
import { SquarespaceWorkflowAdapter } from "./workflow/squarespace-workflow.adapter.js";
import { WebsiteWorkflowService } from "./workflow/website-workflow.service.js";

async function main(): Promise<void> {
  const browser = new SquarespaceBrowserService();
  const pages = new SquarespacePagesService(browser);
  const browserProvider = new PlaywrightBrowserProvider(browser, pages);
  const design = new SquarespaceDesignService(browser, pages);
  const navigationSeoSettings =
    new SquarespaceNavigationSeoSettingsService(browser, pages);
  const backups = new PageBackupService(pages, browser);
  const content = new SquarespaceContentService(browser, pages, backups);
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
    })],
  ]));
  const server = new McpServer({
    name: "squarespace-mcp-server",
    version: "0.1.0",
  });
  const transport = new StdioServerTransport();

  registerPagesTools(server, pages, backups);
  registerDesignTools(server, design);
  registerContentTools(server, content);
  registerCommerceTools(server, commerce);
  registerNavigationSeoSettingsTools(server, navigationSeoSettings);
  registerWorkflowTools(server, workflow);
  transport.onclose = () => {
    void browser.close().catch((error: unknown) => {
      console.error("Could not close the Squarespace browser cleanly.", error);
    });
  };
  await server.connect(transport);

  const shutdown = async (): Promise<void> => {
    await server.close();
    await browser.close();
  };
  process.once("SIGINT", () => {
    void shutdown().catch((error: unknown) => {
      console.error("Could not shut down the Squarespace MCP server cleanly.", error);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    void shutdown().catch((error: unknown) => {
      console.error("Could not shut down the Squarespace MCP server cleanly.", error);
      process.exitCode = 1;
    });
  });
}

main().catch((error: unknown) => {
  console.error("Could not start the Squarespace MCP server.", error);
  process.exitCode = 1;
});
