import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import {
  analyzeRequirementsInputSchema,
  approveWorkflowTasksInputSchema,
  executeWorkflowInputSchema,
  planWebsiteWorkflowInputSchema,
  workflowIdInputSchema,
} from "../workflow/workflow-types.js";
import { WebsiteWorkflowService } from "../workflow/website-workflow.service.js";
import {
  outputSchema,
  readOnlyAnnotations,
  runTool,
} from "./tool-helpers.js";

export function registerWorkflowTools(
  server: McpServer,
  workflow: WebsiteWorkflowService,
  browserOperationLock: BrowserOperationLock,
): void {
  server.registerTool(
    "analyze_client_requirements",
    {
      description: "Validate and structure an AI-authored client brief and optional design analysis. This tool does not run an LLM or analyze uploaded images.",
      inputSchema: analyzeRequirementsInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runTool("analyze_client_requirements", async () =>
        workflow.analyzeRequirements(input)),
  );

  server.registerTool(
    "plan_website_workflow",
    {
      description: "Verify the selected CMS website and plan ordered actions against declared adapter capabilities. Unsupported tasks are clearly marked; planning makes no website changes.",
      inputSchema: planWebsiteWorkflowInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runTool(
        "plan_website_workflow",
        () => workflow.planWorkflow(input),
        browserOperationLock,
      ),
  );

  server.registerTool(
    "approve_workflow_tasks",
    {
      description: "Explicitly authorize selected high-impact tasks in an immutable workflow plan. Requires confirmed=true and the exact plan fingerprint.",
      inputSchema: approveWorkflowTasksInputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool("approve_workflow_tasks", async () =>
        workflow.approveTasks(input)),
  );

  server.registerTool(
    "execute_website_workflow",
    {
      description: "Execute available approved workflow tasks serially within the requested deadline and browser-action budget. Mutations require task-specific approval, are never automatically replayed after interruption, and are never published automatically.",
      inputSchema: executeWorkflowInputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool("execute_website_workflow", () =>
        workflow.executeWorkflow(input)),
  );

  server.registerTool(
    "cancel_website_workflow",
    {
      description: "Request cooperative cancellation at the next safe workflow checkpoint. An in-progress mutation is not automatically replayed and may require website-state inspection.",
      inputSchema: workflowIdInputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workflow_id }) =>
      runTool("cancel_website_workflow", async () =>
        workflow.cancelWorkflow(workflow_id)),
  );

  server.registerTool(
    "get_workflow_status",
    {
      description: "Read a workflow plan and execution status retained in the current MCP process.",
      inputSchema: workflowIdInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workflow_id }) =>
      runTool("get_workflow_status", async () =>
        workflow.getWorkflowStatus(workflow_id)),
  );

  server.registerTool(
    "get_workflow_qa_report",
    {
      description: "Report only QA checks supported by evidence returned from completed workflow tools. Visual comparison is marked unverified unless separately measured.",
      inputSchema: workflowIdInputSchema,
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workflow_id }) =>
      runTool("get_workflow_qa_report", async () =>
        workflow.getQaReport(workflow_id)),
  );

  server.registerTool(
    "list_workflow_adapters",
    {
      description: "List configured CMS workflow adapters and their explicit supported/unsupported capabilities.",
      inputSchema: {},
      outputSchema,
      annotations: readOnlyAnnotations,
    },
    async () =>
      runTool("list_workflow_adapters", async () =>
        workflow.getAvailableAdapters()),
  );
}
