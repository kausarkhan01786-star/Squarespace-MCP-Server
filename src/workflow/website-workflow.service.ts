import { createHash, randomUUID } from "node:crypto";
import { SquarespaceBrowserError } from "../browser/browser-errors.js";
import {
  analyzeRequirementsInputSchema,
  approveWorkflowTasksInputSchema,
  executeWorkflowInputSchema,
  planWebsiteWorkflowInputSchema,
  type ClientBrief,
  type DesignSpecification,
  type WorkflowAction,
  type WorkflowAdapter,
  type WorkflowCapability,
  type WorkflowStage,
  type WorkflowTask,
  type WorkflowTaskStatus,
  type WebsiteWorkflow,
  type WorkflowQaReport,
} from "./workflow-types.js";

type WorkflowAdapterRegistry = ReadonlyMap<string, WorkflowAdapter>;

export class WebsiteWorkflowService {
  private readonly workflows = new Map<string, WebsiteWorkflow>();
  private readonly runningWorkflows = new Set<string>();

  constructor(
    private readonly adapters: WorkflowAdapterRegistry,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  analyzeRequirements(rawInput: unknown): {
    brief: ClientBrief;
    designSpecification: DesignSpecification | null;
    summary: {
      businessType: string;
      goals: string[];
      audience: string[];
      requestedPageCount: number;
      requestedSectionCount: number;
      featureCount: number;
    };
    unresolvedQuestions: string[];
    limitations: string[];
  } {
    const input = analyzeRequirementsInputSchema.parse(rawInput);
    const unresolvedQuestions = [...input.brief.openQuestions];
    if (!input.design_specification) {
      unresolvedQuestions.push("No structured design specification was supplied.");
    }
    return {
      brief: input.brief,
      designSpecification: input.design_specification ?? null,
      summary: {
        businessType: input.brief.businessType,
        goals: input.brief.websiteGoals,
        audience: input.brief.targetAudience,
        requestedPageCount: input.brief.requiredPages.length,
        requestedSectionCount: input.brief.requiredPages.reduce(
          (sum, page) => sum + page.sections.length,
          0,
        ),
        featureCount: input.brief.requiredFeatures.length,
      },
      unresolvedQuestions,
      limitations: [
        "This service validates and organizes the AI agent's structured interpretation; it does not run an LLM or infer requirements from free-form text.",
        ...(input.design_specification
          ? ["The caller supplied the design analysis; this server does not inspect uploaded mockup images."]
          : []),
        "Visual similarity and pixel-level fidelity require screenshot capture and human or vision-model comparison.",
      ],
    };
  }

  async planWorkflow(rawInput: unknown): Promise<{
    workflowId: string;
    fingerprint: string;
    cms: string;
    website: { id: string; name: string; url: string };
    status: WebsiteWorkflow["status"];
    tasks: Array<{
      id: string;
      action: WorkflowAction;
      toolName: string | null;
      stage: WorkflowStage;
      status: WorkflowTaskStatus;
      approvalRequired: boolean;
      limitation: string | null;
    }>;
    analysis: ReturnType<WebsiteWorkflowService["analyzeRequirements"]>;
    stateRetention: "process_memory";
  }> {
    const input = planWebsiteWorkflowInputSchema.parse(rawInput);
    const adapter = this.adapters.get(input.cms);
    if (!adapter) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_CMS_UNAVAILABLE",
        `No configured CMS adapter is available for "${input.cms}". The workflow will not switch platforms.`,
      );
    }
    const website = await adapter.verifyWebsite(input.website_id);
    if (website.id !== input.website_id || !website.url) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_CMS_UNAVAILABLE",
        "The CMS adapter did not verify the exact requested website identity.",
      );
    }
    const capabilities = new Map(
      adapter.getCapabilities().map((capability) => [capability.action, capability]),
    );
    const tasks: WorkflowTask[] = [];
    for (const task of input.tasks) {
      const capability = capabilities.get(task.action);
      const validationLimitation = capability?.supported && adapter.validateTask
        ? await adapter.validateTask(task.action, input.website_id, task)
        : null;
      if (!capability?.supported || validationLimitation) {
        tasks.push({
          id: this.createId(),
          action: task.action,
          toolName: capability?.toolName ?? null,
          stage: stageForAction(task.action),
          pageId: task.page_id ?? null,
          status: "unsupported",
          readOnly: capability?.readOnly ?? false,
          approvalRequired: false,
          approved: false,
          retrySafe: false,
          attempts: 0,
          args: task,
          error: validationLimitation ??
            capability?.limitation ??
            "No verified CMS capability or executable MCP tool is registered for this operation.",
        });
        continue;
      }
      tasks.push({
        id: this.createId(),
        action: task.action,
        toolName: capability.toolName,
        stage: stageForAction(task.action),
        pageId: task.page_id ?? null,
        status: "pending",
        readOnly: capability.readOnly,
        approvalRequired: capability.approvalRequired,
        approved: false,
        retrySafe: capability.retrySafe,
        attempts: 0,
        args: task,
        ...(capability.limitation ? { error: capability.limitation } : {}),
      });
    }
    const workflowId = this.createId();
    const createdAt = this.now().toISOString();
    const fingerprint = hashPlan({
      workflowId,
      cms: input.cms,
      website,
      brief: input.brief,
      designSpecification: input.design_specification ?? null,
      tasks,
    });
    const workflow: WebsiteWorkflow = {
      id: workflowId,
      cms: input.cms,
      website,
      brief: input.brief,
      designSpecification: input.design_specification ?? null,
      tasks,
      fingerprint,
      status: "planned",
      createdAt,
      updatedAt: createdAt,
    };
    this.workflows.set(workflowId, workflow);

    return {
      workflowId,
      fingerprint,
      cms: workflow.cms,
      website: workflow.website,
      status: workflow.status,
      tasks: workflow.tasks.map(toTaskSummary),
      analysis: this.analyzeRequirements({
        brief: input.brief,
        ...(input.design_specification
          ? { design_specification: input.design_specification }
          : {}),
      }),
      stateRetention: "process_memory",
    };
  }

  approveTasks(rawInput: unknown): {
    workflowId: string;
    fingerprint: string;
    approvedTaskIds: string[];
    remainingApprovals: string[];
  } {
    const input = approveWorkflowTasksInputSchema.parse(rawInput);
    const workflow = this.requireWorkflow(input.workflow_id);
    if (this.runningWorkflows.has(workflow.id)) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_ALREADY_RUNNING",
        "Workflow approvals cannot change while tasks are executing.",
      );
    }
    if (workflow.fingerprint !== input.plan_fingerprint) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_PLAN_MISMATCH",
        "The approval fingerprint does not match the stored immutable workflow plan.",
      );
    }
    const selected = new Set(input.task_ids);
    if (selected.size !== input.task_ids.length) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_TASK_NOT_FOUND",
        "Task IDs must be unique within an approval request.",
      );
    }
    const selectedTasks = workflow.tasks.filter((task) => selected.has(task.id));
    if (
      selectedTasks.length !== selected.size ||
      selectedTasks.some((task) =>
        !task.approvalRequired ||
        task.status === "unsupported" ||
        task.status === "succeeded" ||
        task.status === "failed")
    ) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_TASK_NOT_FOUND",
        "One or more selected task IDs are not approvable high-impact operations.",
      );
    }
    const approved: string[] = [];
    for (const task of selectedTasks) {
      task.approved = true;
      if (task.status === "blocked") task.status = "pending";
      approved.push(task.id);
    }
    workflow.updatedAt = this.now().toISOString();
    workflow.status = deriveStatus(workflow.tasks, false);
    return {
      workflowId: workflow.id,
      fingerprint: workflow.fingerprint,
      approvedTaskIds: approved,
      remainingApprovals: workflow.tasks
        .filter((task) => task.approvalRequired && !task.approved && task.status !== "unsupported")
        .map((task) => task.id),
    };
  }

  async executeWorkflow(rawInput: unknown): Promise<{
    workflowId: string;
    status: WebsiteWorkflow["status"];
    executedTaskIds: string[];
    executedTasks: Array<{
      taskId: string;
      action: WorkflowAction;
      toolName: string | null;
      result: unknown;
    }>;
    tasks: ReturnType<WebsiteWorkflowService["getWorkflowStatus"]>["tasks"];
  }> {
    const input = executeWorkflowInputSchema.parse(rawInput);
    const workflow = this.requireWorkflow(input.workflow_id);
    if (this.runningWorkflows.has(workflow.id)) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_ALREADY_RUNNING",
        "This workflow is already executing; do not start a parallel run.",
      );
    }
    const adapter = this.adapters.get(workflow.cms);
    if (!adapter) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_CMS_UNAVAILABLE",
        "The CMS adapter used to create this workflow is no longer registered.",
      );
    }
    this.runningWorkflows.add(workflow.id);
    const executedTaskIds: string[] = [];
    const executedTasks: Array<{
      taskId: string;
      action: WorkflowAction;
      toolName: string | null;
      result: unknown;
    }> = [];
    try {
      const verifiedWebsite = await adapter.verifyWebsite(workflow.website.id);
      if (
        verifiedWebsite.id !== workflow.website.id ||
        verifiedWebsite.url !== workflow.website.url
      ) {
        throw new SquarespaceBrowserError(
          "WORKFLOW_CMS_UNAVAILABLE",
          "The verified website identity changed after planning. No workflow tasks were executed.",
        );
      }

      if (input.retry_failed_read_only) {
        for (const task of workflow.tasks) {
          if (task.status === "failed" && task.readOnly && task.retrySafe) {
            task.status = "pending";
            delete task.error;
          }
        }
      }
      workflow.status = "running";
      workflow.updatedAt = this.now().toISOString();
      for (const task of workflow.tasks) {
        if (executedTaskIds.length >= input.max_tasks) break;
        if (task.status === "unsupported" || task.status === "succeeded") continue;
        if (task.status === "failed" || task.status === "running") break;
        if (task.approvalRequired && !task.approved) {
          task.status = "blocked";
          task.error = "Explicit approval for this exact task is required before execution.";
          break;
        }
        task.status = "running";
        task.attempts += 1;
        workflow.updatedAt = this.now().toISOString();
        console.info("[workflow task started]", {
          workflowId: workflow.id,
          taskId: task.id,
          action: task.action,
        });
        try {
          task.result = await adapter.execute(task.action, workflow.website.id, task.args);
          task.status = "succeeded";
          delete task.error;
          executedTaskIds.push(task.id);
          executedTasks.push({
            taskId: task.id,
            action: task.action,
            toolName: task.toolName,
            result: task.result,
          });
          console.info("[workflow task completed]", {
            workflowId: workflow.id,
            taskId: task.id,
            action: task.action,
          });
        } catch (error) {
          task.status = "failed";
          task.error = safeErrorMessage(error);
          workflow.status = "failed";
          console.error("[workflow task failed]", {
            workflowId: workflow.id,
            taskId: task.id,
            action: task.action,
            code: error instanceof SquarespaceBrowserError ? error.code : "UNEXPECTED_ERROR",
          });
          break;
        }
      }
    } finally {
      this.runningWorkflows.delete(workflow.id);
      workflow.updatedAt = this.now().toISOString();
      workflow.status = deriveStatus(workflow.tasks, workflow.status === "failed");
    }

    return {
      workflowId: workflow.id,
      status: workflow.status,
      executedTaskIds,
      executedTasks,
      tasks: this.getWorkflowStatus(workflow.id).tasks,
    };
  }

  getWorkflowStatus(workflowId: string): {
    workflowId: string;
    cms: string;
    website: WebsiteWorkflow["website"];
    status: WebsiteWorkflow["status"];
    fingerprint: string;
    createdAt: string;
    updatedAt: string;
    tasks: Array<{
      id: string;
      action: WorkflowAction;
      toolName: string | null;
      stage: WorkflowStage;
      pageId: string | null;
      status: WorkflowTaskStatus;
      approvalRequired: boolean;
      approved: boolean;
      attempts: number;
      error: string | null;
    }>;
  } {
    const workflow = this.requireWorkflow(workflowId);
    return {
      workflowId: workflow.id,
      cms: workflow.cms,
      website: workflow.website,
      status: workflow.status,
      fingerprint: workflow.fingerprint,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      tasks: workflow.tasks.map((task) => ({
        id: task.id,
        action: task.action,
        toolName: task.toolName,
        stage: task.stage,
        pageId: task.pageId,
        status: task.status,
        approvalRequired: task.approvalRequired,
        approved: task.approved,
        attempts: task.attempts,
        error: task.error ?? null,
      })),
    };
  }

  getQaReport(workflowId: string): WorkflowQaReport {
    const workflow = this.requireWorkflow(workflowId);
    if (!workflow.tasks.some((task) => task.attempts > 0)) {
      return {
        workflowId,
        status: "not_run",
        checks: [{
          check: "workflow_execution",
          status: "not_verified",
          evidence: "No workflow tasks have been executed.",
        }],
        limitations: ["A plan is not evidence that a website change or QA check was executed."],
      };
    }

    const checks: WorkflowQaReport["checks"] = [];
    let hasOutcomeEvidence = false;
    for (const task of workflow.tasks) {
      if (task.status === "unsupported") {
        checks.push({
          check: task.action,
          status: "blocked",
          evidence: task.error ?? "No supported adapter operation is available.",
        });
      } else if (task.status === "failed") {
        checks.push({
          check: task.action,
          status: "failed",
          evidence: task.error ?? "The operation failed.",
        });
      } else if (task.status === "succeeded") {
        checks.push({
          check: task.action,
          status: "passed",
          evidence: `Verified tool ${task.toolName} returned successfully for this workflow task.`,
        });
        if (task.action === "inspect_responsive") {
          const responsive = responsiveCheck(task.result);
          checks.push(responsive);
          hasOutcomeEvidence ||= responsive.status === "passed" || responsive.status === "failed";
        } else if (task.action === "add_text_section") {
          const mutation = textSectionCheck(task.result, task.args.text);
          checks.push(mutation);
          hasOutcomeEvidence ||= mutation.status === "passed" || mutation.status === "failed";
        }
      } else {
        checks.push({
          check: task.action,
          status: task.status === "blocked" ? "blocked" : "not_verified",
          evidence: task.error ?? "This planned task has not completed.",
        });
      }
    }
    if (workflow.designSpecification) {
      checks.push({
        check: "visual_reference_comparison",
        status: "not_verified",
        evidence: "No screenshot comparison was run by this server.",
      });
    }
    const hasFailure = checks.some((check) => check.status === "failed");
    const hasIncomplete = checks.some((check) =>
      check.status === "blocked" || check.status === "not_verified");
    const status = hasFailure
      ? "failed"
      : hasIncomplete || !hasOutcomeEvidence
        ? "partial"
        : "passed";
    return {
      workflowId,
      status,
      checks,
      limitations: [
        "QA evidence is limited to the exact registered tools that completed; it is not a general browser vision or link crawler.",
        ...(!hasOutcomeEvidence
          ? ["No completed task returned a measurable website quality outcome; tool execution alone is not a QA pass."]
          : []),
        ...(workflow.designSpecification
          ? ["A structured design specification does not prove visual similarity; screenshot comparison remains unverified."]
          : []),
      ],
    };
  }

  getAvailableAdapters(): Array<{
    cms: string;
    capabilities: WorkflowCapability[];
  }> {
    return [...this.adapters.values()].map((adapter) => ({
      cms: adapter.cms,
      capabilities: adapter.getCapabilities(),
    }));
  }

  private requireWorkflow(workflowId: string): WebsiteWorkflow {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_NOT_FOUND",
        "The workflow ID does not exist in this MCP server process. Workflow state is not persisted across restarts.",
      );
    }
    return workflow;
  }
}

