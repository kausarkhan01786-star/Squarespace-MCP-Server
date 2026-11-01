import assert from "node:assert/strict";
import test from "node:test";
import { SquarespaceBrowserError } from "../browser/browser-errors.js";
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

function createService(adapter: WorkflowAdapter) {
  let nextId = 1;
  return new WebsiteWorkflowService(
    new Map([[adapter.cms, adapter]]),
    () => new Date("2025-01-01T00:00:00.000Z"),
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

  assert.throws(
    () => service.approveTasks({
      workflow_id: plan.workflowId,
      plan_fingerprint: "0".repeat(64),
      task_ids: [taskId],
      confirmed: true,
    }),
    (error: unknown) =>
      error instanceof SquarespaceBrowserError &&
      error.code === "WORKFLOW_PLAN_MISMATCH",
  );
  service.approveTasks({
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: [taskId],
    confirmed: true,
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
  assert.throws(
    () => service.approveTasks({
      workflow_id: plan.workflowId,
      plan_fingerprint: plan.fingerprint,
      task_ids: [plan.tasks[0]!.id, uuid(999)],
      confirmed: true,
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
  service.approveTasks({
    workflow_id: plan.workflowId,
    plan_fingerprint: plan.fingerprint,
    task_ids: [plan.tasks[0]!.id],
    confirmed: true,
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
  assert.equal(calls, 2);
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
