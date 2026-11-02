import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerHumanApprovalDiagnosticTool } from "./tools/human-approval-diagnostic-tool.js";
import { logError } from "./utils/logger.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "human-approval-diagnostic",
    version: "0.1.0",
  });
  registerHumanApprovalDiagnosticTool(server);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  logError("approval_diagnostic_server_start_failed", error);
  process.exitCode = 1;
});