function stageForAction(action: WorkflowAction): WorkflowStage {
  switch (action) {
    case "inspect_pages":
    case "inspect_page":
    case "inspect_page_sections":
      return "cms_inspection";
    case "inspect_responsive":
      return "responsive_qa";
    case "inspect_page_seo":
      return "seo_qa";
    case "inspect_design":
      return "design_analysis";
    case "backup_page":
      return "planning";
    case "inspect_products":
    case "inspect_product":
    case "inspect_inventory":
    case "inspect_orders":
    case "inspect_discounts":
    case "manage_orders":
    case "manage_products":
    case "manage_inventory":
    case "manage_discounts":
      return "commerce";
    case "add_text_section":
    case "create_page":
    case "edit_content_block":
    case "manage_navigation":
    case "set_site_design":
    case "configure_custom_code":
      return "construction";
    case "publish_site":
      return "publishing";
  }
}

function toTaskSummary(task: WorkflowTask): {
  id: string;
  action: WorkflowAction;
  toolName: string | null;
  stage: WorkflowStage;
  status: WorkflowTaskStatus;
  approvalRequired: boolean;
  limitation: string | null;
} {
  return {
    id: task.id,
    action: task.action,
    toolName: task.toolName,
    stage: task.stage,
    status: task.status,
    approvalRequired: task.approvalRequired,
    limitation: task.status === "unsupported" ? task.error ?? null : null,
  };
}

