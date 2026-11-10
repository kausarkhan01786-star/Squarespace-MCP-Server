import { createHash, randomUUID } from "node:crypto";
import { SquarespaceBrowserError } from "../browser/browser-errors.js";
import {
  ExecutionController,
  ExecutionStoppedError,
  awaitExecutionOperation,
} from "../execution/execution-controller.js";
import type { ExecutionMetrics } from "../execution/execution-telemetry.js";
import { logError, logInfo } from "../utils/logger.js";
import {
  MutationApprovalError,
  MutationApprovalGuard,
  type MutationAuthorization,
  type MutationProposalInput,
} from "../approval/mutation-approval.js";
import { textSectionMutationProposal } from "../approval/squarespace-mutation-proposals.js";
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
  private readonly approvingWorkflows = new Set<string>();
  private readonly cancellationControllers = new Map<string, AbortController>();

  constructor(
    private readonly adapters: WorkflowAdapterRegistry,
    private readonly mutationApproval: MutationApprovalGuard,
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

  async approveTasks(rawInput: unknown): Promise<{
    workflowId: string;
    fingerprint: string;
    approvedTaskIds: string[];
    remainingApprovals: string[];
  }> {
    const input = approveWorkflowTasksInputSchema.parse(rawInput);
    const workflow = this.requireWorkflow(input.workflow_id);
    if (
      this.runningWorkflows.has(workflow.id) ||
      this.approvingWorkflows.has(workflow.id)
    ) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_ALREADY_RUNNING",
        "Workflow approval requests cannot overlap each other or workflow execution.",
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
    this.approvingWorkflows.add(workflow.id);
    const authorizations: Array<{
      task: WorkflowTask;
      authorization: MutationAuthorization;
    }> = [];
    try {
      for (const task of selectedTasks) {
        authorizations.push({
          task,
          authorization: await this.mutationApproval.requestApproval(
            this.proposalForTask(workflow, task),
          ),
        });
      }
    } catch (error) {
      for (const { authorization } of authorizations) {
        this.mutationApproval.revoke(authorization.receipt);
      }
      throw error;
    } finally {
      this.approvingWorkflows.delete(workflow.id);
    }

    const approved: string[] = [];
    for (const { task, authorization } of authorizations) {
      if (task.mutationAuthorization) {
        this.mutationApproval.revoke(task.mutationAuthorization.receipt);
      }
      task.mutationAuthorization = authorization;
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

  private proposalForTask(
    workflow: WebsiteWorkflow,
    task: WorkflowTask,
  ): MutationProposalInput {
    if (task.action === "add_text_section") {
      const pageId = task.args.page_id;
      const text = task.args.text;
      if (!pageId || !text?.trim()) {
        throw new MutationApprovalError(
          "invalid",
          "The workflow task is missing the exact page or text required for approval.",
        );
      }
      return textSectionMutationProposal({
        websiteId: workflow.website.id,
        pageId,
        text,
        backgroundColor: task.args.background_color,
        textColor: task.args.text_color,
      });
    }
    if (task.action === "create_page") {
      const title = (task.args.text ?? task.args.page_id ?? "New Page").trim();
      return {
        provider: "squarespace",
        websiteId: workflow.website.id,
        action: "page.create",
        targetResource: `website:${workflow.website.id}:page-list:main_navigation`,
        payload: { title, pageType: "page", group: "main_navigation" },
        permissionScopes: ["page.create"],
      };
    }
    throw new MutationApprovalError(
      "unavailable",
      `No exact approval proposal is implemented for workflow action "${task.action}".`,
    );
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
    executionMetrics: ExecutionMetrics;
    tasks: ReturnType<WebsiteWorkflowService["getWorkflowStatus"]>["tasks"];
  }> {
    const input = executeWorkflowInputSchema.parse(rawInput);
    const workflow = this.requireWorkflow(input.workflow_id);
    if (this.approvingWorkflows.has(workflow.id)) {
      throw new SquarespaceBrowserError(
        "WORKFLOW_ALREADY_RUNNING",
        "Wait for the pending human approval request to finish before executing this workflow.",
      );
    }
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
    const cancellation = new AbortController();
    this.cancellationControllers.set(workflow.id, cancellation);
    const controller = new ExecutionController({
      timeoutMs: input.timeout_ms,
      maxBrowserActions: input.max_browser_actions,
      signal: cancellation.signal,
      workflowId: workflow.id,
      now: () => this.now().getTime(),
    });
    const executedTaskIds: string[] = [];
    const executedTasks: Array<{
      taskId: string;
      action: WorkflowAction;
      toolName: string | null;
      result: unknown;
    }> = [];
    const retryTaskIds = new Set<string>();
    let executionStatus: ExecutionMetrics["status"] = "succeeded";
    try {
      controller.startStage("website_verification");
      controller.checkpoint();
      const verifiedWebsite = await awaitExecutionOperation(
        adapter.verifyWebsite(workflow.website.id, {
          browser: controller,
          signal: controller.signal,
          deadlineAt: controller.deadlineAt,
          workflowId: workflow.id,
          taskId: undefined,
        }),
        controller,
      );
      controller.endStage("website_verification");
      controller.checkpoint();
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
            retryTaskIds.add(task.id);
          }
        }
      }
      workflow.status = "running";
      workflow.updatedAt = this.now().toISOString();
      for (const task of workflow.tasks) {
        controller.checkpoint();
        if (executedTaskIds.length >= input.max_tasks) break;
        if (task.status === "unsupported" || task.status === "succeeded") continue;
        if (task.status === "interrupted") {
          executionStatus = "interrupted";
          workflow.status = "interrupted";
          break;
        }
        if (
          task.status === "failed" ||
          task.status === "running"
        ) break;
        if (
          task.approvalRequired &&
          (!task.approved || !task.mutationAuthorization)
        ) {
          task.status = "blocked";
          task.error = "Trusted human approval for this exact task is required before execution.";
          break;
        }
        if (retryTaskIds.delete(task.id)) controller.recordRetry();
        task.status = "running";
        task.attempts += 1;
        controller.setTaskId(task.id);
        workflow.updatedAt = this.now().toISOString();
        logInfo("workflow_task_started", {
          action: task.action,
        });
        controller.startStage("workflow_task");
        try {
          task.result = await awaitExecutionOperation(
            adapter.execute(
              task.action,
              workflow.website.id,
              task.args,
              {
                browser: controller,
                signal: controller.signal,
                deadlineAt: controller.deadlineAt,
                workflowId: workflow.id,
                taskId: task.id,
                ...(task.mutationAuthorization
                  ? { mutationAuthorization: task.mutationAuthorization }
                  : {}),
              },
            ),
            controller,
          );
          controller.checkpoint();
          task.status = "succeeded";
          delete task.error;
          executedTaskIds.push(task.id);
          executedTasks.push({
            taskId: task.id,
            action: task.action,
            toolName: task.toolName,
            result: task.result,
          });
          logInfo("workflow_task_completed", {
            action: task.action,
          });
        } catch (error) {
          controller.endStage("workflow_task");
          if (error instanceof ExecutionStoppedError) {
            const stopped = controller.mutationOutcomeUncertain && !error.mutationOutcomeUncertain
              ? new ExecutionStoppedError(error.reason, true)
              : error;
            executionStatus = executionStatusForStop(stopped);
            task.status = "interrupted";
            task.error = stopped.message;
            workflow.status = workflowStatusForExecution(executionStatus);
            break;
          }
          executionStatus = "failed";
          task.status = "failed";
          task.error = safeErrorMessage(error);
          workflow.status = "failed";
          logError("workflow_task_failed", error, {
            action: task.action,
            code: error instanceof SquarespaceBrowserError ? error.code : "UNEXPECTED_ERROR",
          });
          break;
        } finally {
          controller.endStage("workflow_task");
          this.releaseTaskAuthorization(task);
        }
      }
    } catch (error) {
      if (error instanceof ExecutionStoppedError) {
        executionStatus = executionStatusForStop(error);
        workflow.status = workflowStatusForExecution(executionStatus);
      } else {
        executionStatus = "failed";
        workflow.status = "failed";
        throw error;
      }
    } finally {
      controller.endStage("website_verification");
      for (const task of workflow.tasks) this.releaseTaskAuthorization(task);
      this.runningWorkflows.delete(workflow.id);
      this.cancellationControllers.delete(workflow.id);
      workflow.updatedAt = this.now().toISOString();
      if (
        executionStatus === "succeeded" ||
        executionStatus === "failed"
      ) {
        workflow.status = deriveStatus(workflow.tasks, executionStatus === "failed");
      }

      workflow.executionMetrics = controller.finish(executionStatus);
      logInfo("workflow_execution_metrics", {
        ...workflow.executionMetrics,
      });
    }

    return {
      workflowId: workflow.id,
      status: workflow.status,
      executedTaskIds,
      executedTasks,
      executionMetrics: workflow.executionMetrics ?? controller.finish(executionStatus),
      tasks: this.getWorkflowStatus(workflow.id).tasks,
    };
  }

  private releaseTaskAuthorization(task: WorkflowTask): void {
    if (task.mutationAuthorization) {
      this.mutationApproval.revoke(task.mutationAuthorization.receipt);
      delete task.mutationAuthorization;
    }
    task.approved = false;
  }

  cancelWorkflow(workflowId: string): {
    workflowId: string;
    cancellationRequested: boolean;
    status: WebsiteWorkflow["status"];
  } {
    const workflow = this.requireWorkflow(workflowId);
    const controller = this.cancellationControllers.get(workflowId);
    if (!controller) {
      return {
        workflowId,
        cancellationRequested: false,
        status: workflow.status,
      };
    }
    controller.abort(new ExecutionStoppedError("cancelled"));
    return {
      workflowId,
      cancellationRequested: true,
      status: workflow.status,
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
    executionMetrics: ExecutionMetrics | null;
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
      executionMetrics: workflow.executionMetrics ?? null,
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
  if (tasks.some((task) => task.status === "interrupted")) return "interrupted";
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "blocked")) return "awaiting_approval";
  if (tasks.some((task) => task.status === "pending")) {
    return tasks.some((task) => task.status === "succeeded") ? "running" : "planned";
  }
  if (tasks.some((task) => task.status === "unsupported")) return "partial";
  return "completed";
}

function executionStatusForStop(error: ExecutionStoppedError): ExecutionMetrics["status"] {
  switch (error.reason) {
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    case "browser_operation_timeout":
      return "browser_operation_timed_out";
    case "api_request_timeout":
      return "api_request_timed_out";
    case "action_budget_exceeded":
      return "interrupted";
  }
}

function workflowStatusForExecution(
  status: ExecutionMetrics["status"],
): WebsiteWorkflow["status"] {
  if (status === "cancelled") return "cancelled";
  if (
    status === "timed_out" ||
    status === "browser_operation_timed_out" ||
    status === "api_request_timed_out"
  ) return "timed_out";
  return "interrupted";
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
