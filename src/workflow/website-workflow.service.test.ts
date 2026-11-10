import assert from "node:assert/strict";
import test from "node:test";
import { SquarespaceBrowserError } from "../browser/browser-errors.js";
import { ExecutionStoppedError } from "../execution/execution-controller.js";
import {
  MutationApprovalGuard,
  type MutationProposal,
} from "../approval/mutation-approval.js";
import {
  type WorkflowAction,
  type WorkflowAdapter,
  type WorkflowCapability,
} from "./workflow-types.js";
import { WebsiteWorkflowService } from "./website-workflow.service.js";

const website = {
  id: "site-123",
  name: "Example site",
  url: "https://example.squarespace.com",
};

const brief = {
  businessType: "Consulting",
  websiteGoals: ["Explain services"],
  targetAudience: ["Small businesses"],
  requiredPages: [{
    name: "Home",
    purpose: "Introduce the business",
    sections: [{ name: "Hero", goal: "Explain the value proposition" }],
  }],
  requiredFeatures: [],
  contentRequirements: [],
  designPreferences: [],
  assetRequirements: [],
  responsiveRequirements: [],
  openQuestions: [],
};

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function createAdapter(overrides: Partial<WorkflowAdapter> = {}) {
  const calls: Array<{ action: WorkflowAction; websiteId: string }> = [];
  const adapter: WorkflowAdapter = {
    cms: "squarespace",
    getCapabilities: () => [
      capability("inspect_pages", "list_pages", true, false, true),
      capability("inspect_responsive", "inspect_mobile_responsive", true, false, true),
      capability("add_text_section", "add_text_section", false, true, false),
      capability("add_text_block", "add_text_block", false, true, false),
      capability("edit_text_block", "edit_text_block", false, true, false),
      capability("create_page", null, false, true, false, false),
    ],
    verifyWebsite: async (websiteId) => {
      if (websiteId !== website.id) {
        throw new SquarespaceBrowserError("WEBSITE_NOT_FOUND", "Website not found.");
      }
      return website;
    },
    execute: async (action, websiteId) => {
      calls.push({ action, websiteId });
      if (action === "inspect_responsive") {
        return { mobile: { horizontalOverflow: false } };
      }
      if (action === "add_text_block" || action === "edit_text_block") {
        return { blockId: "native-block-1", saved: true, published: false, verified: true, text: "New copy", sectionId: "section-1" };
      }
      return { success: true };
    },
    ...overrides,
  };
  return { adapter, calls };
}

function capability(
  action: WorkflowAction,
  toolName: string | null,
  readOnly: boolean,
  approvalRequired: boolean,
  retrySafe: boolean,
  supported = true,
): WorkflowCapability {
  return {
    action,
    supported,
    toolName,
    readOnly,
    approvalRequired,
    retrySafe,
    limitation: supported ? null : "Not supported.",
  };
}

function createService(
  adapter: WorkflowAdapter,
  now = () => new Date("2025-01-01T00:00:00.000Z"),
  requestApproval: (proposal: MutationProposal) => Promise<boolean> = async () => true,
) {
  let nextId = 1;
  return new WebsiteWorkflowService(
    new Map([[adapter.cms, adapter]]),
    new MutationApprovalGuard({ requestApproval }),
    now,
    () => uuid(nextId++),
  );
}

function planInput(tasks: Array<Record<string, unknown>>) {
  return {
    cms: "squarespace",
    website_id: website.id,
    brief,
    tasks,
  };
}

test("validates and summarizes AI-authored requirement structures without claiming image analysis", () => {
  const { adapter } = createAdapter();
  const service = createService(adapter);
  const result = service.analyzeRequirements({ brief });

  assert.equal(result.summary.requestedPageCount, 1);
  assert.equal(result.summary.requestedSectionCount, 1);
  assert.equal(result.designSpecification, null);
  assert.match(result.limitations[0]!, /does not run an LLM/);
  assert.equal(result.unresolvedQuestions.length, 1);
});

