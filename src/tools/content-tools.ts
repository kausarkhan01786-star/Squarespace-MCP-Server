import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import {
  addTextSectionInputSchema,
  SquarespaceContentService,
} from "../browser/squarespace-content.service.js";
import { outputSchema, runTool } from "./tool-helpers.js";

export function registerContentTools(
  server: McpServer,
  content: SquarespaceContentService,
  browserOperationLock: BrowserOperationLock,
): void {
  server.registerTool(
    "add_text_section",
    {
      description: "Request explicit interactive human approval, then add a pure-white Home section with one pure-black Text block on the confirmed Kausar Mia website. Creates and verifies a fresh local JSON/screenshot backup first. The legacy confirm_potentially_live_save field is not authorization. Save behavior is not verified as draft-only; approval may affect the live site. Never clicks Publish.",
      inputSchema: addTextSectionInputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authorization = await content.requestTextSectionApproval(input);
      try {
        return await runTool(
          "add_text_section",
          () => content.addTextSection(input, undefined, authorization),
          browserOperationLock,
        );
      } finally {
        content.revokeTextSectionApproval(authorization);
      }
    },
  );
}
