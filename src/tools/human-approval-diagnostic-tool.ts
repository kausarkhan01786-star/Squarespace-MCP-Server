import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logError } from "../utils/logger.js";

const diagnosticOutputSchema = z.object({
  status: z.enum(["responded", "unsupported", "failed"]),
  action: z.enum(["accept", "decline", "cancel"]).nullable(),
  decision: z.enum(["Accept", "Decline"]).nullable(),
  errorCode: z.enum(["ELICITATION_UNSUPPORTED", "ELICITATION_FAILED", "ELICITATION_TIMEOUT"]).nullable(),
});

export function registerHumanApprovalDiagnosticTool(server: McpServer): void {
  server.registerTool(
    "test_human_approval_prompt",
    {
      description: "Diagnostic only: asks the connected MCP host to display a harmless Accept/Decline prompt. It does not create an approval receipt or perform any website or CMS operation.",
      inputSchema: {},
      outputSchema: diagnosticOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      if (!server.server.getClientCapabilities()?.elicitation?.form) {
        return diagnosticResult("unsupported", null, null, "ELICITATION_UNSUPPORTED", true);
      }

      try {
        const response = await server.server.elicitInput({
          mode: "form",
          message: "This is a test approval prompt. No website or CMS will be changed.",
          requestedSchema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                title: "Test response",
                description: "Choose Accept or Decline. This is only a host integration test.",
                enum: ["Accept", "Decline"],
              },
            },
            required: ["decision"],
          },
        }, { timeout: 30_000 });

        const decision = response.action === "accept" &&
            response.content !== undefined &&
            "decision" in response.content &&
            (response.content.decision === "Accept" || response.content.decision === "Decline")
          ? response.content.decision
          : null;
        return diagnosticResult("responded", response.action, decision, null, false);
      } catch (error) {
        const errorCode = error instanceof McpError && error.code === ErrorCode.RequestTimeout
          ? "ELICITATION_TIMEOUT"
          : "ELICITATION_FAILED";
        logError("human_approval_diagnostic_failed", error, { errorCode });
        return diagnosticResult("failed", null, null, errorCode, true);
      }
    },
  );
}

function diagnosticResult(
  status: "responded" | "unsupported" | "failed",
  action: "accept" | "decline" | "cancel" | null,
  decision: "Accept" | "Decline" | null,
  errorCode: "ELICITATION_UNSUPPORTED" | "ELICITATION_FAILED" | "ELICITATION_TIMEOUT" | null,
  isError: boolean,
) {
  const result = { status, action, decision, errorCode };
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}