test("rejects unknown CMS and verifies the selected website before planning", async () => {
  const { adapter } = createAdapter();
  const service = createService(adapter);

  await assert.rejects(
    service.planWorkflow({ ...planInput([{ action: "inspect_pages" }]), cms: "shopify" }),
    (error: unknown) =>
      error instanceof SquarespaceBrowserError &&
      error.code === "WORKFLOW_CMS_UNAVAILABLE",
  );
  await assert.rejects(
    service.planWorkflow({ ...planInput([{ action: "inspect_pages" }]), website_id: "other" }),
    (error: unknown) =>
      error instanceof SquarespaceBrowserError &&
      error.code === "WEBSITE_NOT_FOUND",
  );
});

test("refuses a CMS adapter that reports a different website identity", async () => {
  const { adapter } = createAdapter({
    verifyWebsite: async () => ({ ...website, id: "another-site" }),
  });
  const service = createService(adapter);
  await assert.rejects(
    service.planWorkflow(planInput([{ action: "inspect_pages" }])),
    (error: unknown) =>
      error instanceof SquarespaceBrowserError &&
      error.code === "WORKFLOW_CMS_UNAVAILABLE",
  );
});

test("marks unsupported operations and validates required action arguments", async () => {
  const { adapter } = createAdapter();
  const service = createService(adapter);
  const result = await service.planWorkflow(planInput([
    { action: "inspect_pages" },
    { action: "create_page" },
  ]));

  assert.equal(result.tasks[0]!.status, "pending");
  assert.equal(result.tasks[1]!.status, "unsupported");
  assert.equal(result.tasks[1]!.approvalRequired, false);
  await assert.rejects(
    service.planWorkflow(planInput([{ action: "inspect_page_sections" }])),
    { name: "ZodError" },
  );
  await assert.rejects(
    service.planWorkflow(planInput([{
      action: "add_text_section",
      page_id: "home",
      text: "Hello",
      background_color: "#000000",
      text_color: "#000000",
      confirm_potentially_live_save: true,
    }])),
    { name: "ZodError" },
  );
});

