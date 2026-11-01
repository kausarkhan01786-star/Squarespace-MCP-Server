import { z } from "zod";
import { SquarespaceBrowserError } from "../browser/browser-errors.js";

export const outputSchema = z.object({ result: z.unknown() });

export const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export async function runTool(
  toolName: string,
  action: () => Promise<unknown>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: { result: unknown };
  isError?: boolean;
}> {
  try {
    const result = await action();
    return {
      content: [{ type: "text", text: JSON.stringify({ result }) }],
      structuredContent: { result },
    };
  } catch (error) {
    const detail = error instanceof SquarespaceBrowserError
      ? { code: error.code, message: error.message }
      : {
          code: "UNEXPECTED_ERROR",
          message: "The operation failed unexpectedly. Check server diagnostics without exposing credentials.",
        };
    if (error instanceof SquarespaceBrowserError) {
      console.error(`[${toolName}] ${detail.code}: ${detail.message}`);
    } else {
      console.error(`[${toolName}] UNEXPECTED_ERROR`);
    }
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: detail }) }],
    };
  }
}
