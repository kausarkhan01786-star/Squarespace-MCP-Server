import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, ElicitRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  MutationApprovalError,
  MutationApprovalGuard,
  type MutationProposalInput,
} from "./mutation-approval.js";
import { McpHumanApprovalPrompt } from "./mcp-human-approval.js";
import { textSectionMutationProposal } from "./squarespace-mutation-proposals.js";

const harmlessProposal: MutationProposalInput = {
  provider: "isolated-test",
  websiteId: "test-site-only",
  action: "test.approval",
  targetResource: "isolated-test-resource",
  payload: { label: "No CMS operation" },
  permissionScopes: ["design.update"],
};

const saveProposal = textSectionMutationProposal({
  websiteId: "test-site-only",
  pageId: "home-test-only",
  text: "No CMS operation",
});

const publishProposal: MutationProposalInput = {
  provider: "squarespace",
  websiteId: "test-site-only",
  pageId: "home-test-only",
  action: "content.publish",
  targetResource: "page:home-test-only",
  payload: { publish: true },
  permissionScopes: ["content.publish"],
};

async function withMockProtocolClient<T>(
  capabilities: ConstructorParameters<typeof Client>[1]["capabilities"],
  response: { action: "accept"; content: { approve: boolean } } |
    { action: "decline" | "cancel" } |
    Error,
  operation: (input: {
    approval: MutationApprovalGuard;
    requests: Array<{ message: string; requestedSchema: unknown }>;
    proposal: MutationProposalInput;
  }) => Promise<T>,
  proposal: MutationProposalInput = harmlessProposal,
): Promise<T> {
  const server = new McpServer({ name: "approval-protocol-test", version: "1.0.0" });
  const client = new Client(
    { name: "mock-elicitation-client", version: "1.0.0" },
    { capabilities },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const requests: Array<{ message: string; requestedSchema: unknown }> = [];
  if (capabilities?.elicitation?.form) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      requests.push({
        message: request.params.message,
        requestedSchema: request.params.requestedSchema,
      });
      if (response instanceof Error) throw response;
      return response;
    });
  }
  const approval = new MutationApprovalGuard(new McpHumanApprovalPrompt(server.server));
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await operation({ approval, requests, proposal });
  } finally {
    await client.close();
    await server.close();
  }
}

test("MCP protocol mock negotiates form elicitation and returns a one-use receipt on acceptance", async () => {
  await withMockProtocolClient(
    { elicitation: { form: {} } },
    { action: "accept", content: { approve: true } },
    async ({ approval, requests }) => {
      const authorization = await approval.requestApproval(harmlessProposal);
      assert.equal(requests.length, 1);
      assert.match(requests[0]!.message, /isolated-test-resource/);
      assert.match(requests[0]!.message, /No CMS operation/);
      assert.equal(JSON.stringify(authorization.receipt), "{}");
      await approval.runAuthorized(
        authorization.proposal,
        authorization.receipt,
        async () => {},
      );
      await assert.rejects(
        approval.runAuthorized(
          authorization.proposal,
          authorization.receipt,
          async () => {},
        ),
        { reason: "replayed" },
      );
    },
  );
});

test("MCP protocol mock Accept authorizes only the exact Squarespace Save proposal", async () => {
  await withMockProtocolClient(
    { elicitation: { form: {} } },
    { action: "accept", content: { approve: true } },
    async ({ approval, requests, proposal }) => {
      const authorization = await approval.requestApproval(proposal);
      assert.equal(requests.length, 1);
      assert.match(requests[0]!.message, /No CMS operation/);
      assert.match(requests[0]!.message, /content\.save/);
      assert.match(requests[0]!.message, /does not include or authorize a Publish action/);
      assert.deepEqual(authorization.proposal.permissionScopes, [
        "content.save",
        "content.section.create",
      ]);

      let fakeMutationCalls = 0;
      await approval.runAuthorized(
        authorization.proposal,
        authorization.receipt,
        async () => {
          approval.assertAuthorized({
            scope: "content.save",
            provider: "squarespace",
            websiteId: "test-site-only",
            pageId: "home-test-only",
            action: "content.add_text_section",
            targetResource: "page:home-test-only:bottom-section",
            payload: { ...authorization.proposal.payload },
          });
          fakeMutationCalls += 1;
        },
      );
      assert.equal(fakeMutationCalls, 1);
    },
    saveProposal,
  );
});

test("MCP protocol mock rejects a proposal changed after approval before fake mutation", async () => {
  await withMockProtocolClient(
    { elicitation: { form: {} } },
    { action: "accept", content: { approve: true } },
    async ({ approval, proposal }) => {
      const authorization = await approval.requestApproval(proposal);
      let fakeMutationCalls = 0;
      await assert.rejects(
        approval.runAuthorized(
          {
            ...authorization.proposal,
            payload: { ...authorization.proposal.payload, text: "Changed after approval" },
          },
          authorization.receipt,
          async () => {
            fakeMutationCalls += 1;
          },
        ),
        { reason: "scope_mismatch" },
      );
      assert.equal(fakeMutationCalls, 0);
    },
    saveProposal,
  );
});

