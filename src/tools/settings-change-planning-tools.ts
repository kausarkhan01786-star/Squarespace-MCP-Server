import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import {
  CMS_IDS,
} from "../capabilities/capability-types.js";
import type { PlannedValue } from "../planning/settings-change-types.js";
import { SettingsChangePlanner } from "../planning/settings-change-planner.js";
import {
  outputSchema,
  readOnlyAnnotations,
  runTool as executeTool,
} from "./tool-helpers.js";

const plannedValueSchema: z.ZodType<PlannedValue> = z.lazy(() =>
  z.union([
    z.string().max(10_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(plannedValueSchema).max(100),
    z.record(z.string(), plannedValueSchema),
  ]));

const analyzeInput = z.object({
  instruction: z.string().trim().min(1).max(2_000),
  cms_provider: z.enum(CMS_IDS).optional(),
  site_id: z.string().trim().min(1).max(200).optional(),
}).strict();

const previewInput = z.object({
  original_instruction: z.string().trim().min(1).max(2_000),
  cms_provider: z.enum(CMS_IDS),
  site_id: z.string().trim().min(1).max(200),
  changes: z.array(z.object({
    category_id: z.string().trim().min(1).max(100),
    field_id: z.string().trim().min(1).max(200).optional(),
    field_label: z.string().trim().min(1).max(200),
    proposed_value: plannedValueSchema,
    value_type: z.enum([
      "string",
      "number",
      "boolean",
      "enum",
      "url",
      "string_list",
      "object",
      "unknown",
    ]),
  }).strict()).min(1).max(20),
}).strict();

const getPlanInput = z.object({
  plan_id: z.string().uuid(),
}).strict();

export function registerSettingsChangePlanningTools(
  server: McpServer,
  planner: SettingsChangePlanner,
  browserOperationLock: BrowserOperationLock,
): void {
  const runTool = (toolName: string, action: () => Promise<unknown>) =>
    executeTool(toolName, action, browserOperationLock);

  server.registerTool(
    "analyze_settings_change_request",
    {
      description: "Analyze a natural-language settings request and return a read-only, dry-run plan. This tool cannot apply changes.",
      inputSchema: analyzeInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runTool("analyze_settings_change_request", () =>
        planner.analyzeSettingsChangeRequest({
          instruction: input.instruction,
          ...(input.cms_provider ? { cmsProvider: input.cms_provider } : {}),
          ...(input.site_id ? { siteId: input.site_id } : {}),
        }),
      ),
  );

  server.registerTool(
    "preview_settings_changes",
    {
      description: "Preview explicitly structured settings changes against current read-only inspection evidence. This tool cannot apply changes.",
      inputSchema: previewInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runTool("preview_settings_changes", () =>
        planner.previewSettingsChanges({
          originalInstruction: input.original_instruction,
          cmsProvider: input.cms_provider,
          siteId: input.site_id,
          changes: input.changes.map((change) => ({
            categoryId: change.category_id,
            ...(change.field_id ? { fieldId: change.field_id } : {}),
            fieldLabel: change.field_label,
            proposedValue: change.proposed_value,
            valueType: change.value_type,
          })),
        }),
      ),
  );

  server.registerTool(
    "get_settings_change_plan",
    {
      description: "Retrieve a previously generated dry-run settings change plan from this process.",
      inputSchema: getPlanInput,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ plan_id }) =>
      runTool("get_settings_change_plan", async () => {
        const plan = planner.getSettingsChangePlan(plan_id);
        if (!plan) throw new Error("Settings change plan was not found.");
        return plan;
      }),
  );
}
