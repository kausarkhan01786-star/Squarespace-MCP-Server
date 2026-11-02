import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import { CMS_IDS } from "../capabilities/capability-types.js";
import { SettingsExecutionService } from "../execution/settings-execution-service.js";
import {
  outputSchema,
  readOnlyAnnotations,
  runTool as executeTool,
} from "./tool-helpers.js";

const inputSchema = z.object({
  cms_provider: z.enum(CMS_IDS),
}).strict();

export function registerSettingsExecutionTools(
  server: McpServer,
  execution: SettingsExecutionService,
  browserOperationLock: BrowserOperationLock,
): void {
  server.registerTool(
    "get_settings_execution_status",
    {
      description: "Report audited settings update capability and why approved execution is disabled. This tool is read-only.",
      inputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ cms_provider }) =>
      executeTool(
        "get_settings_execution_status",
        async () => execution.getSettingsExecutionStatus(cms_provider),
        browserOperationLock,
      ),
  );
}