test("MCP protocol mock requires a separate explicit acceptance for Publish", async () => {
  await withMockProtocolClient(
    { elicitation: { form: {} } },
    { action: "accept", content: { approve: true } },
    async ({ approval, requests }) => {
      const saveAuthorization = await approval.requestApproval(saveProposal);
      assert.equal(requests.length, 1);
      await assert.rejects(
        approval.runAuthorized(
          saveAuthorization.proposal,
          saveAuthorization.receipt,
          async () => approval.assertAuthorized({
            scope: "content.publish",
            provider: "squarespace",
            websiteId: "test-site-only",
          }),
        ),
        { reason: "scope_mismatch" },
      );

      const publishAuthorization = await approval.requestApproval(publishProposal);
      assert.equal(requests.length, 2);
      assert.match(requests[1]!.message, /content\.publish/);
      assert.match(requests[1]!.message, /explicitly requests Publish/);
      let fakePublishCalls = 0;
      await approval.runAuthorized(
        publishAuthorization.proposal,
        publishAuthorization.receipt,
        async () => {
          approval.assertAuthorized({
            scope: "content.publish",
            provider: "squarespace",
            websiteId: "test-site-only",
            pageId: "home-test-only",
            action: "content.publish",
            targetResource: "page:home-test-only",
            payload: { publish: true },
          });
          fakePublishCalls += 1;
        },
      );
      assert.equal(fakePublishCalls, 1);
    },
  );
});

for (const action of ["decline", "cancel"] as const) {
  test(`MCP protocol mock rejects ${action} without issuing authorization`, async () => {
    await withMockProtocolClient(
      { elicitation: { form: {} } },
      { action },
      async ({ approval, requests }) => {
        let fakeMutationCalls = 0;
        await assert.rejects(
          async () => {
            const authorization = await approval.requestApproval(harmlessProposal);
            await approval.runAuthorized(
              authorization.proposal,
              authorization.receipt,
              async () => {
                fakeMutationCalls += 1;
              },
            );
          },
          { reason: "rejected" },
        );
        assert.equal(requests.length, 1);
        assert.equal(fakeMutationCalls, 0);
        assert.throws(() => approval.assertAuthorized({
          scope: "design.update",
          provider: "isolated-test",
          websiteId: "test-site-only",
          action: "test.approval",
          targetResource: "isolated-test-resource",
          payload: { label: "No CMS operation" },
        }), { reason: "unavailable" });
      },
    );
  });
}

test("MCP protocol mock skips elicitation when the client lacks form capability", async () => {
  await withMockProtocolClient(
    {},
    { action: "accept", content: { approve: true } },
    async ({ approval, requests }) => {
      let fakeMutationCalls = 0;
      await assert.rejects(
        async () => {
          const authorization = await approval.requestApproval(harmlessProposal);
          await approval.runAuthorized(
            authorization.proposal,
            authorization.receipt,
            async () => {
              fakeMutationCalls += 1;
            },
          );
        },
        (error: unknown) =>
          error instanceof MutationApprovalError && error.reason === "unavailable",
      );
      assert.equal(requests.length, 0);
      assert.equal(fakeMutationCalls, 0);
    },
  );
});

for (const [label, error] of [
  ["transport failure", new McpError(ErrorCode.ConnectionClosed, "mock connection failure")],
  ["timeout", new McpError(ErrorCode.RequestTimeout, "mock timeout")],
] as const) {
  test(`MCP protocol mock fails closed on elicitation ${label}`, async () => {
    await withMockProtocolClient(
      { elicitation: { form: {} } },
      error,
      async ({ approval, requests }) => {
        let fakeMutationCalls = 0;
        await assert.rejects(
          async () => {
            const authorization = await approval.requestApproval(harmlessProposal);
            await approval.runAuthorized(
              authorization.proposal,
              authorization.receipt,
              async () => {
                fakeMutationCalls += 1;
              },
            );
          },
          (failure: unknown) =>
            failure instanceof MutationApprovalError && failure.reason === "unavailable",
        );
        assert.equal(requests.length, 1, label);
        assert.equal(fakeMutationCalls, 0);
        assert.throws(() => approval.assertAuthorized({
          scope: "design.update",
          provider: "isolated-test",
          websiteId: "test-site-only",
          action: "test.approval",
          targetResource: "isolated-test-resource",
          payload: { label: "No CMS operation" },
        }), { reason: "unavailable" });
      },
    );
  });
}
