import assert from "node:assert/strict";
import test from "node:test";
import {
  MutationApprovalError,
  MutationApprovalGuard,
  type MutationProposalInput,
} from "./mutation-approval.js";
import { McpHumanApprovalPrompt } from "./mcp-human-approval.js";
import { formatProposalForHuman } from "./mcp-human-approval.js";

const proposalInput: MutationProposalInput = {
  provider: "squarespace",
  websiteId: "site-1",
  pageId: "home-1",
  action: "content.add_text_section",
  targetResource: "page:home-1:bottom-section",
  payload: {
    sectionPosition: "bottom",
    block: { type: "Text", text: "Kausar Mia" },
    sectionBackground: "#FFFFFF",
    textColor: "#000000",
    save: true,
    publish: false,
  },
  permissionScopes: ["content.section.create", "content.save"],
};

test("requires host approval and does not treat an input Boolean as authorization", async () => {
  const approval = new MutationApprovalGuard({ requestApproval: async () => false });
  await assert.rejects(approval.requestApproval(proposalInput), {
    reason: "rejected",
  });
  assert.throws(() => approval.assertAuthorized({
    scope: "content.section.create",
    provider: "squarespace",
    websiteId: "site-1",
    pageId: "home-1",
    action: "content.add_text_section",
    targetResource: "page:home-1:bottom-section",
    payload: proposalInput.payload,
  }), { reason: "unavailable" });
});

test("binds a one-time receipt to the exact proposal and rejects replay", async () => {
  const approval = new MutationApprovalGuard({ requestApproval: async () => true });
  const authorization = await approval.requestApproval(proposalInput);
  assert.equal(Object.isFrozen(authorization.proposal), true);
  assert.equal(Object.isFrozen(authorization.proposal.payload), true);

  await approval.runAuthorized(
    authorization.proposal,
    authorization.receipt,
    async () => {
      approval.assertAuthorized({
        scope: "content.section.create",
        provider: "squarespace",
        websiteId: "site-1",
        pageId: "home-1",
        action: "content.add_text_section",
        targetResource: "page:home-1:bottom-section",
        payload: proposalInput.payload,
      });
      approval.assertAuthorized({
        scope: "content.save",
        provider: "squarespace",
        websiteId: "site-1",
        pageId: "home-1",
        action: "content.add_text_section",
        targetResource: "page:home-1:bottom-section",
        payload: proposalInput.payload,
      });
    },
  );

  await assert.rejects(
    approval.runAuthorized(
      authorization.proposal,
      authorization.receipt,
      async () => {},
    ),
    { reason: "replayed" },
  );
});

test("rejects mismatched targets, actions, payloads, and permission scopes", async () => {
  const approval = new MutationApprovalGuard({ requestApproval: async () => true });
  const authorization = await approval.requestApproval(proposalInput);

  await assert.rejects(
    approval.runAuthorized(
      { ...authorization.proposal, websiteId: "other-site" },
      authorization.receipt,
      async () => {},
    ),
    { reason: "scope_mismatch" },
  );

  const expected = {
    scope: "content.section.create" as const,
    provider: "squarespace",
    websiteId: "site-1",
    pageId: "home-1",
    action: "content.add_text_section",
    targetResource: "page:home-1:bottom-section",
    payload: proposalInput.payload,
  };
  for (const mismatch of [
    { pageId: "other-page" },
    { action: "content.delete" },
    { targetResource: "page:home-1:other-section" },
  ]) {
    const scoped = await approval.requestApproval(proposalInput);
    await assert.rejects(approval.runAuthorized(
      scoped.proposal,
      scoped.receipt,
      async () => approval.assertAuthorized({ ...expected, ...mismatch }),
    ), { reason: "scope_mismatch" });
  }

  const fresh = await approval.requestApproval(proposalInput);
  await assert.rejects(approval.runAuthorized(
    fresh.proposal,
    fresh.receipt,
    async () => approval.assertAuthorized({
      scope: "content.publish",
      provider: "squarespace",
      websiteId: "site-1",
      pageId: "home-1",
      action: "content.add_text_section",
      targetResource: "page:home-1:bottom-section",
      payload: proposalInput.payload,
    }),
  ), { reason: "scope_mismatch" });

  const wrongPayload = await approval.requestApproval(proposalInput);
  await assert.rejects(approval.runAuthorized(
    wrongPayload.proposal,
    wrongPayload.receipt,
    async () => approval.assertAuthorized({
      scope: "content.save",
      provider: "squarespace",
      websiteId: "site-1",
      pageId: "home-1",
      action: "content.add_text_section",
      targetResource: "page:home-1:bottom-section",
      payload: { ...proposalInput.payload, publish: true },
    }),
  ), { reason: "scope_mismatch" });
});

test("expires approval receipts and revokes receipts that are not consumed", async () => {
  let now = new Date("2025-01-01T00:00:00.000Z");
  const approval = new MutationApprovalGuard(
    { requestApproval: async () => true },
    100,
    () => now,
  );
  const expired = await approval.requestApproval(proposalInput);
  now = new Date(now.getTime() + 101);
  let expiredMutationCalls = 0;
  await assert.rejects(
    approval.runAuthorized(expired.proposal, expired.receipt, async () => {
      expiredMutationCalls += 1;
    }),
    { reason: "expired" },
  );
  assert.equal(expiredMutationCalls, 0);

  now = new Date("2025-01-01T00:00:00.000Z");
  const revoked = await approval.requestApproval(proposalInput);
  approval.revoke(revoked.receipt);
  let revokedMutationCalls = 0;
  await assert.rejects(
    approval.runAuthorized(revoked.proposal, revoked.receipt, async () => {
      revokedMutationCalls += 1;
    }),
    { reason: "replayed" },
  );
  assert.equal(revokedMutationCalls, 0);
});

