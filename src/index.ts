import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SquarespaceBrowserService } from "./browser/squarespace-browser.service.js";
import { SquarespacePagesService } from "./browser/squarespace-pages.service.js";
import { registerPagesTools } from "./tools/pages-tools.js";

async function main(): Promise<void> {
  const browser = new SquarespaceBrowserService();
  const pages = new SquarespacePagesService(browser);
  const server = new McpServer({
    name: "squarespace-mcp-server",
    version: "0.1.0",
  });
  const transport = new StdioServerTransport();

  registerPagesTools(server, pages);
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