function deriveStatus(tasks: WorkflowTask[], failed: boolean): WebsiteWorkflow["status"] {
  if (failed || tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "blocked")) return "awaiting_approval";
  if (tasks.some((task) => task.status === "pending")) {
    return tasks.some((task) => task.status === "succeeded") ? "running" : "planned";
  }
  if (tasks.some((task) => task.status === "unsupported")) return "partial";
  return "completed";
}

function responsiveCheck(result: unknown): WorkflowQaReport["checks"][number] {
  if (
    result === null ||
    typeof result !== "object" ||
    !("mobile" in result) ||
    result.mobile === null ||
    typeof result.mobile !== "object" ||
    !("horizontalOverflow" in result.mobile) ||
    typeof result.mobile.horizontalOverflow !== "boolean"
  ) {
    return {
      check: "mobile_horizontal_overflow",
      status: "not_verified",
      evidence: "The responsive tool result did not contain a verified mobile overflow value.",
    };
  }
  return result.mobile.horizontalOverflow
    ? {
        check: "mobile_horizontal_overflow",
        status: "failed",
        evidence: "The responsive inspection reported horizontal overflow at its mobile viewport.",
      }
    : {
        check: "mobile_horizontal_overflow",
        status: "passed",
        evidence: "The responsive inspection reported no horizontal overflow at its mobile viewport.",
      };
}

function textSectionCheck(
  result: unknown,
  expectedText: string | undefined,
): WorkflowQaReport["checks"][number] {
  if (
    result === null ||
    typeof result !== "object" ||
    !("verified" in result) ||
    result.verified !== true ||
    !("text" in result) ||
    result.text !== expectedText ||
    !("backgroundColor" in result) ||
    result.backgroundColor !== "#FFFFFF" ||
    !("textColor" in result) ||
    result.textColor !== "#000000" ||
    !("saved" in result) ||
    result.saved !== true ||
    !("explicitPublishClicked" in result) ||
    result.explicitPublishClicked !== false
  ) {
    return {
      check: "add_text_section_result_verification",
      status: "not_verified",
      evidence: "The content tool did not return the expected verified text, colors, saved state, and no-publish result.",
    };
  }
  return {
    check: "add_text_section_result_verification",
    status: "passed",
    evidence: "The content tool verified the requested text, pure-white background, pure-black text, saved result, and that Publish was not clicked.",
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof SquarespaceBrowserError) return error.message;
  return "Unexpected task failure. Inspect server diagnostics without exposing credentials.";
}

function hashPlan(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