test("requires immutable-plan approval before executing live content changes", async () => {
  const { adapter, calls } = createAdapter();
  const service = createService(adapter);
  const plan = await service.planWorkflow(planInput([{
    action: "add_text_section",
    page_id: "home",
    text: "Kausar Mia",
    background_color: "#FFFFFF",
    text_color: "#000000",
    confirm_potentially_live_save: true,
  }]));
  const taskId = plan.tasks[0]!.id;

  const blocked = await service.executeWorkflow({
    workflow_id: plan.workflowId,
    max_tasks: 1,
  });
  assert.equal(blocked.status, "awaiting_approval");
  assert.deepEqual(calls, []);

  await assert.rejects(
    service.approveTasks({
      workflow_id: plan.workflowId,
      plan_fingerprint: "0".repeat(64),
      task_ids: [taskId],
    }),
    (error: unknown) =>
      error instanceof SquarespaceBrowserError &&
      error.code === "WORKFLOW_PLAN_MISMATCH",
  );
  await service.approveTasks({
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: [taskId],
  });
  const executed = await service.executeWorkflow({
    workflow_id: plan.workflowId,
    max_tasks: 1,
  });
  assert.equal(executed.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(executed.executedTasks.length, 1);
  assert.deepEqual(executed.executedTasks[0]!.result, { success: true });
  assert.equal(calls[0]!.action, "add_text_section");
  assert.equal(service.getQaReport(plan.workflowId).status, "partial");
});

test("workflow approval requests one host decision for the exact bounded task scope", async () => {
  let promptProposal: MutationProposal | undefined;
  const { adapter } = createAdapter();
  const service = createService(
    adapter,
    () => new Date("2025-01-01T00:00:00.000Z"),
    async (proposal) => {
      promptProposal = proposal;
      return false;
    },
  );
  const plan = await service.planWorkflow(planInput([{
    action: "add_text_section",
    page_id: "home",
    text: "Kausar Mia",
    background_color: "#FFFFFF",
    text_color: "#000000",
    confirm_potentially_live_save: true,
  }]));
  await assert.rejects(service.approveTasks({
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: [plan.tasks[0]!.id],
  }), { reason: "rejected" });
  assert.equal(promptProposal?.websiteId, website.id);
  assert.equal(promptProposal?.action, "workflow.execute");
  assert.equal(promptProposal?.payload.planFingerprint, plan.fingerprint);
  assert.equal((promptProposal?.payload.operations as unknown[]).length, 1);
  assert.deepEqual(promptProposal?.permissionScopes, ["content.save", "content.section.create"]);
  assert.equal(service.getWorkflowStatus(plan.workflowId).tasks[0]?.approved, false);
  assert.equal(service.getWorkflowStatus(plan.workflowId).tasks[0]?.status, "pending");
});

test("one authorization covers multiple planned mutation tasks and prompts only once", async () => {
  let prompts = 0;
  const { adapter, calls } = createAdapter();
  const service = createService(adapter, undefined, async () => {
    prompts += 1;
    return true;
  });
  const plan = await service.planWorkflow(planInput([
    {
      action: "add_text_section",
      page_id: "home",
      text: "First section",
      background_color: "#FFFFFF",
      text_color: "#000000",
    },
    {
      action: "add_text_section",
      page_id: "home",
      text: "Second section",
      background_color: "#FFFFFF",
      text_color: "#000000",
    },
  ]));

  const approved = await service.approveTasks({
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: plan.tasks.map((task) => task.id),
  });
  assert.equal(prompts, 1);
  assert.equal(approved.approvedTaskIds.length, 2);

  const result = await service.executeWorkflow({
    workflow_id: plan.workflowId,
    max_tasks: 2,
  });
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 2);
});

test("revokes the task grant when the approved resource baseline changes", async () => {
  let baselineReads = 0;
  const { adapter, calls } = createAdapter({
    captureBaseline: async () => ({
      resourceKey: "page:home",
      fingerprint: ++baselineReads === 1 ? "baseline-before" : "baseline-changed",
    }),
  });
  const service = createService(adapter);
  const plan = await service.planWorkflow(planInput([{
    action: "add_text_section",
    page_id: "home",
    text: "Hello",
    background_color: "#FFFFFF",
    text_color: "#000000",
  }]));
  await service.approveTasks({
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: [plan.tasks[0]!.id],
  });

  const result = await service.executeWorkflow({ workflow_id: plan.workflowId, max_tasks: 1 });
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.tasks[0]?.status, "blocked");
  assert.match(result.tasks[0]?.error ?? "", /changed after planning/i);
  assert.equal(calls.length, 0);
});

test("one task grant authorizes multiple exact native Text Block operations", async () => {
  let prompts = 0;
  const { adapter, calls } = createAdapter();
  const service = createService(adapter, undefined, async () => { prompts += 1; return true; });
  const plan = await service.planWorkflow(planInput([
    {
      action: "add_text_block",
      page_id: "services",
      section_id: "section-1",
      text: "New copy",
    },
    {
      action: "edit_text_block",
      page_id: "services",
      section_id: "section-1",
      block_id: "existing-text-1",
      text: "New copy",
    },
  ]));
  assert.deepEqual(plan.tasks.map((task) => task.status), ["pending", "pending"]);
  await service.approveTasks({
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: plan.tasks.map((task) => task.id),
  });
  assert.equal(prompts, 1);
  const result = await service.executeWorkflow({ workflow_id: plan.workflowId, max_tasks: 2 });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map((call) => call.action), ["add_text_block", "edit_text_block"]);
  assert.equal(result.tasks.every((task) => task.status === "succeeded"), true);
});

