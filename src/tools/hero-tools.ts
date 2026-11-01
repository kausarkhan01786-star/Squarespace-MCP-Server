import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  heroPlanningInputSchema,
  planSquarespaceHero,
} from "../workflow/squarespace-hero-builder.js";
import { outputSchema, readOnlyAnnotations, runTool } from "./tool-helpers.js";

export function registerHeroTools(server: McpServer): void {
  server.registerTool(
    "plan_squarespace_hero",
    {
      description: "Validate a structured Squarespace Hero specification and return a staged, evidence-aware plan. Planning only: it does not inspect or control any browser, alter website content, save, or publish. Unverified editor operations remain unsupported.",
      inputSchema: heroPlanningInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runTool("plan_squarespace_hero", async () => planSquarespaceHero(input)),
  );
}
