import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  heroPlanningInputSchema,
  planSquarespaceHero,
} from "../workflow/squarespace-hero-builder.js";
import {
  createSquarespaceHeroOperatorPlan,
  squarespaceHeroOperatorPlanInputSchema,
} from "../workflow/squarespace-operator-engine.js";
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
  server.registerTool(
    "plan_squarespace_hero_operator",
    {
      description: "Create a deterministic, section-ID-bound native Text/Button/Image block plan with an action budget below 40. Planning only; it does not control a browser or save/publish website changes.",
      inputSchema: squarespaceHeroOperatorPlanInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runTool("plan_squarespace_hero_operator", async () =>
        createSquarespaceHeroOperatorPlan(input)),
  );
}
