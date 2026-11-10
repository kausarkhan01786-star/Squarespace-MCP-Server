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
      description: "Add a content section with a Text block to any page on the selected Squarespace website. Creates and verifies a backup snapshot first before saving changes.",
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