test("Text Block workflow tasks require explicit section and existing block identities", async () => {
  const { adapter } = createAdapter();
  const service = createService(adapter);
  await assert.rejects(
    service.planWorkflow(planInput([{
      action: "add_text_block",
      page_id: "services",
      text: "Copy",
    }])),
    { name: "ZodError" },
  );
  await assert.rejects(
    service.planWorkflow(planInput([{
      action: "edit_text_block",
      page_id: "services",
      section_id: "section-1",
      text: "Copy",
    }])),
    { name: "ZodError" },
  );
});

test("prevents overlapping approval prompts and workflow execution", async () => {
  let promptStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  let acceptPrompt: ((accepted: boolean) => void) | undefined;
  const promptResult = new Promise<boolean>((resolve) => {
    acceptPrompt = resolve;
  });
  const { adapter } = createAdapter();
  const service = createService(
    adapter,
    () => new Date("2025-01-01T00:00:00.000Z"),
    async () => {
      promptStarted?.();
      return promptResult;
    },
  );
  const plan = await service.planWorkflow(planInput([{
    action: "add_text_section",
    page_id: "home",
    text: "Kausar Mia",
    background_color: "#FFFFFF",
    text_color: "#000000",
    confirm_potentially_live_save: true,
  }]));
  const approvalInput = {
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: [plan.tasks[0]!.id],
  };
  const approving = service.approveTasks(approvalInput);
  await started;
  await assert.rejects(service.approveTasks(approvalInput), {
    code: "WORKFLOW_ALREADY_RUNNING",
  });
  await assert.rejects(service.executeWorkflow({
    workflow_id: plan.workflowId,
    max_tasks: 1,
  }), { code: "WORKFLOW_ALREADY_RUNNING" });
  acceptPrompt?.(true);
  await approving;
});

test("rejects a mixed valid/invalid approval request without granting partial approval", async () => {
  const { adapter } = createAdapter();
  const service = createService(adapter);
  const plan = await service.planWorkflow(planInput([
    {
      action: "add_text_section",
      page_id: "home",
      text: "One",
      background_color: "#FFFFFF",
      text_color: "#000000",
      confirm_potentially_live_save: true,
    },
    {
      action: "add_text_section",
      page_id: "home",
      text: "Two",
      background_color: "#FFFFFF",
      text_color: "#000000",
      confirm_potentially_live_save: true,
    },
  ]));
  await assert.rejects(
    service.approveTasks({
      workflow_id: plan.workflowId,
      plan_fingerprint: plan.fingerprint,
      task_ids: [plan.tasks[0]!.id, uuid(999)],
    }),
    (error: unknown) =>
      error instanceof SquarespaceBrowserError &&
      error.code === "WORKFLOW_TASK_NOT_FOUND",
  );
  assert.equal(service.getWorkflowStatus(plan.workflowId).tasks[0]!.approved, false);
  assert.equal(service.getWorkflowStatus(plan.workflowId).tasks[1]!.approved, false);
});

test("serializes execution and does not retry failed mutation tasks", async () => {
  let releaseExecution: (() => void) | undefined;
  let startedExecution: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedExecution = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  let mutationCalls = 0;
  const { adapter } = createAdapter({
    execute: async () => {
      mutationCalls += 1;
      startedExecution?.();
      await gate;
      throw new Error("failed after attempting mutation");
    },
  });
  const service = createService(adapter);
  const plan = await service.planWorkflow(planInput([{
    action: "add_text_section",
    page_id: "home",
    text: "Hello",
    background_color: "#FFFFFF",
    text_color: "#000000",
    confirm_potentially_live_save: true,
  }]));
  await service.approveTasks({
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: [plan.tasks[0]!.id],
  });
  const firstExecution = service.executeWorkflow({
    workflow_id: plan.workflowId,
    max_tasks: 1,
  });
  await started;
  await assert.rejects(
    service.executeWorkflow({ workflow_id: plan.workflowId, max_tasks: 1 }),
    (error: unknown) =>
      error instanceof SquarespaceBrowserError &&
      error.code === "WORKFLOW_ALREADY_RUNNING",
  );
  releaseExecution?.();
  await firstExecution;
  const retryResult = await service.executeWorkflow({
    workflow_id: plan.workflowId,
    max_tasks: 1,
    retry_failed_read_only: true,
  });
  assert.equal(retryResult.status, "failed");
  assert.equal(mutationCalls, 1);
});