test("prevents one proposal from authorizing both Save and Publish", async () => {
  const approval = new MutationApprovalGuard({ requestApproval: async () => true });
  await assert.rejects(approval.requestApproval({
    ...proposalInput,
    permissionScopes: ["content.save", "content.publish"],
  }), { reason: "invalid" });
});

test("isolates concurrent authorization contexts", async () => {
  const approval = new MutationApprovalGuard({ requestApproval: async () => true });
  const [first, second] = await Promise.all([
    approval.requestApproval(proposalInput),
    approval.requestApproval({ ...proposalInput, websiteId: "site-2" }),
  ]);
  let releaseFirst: (() => void) | undefined;
  const firstWait = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const firstRun = approval.runAuthorized(first.proposal, first.receipt, async () => {
    firstEntered?.();
    await firstWait;
    approval.assertAuthorized({
      scope: "content.save",
      provider: "squarespace",
      websiteId: "site-1",
      pageId: "home-1",
      action: "content.add_text_section",
      targetResource: "page:home-1:bottom-section",
      payload: proposalInput.payload,
    });
  });
  await entered;
  await approval.runAuthorized(second.proposal, second.receipt, async () => {
    approval.assertAuthorized({
      scope: "content.save",
      provider: "squarespace",
      websiteId: "site-2",
      pageId: "home-1",
      action: "content.add_text_section",
      targetResource: "page:home-1:bottom-section",
      payload: proposalInput.payload,
    });
  });
  releaseFirst?.();
  await firstRun;
});

test("formats the exact proposal and explicitly excludes publishing", async () => {
  const approval = new MutationApprovalGuard({ requestApproval: async () => true });
  const { proposal } = await approval.requestApproval(proposalInput);
  const prompt = formatProposalForHuman(proposal);
  assert.match(prompt, /Kausar Mia/);
  assert.match(prompt, /#FFFFFF/);
  assert.match(prompt, /#000000/);
  assert.match(prompt, /may make the requested change live/i);
  assert.match(prompt, /does not include or authorize a Publish action/i);
  assert.deepEqual(proposal.permissionScopes, ["content.save", "content.section.create"]);
  assert.equal(proposal.payload.publish, false);
});

test("fails closed when the connected MCP host lacks form elicitation", async () => {
  const prompt = new McpHumanApprovalPrompt({
    getClientCapabilities: () => undefined,
    elicitInput: async () => {
      throw new Error("Must not call elicitation when unsupported.");
    },
  });
  await assert.rejects(
    prompt.requestApproval({
      ...proposalInput,
      id: "proposal-id",
      payloadHash: "hash",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    }),
    (error: unknown) =>
      error instanceof MutationApprovalError && error.reason === "unavailable",
  );
});

test("accepts only an explicit affirmative host response", async () => {
  let displayedMessage = "";
  const prompt = new McpHumanApprovalPrompt({
    getClientCapabilities: () => ({ elicitation: { form: {} } }),
    async elicitInput(params) {
      displayedMessage = params.message;
      return { action: "accept", content: { approve: true } };
    },
  });
  const approval = new MutationApprovalGuard(prompt);
  const { proposal } = await approval.requestApproval(proposalInput);
  assert.match(displayedMessage, /Kausar Mia/);
  assert.equal(proposal.payload.publish, false);

  const canceledPrompt = new McpHumanApprovalPrompt({
    getClientCapabilities: () => ({ elicitation: { form: {} } }),
    async elicitInput() {
      return { action: "cancel" };
    },
  });
  const canceledApproval = new MutationApprovalGuard(canceledPrompt);
  await assert.rejects(canceledApproval.requestApproval(proposalInput), {
    reason: "rejected",
  });

  const declinedPrompt = new McpHumanApprovalPrompt({
    getClientCapabilities: () => ({ elicitation: { form: {} } }),
    async elicitInput() {
      return { action: "decline" };
    },
  });
  const declinedApproval = new MutationApprovalGuard(declinedPrompt);
  await assert.rejects(declinedApproval.requestApproval(proposalInput), {
    reason: "rejected",
  });
});

test("does not issue authorization when elicitation rejects or times out", async () => {
  for (const rejection of [
    new Error("transport closed"),
    Object.assign(new Error("elicitation timed out"), { code: "RequestTimeout" }),
  ]) {
    const approval = new MutationApprovalGuard({
      requestApproval: async () => {
        throw rejection;
      },
    });
    await assert.rejects(approval.requestApproval(proposalInput), {
      reason: "unavailable",
    });
    assert.throws(() => approval.assertAuthorized({
      scope: "content.section.create",
      provider: "squarespace",
      websiteId: "site-1",
      pageId: "home-1",
      action: "content.add_text_section",
      targetResource: "page:home-1:bottom-section",
      payload: proposalInput.payload,
    }), { reason: "unavailable" });
  }
});

test("approval receipts are opaque and excluded from proposal serialization", async () => {
  const approval = new MutationApprovalGuard({ requestApproval: async () => true });
  const authorization = await approval.requestApproval(proposalInput);
  assert.equal(JSON.stringify(authorization.receipt), "{}");
  assert.doesNotMatch(JSON.stringify(authorization.proposal), /nonce|token|receipt/i);
  assert.doesNotMatch(formatProposalForHuman(authorization.proposal), /nonce|token|receipt/i);
});
