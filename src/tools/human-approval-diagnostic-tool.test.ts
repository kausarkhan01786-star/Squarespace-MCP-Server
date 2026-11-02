import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, ElicitRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { MutationApprovalGuard } from "../approval/mutation-approval.js";
import { registerHumanApprovalDiagnosticTool } from "./human-approval-diagnostic-tool.js";

type ElicitationResponse =
  | { action: "accept"; content: { decision: "Accept" | "Decline" } }
  | { action: "decline" | "cancel" }
  | Error;

async function callDiagnostic(
  response: ElicitationResponse,
  formCapability = true,
): Promise<{
  result: Awaited<ReturnType<Client["callTool"]>>;
  promptMessages: string[];
  toolNames: string[];
  approval: MutationApprovalGuard;
}> {
  const server = new McpServer({ name: "diagnostic-test", version: "1.0.0" });
  registerHumanApprovalDiagnosticTool(server);
  const client = new Client(
    { name: "diagnostic-mock-client", version: "1.0.0" },
    { capabilities: formCapability ? { elicitation: { form: {} } } : {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const promptMessages: string[] = [];
  if (formCapability) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      promptMessages.push(request.params.message);
      if (response instanceof Error) throw response;
      return response;
    });
  }
  const approval = new MutationApprovalGuard({
    requestApproval: async () => true,
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const result = await client.callTool({
      name: "test_human_approval_prompt",
      arguments: {},
    });
    return {
      result,
      promptMessages,
      toolNames: listed.tools.map((tool) => tool.name),
      approval,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

test("diagnostic tool requests an explicit form and returns the host's Accept response only", async () => {
  const { result, promptMessages, toolNames, approval } = await callDiagnostic({
    action: "accept",
    content: { decision: "Accept" },
  });
  assert.deepEqual(toolNames, ["test_human_approval_prompt"]);
  assert.deepEqual(promptMessages, [
    "This is a test approval prompt. No website or CMS will be changed.",
  ]);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    status: "responded",
    action: "accept",
    decision: "Accept",
    errorCode: null,
  });
  assert.throws(() => approval.assertAuthorized({
    scope: "design.update",
    provider: "isolated-test",
    websiteId: "test-site-only",
    action: "test.approval",
    targetResource: "isolated-test-resource",
    payload: {},
  }), { reason: "unavailable" });
});

test("diagnostic tool returns host decline and cancellation without authorizing mutations", async () => {
  for (const response of [
    { action: "decline" },
    { action: "cancel" },
  ] as const) {
    const { result, approval } = await callDiagnostic(response);
    assert.deepEqual(result.structuredContent, {
      status: "responded",
      action: response.action,
      decision: null,
      errorCode: null,
    });
    assert.throws(() => approval.assertAuthorized({
      scope: "design.update",
      provider: "isolated-test",
      websiteId: "test-site-only",
      action: "test.approval",
      targetResource: "isolated-test-resource",
      payload: {},
    }), { reason: "unavailable" });
  }
});

test("diagnostic tool reports host choice Decline as the unmodified host response", async () => {
  const { result } = await callDiagnostic({
    action: "accept",
    content: { decision: "Decline" },
  });
  assert.deepEqual(result.structuredContent, {
    status: "responded",
    action: "accept",
    decision: "Decline",
    errorCode: null,
  });
});

test("diagnostic tool fails closed and never sends an elicitation to a host without form support", async () => {
  const { result, promptMessages } = await callDiagnostic({
    action: "accept",
    content: { decision: "Accept" },
  }, false);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    status: "unsupported",
    action: null,
    decision: null,
    errorCode: "ELICITATION_UNSUPPORTED",
  });
  assert.deepEqual(promptMessages, []);
});

test("diagnostic tool reports elicitation transport errors and timeouts without a receipt", async () => {
  for (const [error, errorCode] of [
    [new McpError(ErrorCode.ConnectionClosed, "mock connection failure"), "ELICITATION_FAILED"],
    [new McpError(ErrorCode.RequestTimeout, "mock timeout"), "ELICITATION_TIMEOUT"],
  ] as const) {
    const { result, approval } = await callDiagnostic(error);
    assert.equal(result.isError, true);
    assert.equal(
      (result.structuredContent as { errorCode: string }).errorCode,
      errorCode,
    );
    assert.throws(() => approval.assertAuthorized({
      scope: "design.update",
      provider: "isolated-test",
      websiteId: "test-site-only",
      action: "test.approval",
      targetResource: "isolated-test-resource",
      payload: {},
    }), { reason: "unavailable" });
  }
});