test("retries only failed tasks explicitly declared safe and read-only", async () => {
  let calls = 0;
  const { adapter } = createAdapter({
    execute: async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient read failure");
      return { success: true };
    },
  });
  const service = createService(adapter);
  const plan = await service.planWorkflow(planInput([{ action: "inspect_pages" }]));
  const first = await service.executeWorkflow({
    workflow_id: plan.workflowId,
    max_tasks: 1,
  });
  assert.equal(first.status, "failed");
  const retried = await service.executeWorkflow({
    workflow_id: plan.workflowId,
    max_tasks: 1,
    retry_failed_read_only: true,
  });
  assert.equal(retried.status, "completed");
  assert.equal(retried.executionMetrics.retryCount, 1);
  assert.equal(calls, 2);
});

test("cancellation interrupts an in-flight mutation and never replays it", async () => {
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let releaseResolve: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  let calls = 0;
  const { adapter } = createAdapter({
    execute: async (_action, _websiteId, _args, execution) => {
      calls += 1;
      execution?.browser.markMutationStarted();
      startedResolve?.();
      await pending;
      return { changed: true };
    },
  });
  const service = createService(adapter);
  const plan = await service.planWorkflow(planInput([{
    action: "add_text_section",
    page_id: "home",
    text: "Hello",
    background_color: "#FFFFFF",
    text_color: "#000000",
    confirm_potentially_live_save: true,
  }]));
  await service.approveTasks({
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: [plan.tasks[0]!.id],
  });

  const running = service.executeWorkflow({ workflow_id: plan.workflowId, max_tasks: 1 });
  await started;
  assert.equal(service.cancelWorkflow(plan.workflowId).cancellationRequested, true);
  releaseResolve?.();
  const result = await running;

  assert.equal(result.status, "cancelled");
  assert.equal(result.tasks[0]?.status, "interrupted");
  assert.match(result.tasks[0]?.error ?? "", /final state is uncertain/i);
  assert.equal(result.executionMetrics.status, "cancelled");
  assert.equal(calls, 1);
  const retry = await service.executeWorkflow({ workflow_id: plan.workflowId, max_tasks: 1 });
  assert.equal(retry.status, "interrupted");
  assert.equal(calls, 1);
});

test("cancellation stops a multi-step workflow before starting the next task", async () => {
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let releaseResolve: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const calls: WorkflowAction[] = [];
  const executionIds: Array<{ workflowId: string | undefined; taskId: string | undefined }> = [];
  const { adapter } = createAdapter({
    execute: async (action, _websiteId, _args, execution) => {
      calls.push(action);
      executionIds.push({
        workflowId: execution?.workflowId,
        taskId: execution?.taskId,
      });
      if (calls.length === 1) {
        startedResolve?.();
        await pending;
      }
      return {};
    },
  });
  const service = createService(adapter);
  const plan = await service.planWorkflow(planInput([
    { action: "inspect_pages" },
    { action: "inspect_responsive", page_id: "home" },
  ]));

  const running = service.executeWorkflow({
    workflow_id: plan.workflowId,
    max_tasks: 2,
  });
  await started;
  service.cancelWorkflow(plan.workflowId);
  const result = await running;

  assert.equal(result.status, "cancelled");
  assert.equal(result.executionMetrics.status, "cancelled");
  assert.deepEqual(calls, ["inspect_pages"]);
  assert.deepEqual(executionIds, [{
    workflowId: plan.workflowId,
    taskId: plan.tasks[0]!.id,
  }]);
  releaseResolve?.();
});

