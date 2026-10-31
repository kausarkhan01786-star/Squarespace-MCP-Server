import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PageBackupService } from "./backups/page-backup.service.js";
import { SquarespaceBrowserService } from "./browser/squarespace-browser.service.js";
import { SquarespaceDesignService } from "./browser/squarespace-design.service.js";
import { SquarespaceNavigationSeoSettingsService } from "./browser/squarespace-navigation-seo-settings.service.js";
import { SquarespacePagesService } from "./browser/squarespace-pages.service.js";
import { registerDesignTools } from "./tools/design-tools.js";
import { registerNavigationSeoSettingsTools } from "./tools/navigation-seo-settings-tools.js";
import { registerPagesTools } from "./tools/pages-tools.js";

async function main(): Promise<void> {
  const browser = new SquarespaceBrowserService();
  const pages = new SquarespacePagesService(browser);
  const design = new SquarespaceDesignService(browser, pages);
  const navigationSeoSettings =
    new SquarespaceNavigationSeoSettingsService(browser, pages);
  const backups = new PageBackupService(pages, browser);
  const server = new McpServer({
    name: "squarespace-mcp-server",
    version: "0.1.0",
  });
  const transport = new StdioServerTransport();

  registerPagesTools(server, pages, backups);
  registerDesignTools(server, design);
  registerNavigationSeoSettingsTools(server, navigationSeoSettings);
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