test("reports browser and API operation timeouts as distinct execution outcomes", async () => {
  for (const [reason, metricStatus] of [
    ["browser_operation_timeout", "browser_operation_timed_out"],
    ["api_request_timeout", "api_request_timed_out"],
  ] as const) {
    const { adapter } = createAdapter({
      execute: async () => {
        throw new ExecutionStoppedError(reason);
      },
    });
    const service = createService(adapter);
    const plan = await service.planWorkflow(planInput([{ action: "inspect_pages" }]));
    const result = await service.executeWorkflow({
      workflow_id: plan.workflowId,
      max_tasks: 1,
    });

    assert.equal(result.status, "timed_out");
    assert.equal(result.executionMetrics.status, metricStatus);
    assert.equal(result.tasks[0]?.status, "interrupted");
  }
});

test("deadline after a mutation starts marks it interrupted rather than retryable", async () => {
  let clock = 0;
  let calls = 0;
  const { adapter } = createAdapter({
    execute: async () => {
      calls += 1;
      clock = 2_000;
      return { changed: true };
    },
  });
  const service = createService(adapter, () => new Date(clock));
  const plan = await service.planWorkflow(planInput([{
    action: "add_text_section",
    page_id: "home",
    text: "Hello",
    background_color: "#FFFFFF",
    text_color: "#000000",
    confirm_potentially_live_save: true,
  }]));
  await service.approveTasks({
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: [plan.tasks[0]!.id],
  });

  const result = await service.executeWorkflow({
    workflow_id: plan.workflowId,
    max_tasks: 1,
    timeout_ms: 1_000,
  });
  assert.equal(result.status, "timed_out");
  assert.equal(result.tasks[0]?.status, "interrupted");
  assert.equal(result.executionMetrics.status, "timed_out");
  assert.equal(calls, 1);
});

test("browser-action budget is reported and an interrupted mutation is not retried", async () => {
  let calls = 0;
  const { adapter } = createAdapter({
    execute: async (_action, _websiteId, _args, execution) => {
      calls += 1;
      execution?.browser.beforeBrowserAction();
      execution?.browser.beforeBrowserAction();
      return {};
    },
  });
  const service = createService(adapter);
  const plan = await service.planWorkflow(planInput([{
    action: "add_text_section",
    page_id: "home",
    text: "Hello",
    background_color: "#FFFFFF",
    text_color: "#000000",
    confirm_potentially_live_save: true,
  }]));
  await service.approveTasks({
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: [plan.tasks[0]!.id],
  });

  const result = await service.executeWorkflow({
    workflow_id: plan.workflowId,
    max_tasks: 1,
    max_browser_actions: 1,
  });
  assert.equal(result.status, "interrupted");
  assert.equal(result.tasks[0]?.status, "interrupted");
  assert.equal(result.executionMetrics.browserActionCount, 1);
  await service.executeWorkflow({ workflow_id: plan.workflowId, max_tasks: 1 });
  assert.equal(calls, 1);
});

test("QA reports responsive evidence only when returned by the registered inspector", async () => {
  const { adapter } = createAdapter();
  const service = createService(adapter);
  const plan = await service.planWorkflow(planInput([{
    action: "inspect_responsive",
    page_id: "home",
  }]));

  assert.equal(service.getQaReport(plan.workflowId).status, "not_run");
  await service.executeWorkflow({ workflow_id: plan.workflowId, max_tasks: 1 });
  const report = service.getQaReport(plan.workflowId);
  assert.equal(report.status, "passed");
  assert.ok(report.checks.some((check) =>
    check.check === "mobile_horizontal_overflow" && check.status === "passed"));
});

test("workflow state is process-local and unknown workflow IDs fail explicitly", () => {
  const { adapter } = createAdapter();
  const service = createService(adapter);
  assert.throws(
    () => service.getWorkflowStatus(uuid(100)),
    (error: unknown) =>
      error instanceof SquarespaceBrowserError &&
      error.code === "WORKFLOW_NOT_FOUND",
  );
});
