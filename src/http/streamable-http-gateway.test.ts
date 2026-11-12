import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import { SquarespaceBrowserService } from "../browser/squarespace-browser.service.js";
import { SharedBrowserRuntime } from "../runtime/shared-browser-runtime.js";
import { GatewaySecurity } from "./gateway-security.js";
import { GatewayShutdownTimeoutError, StreamableHttpGateway } from "./streamable-http-gateway.js";

const allowedOrigin = "http://localhost:4317";

function securityFixture() {
  const security = new GatewaySecurity({ allowedOrigins: [allowedOrigin] });
  const clientA = security.provisionClient({ id: "agent-a", scopes: ["mcp:connect"] });
  const clientB = security.provisionClient({ id: "agent-b", scopes: ["mcp:connect"] });
  return { security, clientA, clientB };
}

function runtimeFixture(browserOverrides: Record<string, unknown> = {}) {
  let closeCount = 0;
  const browser = {
    close: async () => { closeCount += 1; },
    ...browserOverrides,
  } as unknown as SquarespaceBrowserService;
  const runtime = new SharedBrowserRuntime({ browser });
  return { runtime, closeCount: () => closeCount };
}

function clientFor(url: string, credential: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { authorization: `Bearer ${credential}` },
    },
  });
  return {
    transport,
    client: new Client({ name: "gateway-fixture-client", version: "1.0.0" }),
  };
}

async function rawInitialize(url: string, credential: string, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "raw-test-client", version: "1.0.0" },
      },
    }),
  });
}

async function initializeSession(url: string, credential: string): Promise<string> {
  const response = await rawInitialize(url, credential);
  const sessionId = response.headers.get("mcp-session-id");
  assert.equal(response.status, 200);
  await response.text();
  assert.ok(sessionId);
  return sessionId;
}

function rawToolCall(url: string, credential: string, sessionId: string, signal?: AbortSignal) {
  return rawNamedToolCall(url, credential, sessionId, "list_websites", signal);
}

function rawNamedToolCall(
  url: string,
  credential: string,
  sessionId: string,
  name: string,
  signal?: AbortSignal,
) {
  return fetch(url, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomRequestId++,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
}

let randomRequestId = 100;

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const endAt = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= endAt) return reject(new Error("Timed out waiting for fixture state."));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function requireSignal<T>(signal: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    signal,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createFakeNativeTextEditor(onInsert: () => Promise<void>) {
  const state = { inserted: false, text: "" };
  const records = () => [
    { id: "existing-image", type: "image", definitionName: "Image", visibleText: "" },
    ...(state.inserted
      ? [{ id: "fake-created-block", type: "text", definitionName: "Text", visibleText: state.text }]
      : []),
  ];
  const blockElement = (record: ReturnType<typeof records>[number]) => ({
    getAttribute: (name: string) => name === "id" ? record.id
      : name === "data-block-type" ? record.type
        : name === "data-definition-name" ? record.definitionName
          : null,
    innerText: record.visibleText,
    querySelector: () => ({ innerText: record.visibleText }),
  });
  const sectionElement = () => ({
    getAttribute: (name: string) => name === "data-section-id" ? "section-1" : null,
    querySelectorAll: () => records().map(blockElement),
  });
  const locator = (kind: string): any => ({
    count: async () => kind === "section" || kind === "pageSections" ? 1
      : kind === "blocks" ? records().length
        : kind === "selector" ? Number(!state.inserted)
          : kind === "block" ? Number(state.inserted)
            : kind === "none" ? 0
              : 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    waitFor: async () => {},
    nth: () => locator(kind),
    last: () => locator(kind),
    hover: async () => {},
    click: async () => {
      if (kind === "textOption") {
        await onInsert();
        state.inserted = true;
      }
    },
    fill: async (text: string) => { state.text = text; },
    press: async () => {},
    evaluate: async (fn: (element: any) => unknown) => {
      if (kind === "editable") return fn({ value: state.text, innerText: state.text });
      const record = records().at(-1)!;
      return fn(blockElement(record));
    },
    evaluateAll: async (fn: (elements: any[]) => unknown) => fn(
      kind === "blocks" ? records().map(blockElement)
        : kind === "pageSections" ? [sectionElement()]
          : [],
    ),
    locator: (selector: string) => {
      if (selector === "[data-block-type]") return locator("blocks");
      if (selector.includes("contenteditable") || selector.includes('role="textbox"') || selector.includes("textarea")) {
        return locator("editable");
      }
      if (selector.includes("data-section-id")) return locator("section");
      if (selector.includes("fake-created-block")) return locator("block");
      if (selector.includes("Add Block")) return locator("add");
      return locator("other");
    },
    getByRole: (_role: string, args: { name: string }) => {
      if (args.name === "Block Selector") return locator("selector");
      if (args.name === "Text") return locator("textOption");
      if (args.name === "Write") return locator("write");
      return locator("other");
    },
  });
  const frame = {
    url: () => "https://fixture.squarespace.com/page-1",
    locator: (selector: string) => selector === '[data-test="page-section"]'
      ? locator("pageSections")
      : locator("section"),
  };
  const page = {
    url: () => "https://fixture.squarespace.com/page-1",
    frames: () => [frame],
    isClosed: () => false,
    locator: (selector: string) => selector.includes("sqs-site-frame")
      ? locator("none")
      : selector.includes("Save") || selector.includes("Exit")
        ? locator("control")
        : locator("other"),
    getByRole: (_role: string, args: { name: string }) =>
      args.name === "Edit" ? locator("control")
        : args.name === "Block Selector" ? locator("selector")
          : locator("other"),
    getByText: () => ({ first: () => ({ waitFor: async () => { throw new Error("No preview banner in fixture."); } }) }),
  };
  return { state, page };
}

function requestWithHost(url: string, host: string, credential: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        host,
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        "content-length": "2",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end("{}");
  });
}

test("two HTTP MCP clients get distinct sessions over the shared runtime and isolate session ownership", async () => {
  const { runtime, closeCount } = runtimeFixture();
  const { security, clientA: credentialA, clientB: credentialB } = securityFixture();
  const gateway = new StreamableHttpGateway({ runtime, security, maxSessions: 4 });
  const url = await gateway.start();
  const a = clientFor(url, credentialA.credential);
  const b = clientFor(url, credentialB.credential);
  try {
    await Promise.all([a.client.connect(a.transport), b.client.connect(b.transport)]);
    const [toolsA, toolsB] = await Promise.all([a.client.listTools(), b.client.listTools()]);
    assert.deepEqual(toolsA.tools.map((tool) => tool.name), toolsB.tools.map((tool) => tool.name));
    assert.ok(toolsA.tools.some((tool) => tool.name === "list_websites"));
    assert.equal(gateway.sessionCount, 2);

    const initializedA = await rawInitialize(url, credentialA.credential);
    const initializedB = await rawInitialize(url, credentialB.credential);
    const sessionA = initializedA.headers.get("mcp-session-id");
    const sessionB = initializedB.headers.get("mcp-session-id");
    assert.equal(initializedA.status, 200);
    assert.equal(initializedB.status, 200);
    assert.ok(sessionA && sessionB && sessionA !== sessionB);

    const crossClient = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${credentialA.credential}`,
        "mcp-session-id": sessionB,
      },
    });
    assert.equal(crossClient.status, 404);
    assert.equal(closeCount(), 0);
  } finally {
    await Promise.all([a.client.close(), b.client.close()]);
    await gateway.close();
  }
  assert.equal(closeCount(), 1);
});

test("Host, Origin, missing credentials, and invalid credentials are rejected", async () => {
  const { runtime } = runtimeFixture();
  const { security, clientA } = securityFixture();
  const gateway = new StreamableHttpGateway({ runtime, security });
  const url = await gateway.start();
  try {
    const target = new URL(url);
    assert.equal(await requestWithHost(url, `localhost:${target.port}`, clientA.credential), 403);
    assert.equal((await rawInitialize(url, clientA.credential, { origin: "http://evil.invalid" })).status, 403);
    assert.equal((await rawInitialize(url, clientA.credential, { origin: "null" })).status, 403);
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await rawInitialize(url, "invalid-token-value-0000000000000000000000000000000000")).status, 401);
    assert.equal((await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${clientA.credential}`,
        "mcp-session-id": "00000000-0000-4000-8000-000000000000",
      },
    })).status, 404);
  } finally {
    await gateway.close();
  }
});

test("DELETE terminates one session while an ordinary request disconnect does not close the browser", async () => {
  const { runtime, closeCount } = runtimeFixture();
  const { security, clientA } = securityFixture();
  const gateway = new StreamableHttpGateway({ runtime, security });
  const url = await gateway.start();
  try {
    const initialized = await rawInitialize(url, clientA.credential);
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.ok(sessionId);
    await initialized.text();
    assert.equal(gateway.sessionCount, 1);
    const disconnectedStream = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${clientA.credential}`,
        "mcp-session-id": sessionId,
        accept: "text/event-stream",
      },
    });
    await disconnectedStream.body?.cancel();
    // Closing an HTTP/SSE stream is not an MCP DELETE and must retain the session.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gateway.sessionCount, 1);
    assert.equal(closeCount(), 0);

    const deleted = await fetch(url, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${clientA.credential}`,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
      },
    });
    assert.equal(deleted.status, 200);
    assert.equal(gateway.sessionCount, 0);
    assert.equal(closeCount(), 0);
  } finally {
    await gateway.close();
  }
  assert.equal(closeCount(), 1);
});

test("DELETE drains an active add_text_block workflow mutation before closing once", async () => {
  let releaseMutation!: () => void;
  let signalMutationStarted!: () => void;
  const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
  const mutationStarted = new Promise<void>((resolve) => { signalMutationStarted = resolve; });
  const fakeWebsite = {
    id: "fixture-site",
    name: "Isolated fixture website",
    url: "https://fixture.squarespace.com",
  };
  const fakeEditor = createFakeNativeTextEditor(async () => {
    signalMutationStarted();
    await mutationGate;
  });
  const { runtime } = runtimeFixture({
    getWebsite: () => fakeWebsite,
    openWebsiteUrl: async () => {},
    getCurrentPage: async () => fakeEditor.page,
  });
  const { security, clientA } = securityFixture();
  const gateway = new StreamableHttpGateway({ runtime, security });
  const url = await gateway.start();
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${clientA.credential}` } },
  });
  const client = new Client(
    { name: "gateway-mutation-fixture-client", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler(ElicitRequestSchema, async () => ({
    action: "accept",
    content: { approve: true },
  }));
  let mutationCall: Promise<unknown> | undefined;
  try {
    await client.connect(transport);
    const sessionId = transport.sessionId;
    assert.ok(sessionId);
    const internals = gateway as unknown as {
      sessions: Map<string, {
        session: { close(): Promise<void>; workflow: unknown };
        transport: StreamableHTTPServerTransport;
        activeRequests: number;
        closing: boolean;
      }>;
    };
    const entry = internals.sessions.get(sessionId);
    assert.ok(entry);

    const workflow = entry.session.workflow as {
      adapters: Map<string, {
        services: {
          pages: {
            inspectPageSections(websiteId: string, pageId: string): Promise<unknown>;
            getPageDetails(websiteId: string, pageId: string): Promise<unknown>;
            savePageChanges(...args: unknown[]): Promise<unknown>;
          };
        };
      }>;
    };
    const adapter = workflow.adapters.get("squarespace");
    assert.ok(adapter);
    adapter.services.pages.inspectPageSections = async () => ({
      websiteId: fakeWebsite.id,
      pageId: "page-1",
      url: `${fakeWebsite.url}/page-1`,
      sectionsTruncated: false,
      sections: [{
        id: "section-1",
        theme: null,
        layout: "unknown",
        headings: [],
        visibleText: fakeEditor.state.text,
        textTruncated: false,
        blocks: [
          { id: "existing-image", type: "image", definitionName: "Image", visibleText: "", textTruncated: false },
          ...(fakeEditor.state.inserted ? [{
            id: "fake-created-block",
            type: "text",
            definitionName: "Text",
            visibleText: fakeEditor.state.text,
            textTruncated: false,
          }] : []),
        ],
        blocksTruncated: false,
      }],
    });
    adapter.services.pages.getPageDetails = async () => ({
      id: "page-1",
      websiteId: fakeWebsite.id,
      name: "Fixture page",
      navigationTitle: "Fixture page",
      type: "page",
      group: "main_navigation",
      groupLabel: "Main Navigation",
      parentId: null,
      parentPath: [],
      panelIdentity: { index: 0, rowDomId: null, observedLinks: [] },
      url: `${fakeWebsite.url}/page-1`,
      urlEvidence: { source: "pages_panel_href", status: "resolved", observedHrefs: [], settingsSlug: null },
      visibilityStatus: "enabled",
      enabled: true,
      identity: {
        kind: "native",
        native_id: "page-1",
        synthetic_id: null,
        title: "Fixture page",
        slug: "page-1",
        is_homepage: false,
      },
    });
    adapter.services.pages.savePageChanges = async () => ({
      success: true,
      saved: true,
      published: false,
      action: "saved",
      screenshots: { before: "fixture-before", after: "fixture-after" },
      inspection: { before: {}, after: {} },
    });

    let closeCount = 0;
    let signalCleanupCompleted!: () => void;
    const cleanupCompleted = new Promise<void>((resolve) => { signalCleanupCompleted = resolve; });
    let signalDeleteAdmitted!: () => void;
    const deleteAdmitted = new Promise<void>((resolve) => { signalDeleteAdmitted = resolve; });
    let signalDeleteMarked!: () => void;
    const deleteMarked = new Promise<void>((resolve) => { signalDeleteMarked = resolve; });
    let deleteTransportCalls = 0;
    const closeStandaloneSSEStream = entry.transport.closeStandaloneSSEStream.bind(entry.transport);
    entry.transport.closeStandaloneSSEStream = () => {
      signalDeleteMarked();
      closeStandaloneSSEStream();
    };
    const handleTransportRequest = entry.transport.handleRequest.bind(entry.transport);
    entry.transport.handleRequest = async (request, response, parsedBody) => {
      if (request.method === "DELETE") {
        deleteTransportCalls += 1;
        signalDeleteAdmitted();
      }
      await handleTransportRequest(request, response, parsedBody);
    };
    const closeableSession = entry.session;
    const closeOriginal = closeableSession.close.bind(closeableSession);
    (closeableSession as { close(): Promise<void> }).close = async () => {
      closeCount += 1;
      try {
        await closeOriginal();
      } finally {
        signalCleanupCompleted();
      }
    };

    const brief = {
      businessType: "Fixture",
      websiteGoals: ["Test the gateway lifecycle"],
      targetAudience: ["Test runner"],
      requiredPages: [{ name: "Page", purpose: "Fixture", sections: [{ name: "Content", goal: "Exercise mutation dispatch" }] }],
      requiredFeatures: [],
      contentRequirements: [],
      designPreferences: [],
      assetRequirements: [],
      responsiveRequirements: [],
      openQuestions: [],
    };
    const planResponse = await client.callTool({
      name: "plan_website_workflow",
      arguments: {
        cms: "squarespace",
        website_id: fakeWebsite.id,
        brief,
        tasks: [{
          action: "add_text_block",
          page_id: "page-1",
          section_id: "section-1",
          text: "Isolated mutation fixture",
        }],
      },
    });
    assert.equal(planResponse.isError, undefined);
    const plan = (planResponse.structuredContent as { result: {
      workflowId: string;
      fingerprint: string;
      tasks: Array<{ id: string; action: string; approvalRequired: boolean }>;
    } }).result;
    assert.equal(plan.tasks[0]?.action, "add_text_block");
    assert.equal(plan.tasks[0]?.approvalRequired, true);
    const approvalResponse = await client.callTool({
      name: "approve_workflow_tasks",
      arguments: {
        workflow_id: plan.workflowId,
        plan_fingerprint: plan.fingerprint,
        task_ids: [plan.tasks[0]!.id],
      },
    });
    assert.equal(approvalResponse.isError, undefined);

    mutationCall = client.callTool({
      name: "execute_website_workflow",
      arguments: { workflow_id: plan.workflowId, max_tasks: 1 },
    });
    await requireSignal(mutationStarted, "the add_text_block mutation boundary");
    const deleteRequest = () => fetch(url, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${clientA.credential}`,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
      },
    });
    const firstDelete = deleteRequest();
    await requireSignal(deleteMarked, "session DELETE admission");
    assert.equal(entry.closing, true);
    assert.ok(entry.activeRequests >= 2);
    assert.equal(deleteTransportCalls, 0);
    assert.equal(gateway.sessionCount, 0);
    assert.equal(closeCount, 0);

    const rejected = await rawToolCall(url, clientA.credential, sessionId);
    assert.equal(rejected.status, 404);
    await rejected.text();
    assert.equal(closeCount, 0);

    const repeatedDelete = deleteRequest();
    releaseMutation();
    assert.ok(mutationCall);
    const mutationResponse = await mutationCall as { isError?: boolean };
    assert.equal(mutationResponse.isError, undefined);
    assert.equal(fakeEditor.state.inserted, true);
    assert.equal(fakeEditor.state.text, "Isolated mutation fixture");
    await requireSignal(deleteAdmitted, "DELETE transport admission after mutation completion");
    const [firstDeleteResponse, repeatedDeleteResponse] = await Promise.all([firstDelete, repeatedDelete]);
    assert.equal(firstDeleteResponse.status, 200);
    assert.equal(repeatedDeleteResponse.status, 200);
    await Promise.all([firstDeleteResponse.text(), repeatedDeleteResponse.text()]);
    await cleanupCompleted;
    assert.equal(gateway.sessionCount, 0);
    assert.equal(closeCount, 1);
  } finally {
    releaseMutation();
    await mutationCall?.catch(() => undefined);
    await client.close().catch(() => undefined);
    await gateway.close().catch(() => undefined);
  }
});

test("the authorization policy runs for initialization and every later session request", async () => {
  let authorizedRequests = 0;
  const security = new GatewaySecurity({
    allowedOrigins: [allowedOrigin],
    authorizeRequest: ({ request }) => {
      authorizedRequests += 1;
      return request.method !== "GET";
    },
  });
  const client = security.provisionClient({ id: "policy-client", scopes: ["mcp:connect"] });
  const { runtime } = runtimeFixture();
  const gateway = new StreamableHttpGateway({ runtime, security });
  const url = await gateway.start();
  try {
    const initialized = await rawInitialize(url, client.credential);
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.equal(initialized.status, 200);
    await initialized.text();
    assert.ok(sessionId);
    const rejected = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${client.credential}`,
        "mcp-session-id": sessionId,
      },
    });
    assert.equal(rejected.status, 403);
    assert.equal(authorizedRequests, 2);
  } finally {
    await gateway.close();
  }
});

test("request-size and session-count limits are enforced", async () => {
  const { runtime } = runtimeFixture();
  const { security, clientA } = securityFixture();
  const gateway = new StreamableHttpGateway({ runtime, security, maxRequestBytes: 512, maxSessions: 1 });
  const url = await gateway.start();
  try {
    const tooLarge = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${clientA.credential}`,
        "content-type": "application/json",
        "content-length": "1024",
      },
      body: " ".repeat(1024),
    });
    assert.equal(tooLarge.status, 413);

    const initialized = await rawInitialize(url, clientA.credential);
    assert.equal(initialized.status, 200);
    await initialized.text();
    const full = await rawInitialize(url, clientA.credential);
    assert.equal(full.status, 429);
    await full.text();
    assert.equal(gateway.sessionCount, 1);
  } finally {
    await gateway.close();
  }
});

test("idle cleanup removes abandoned sessions without shutting down the shared browser", async () => {
  let now = 10_000;
  const { runtime, closeCount } = runtimeFixture();
  const { security, clientA } = securityFixture();
  const gateway = new StreamableHttpGateway({
    runtime,
    security,
    idleSessionTimeoutMs: 1_000,
    now: () => now,
  });
  const url = await gateway.start();
  try {
    const initialized = await rawInitialize(url, clientA.credential);
    assert.equal(initialized.status, 200);
    await initialized.text();
    assert.equal(gateway.sessionCount, 1);
    now += 1_001;
    assert.equal(await gateway.sweepIdleSessions(), 1);
    assert.equal(gateway.sessionCount, 0);
    assert.equal(closeCount(), 0);
  } finally {
    await gateway.close();
  }
  assert.equal(closeCount(), 1);
});

test("concurrent browser tool calls from separate HTTP clients are serialized", async () => {
  let active = 0;
  let maxActive = 0;
  const { runtime, closeCount } = runtimeFixture({
    listWebsites: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return [];
    },
  });
  const { security, clientA: credentialA, clientB: credentialB } = securityFixture();
  const gateway = new StreamableHttpGateway({ runtime, security });
  const url = await gateway.start();
  const a = clientFor(url, credentialA.credential);
  const b = clientFor(url, credentialB.credential);
  try {
    await Promise.all([a.client.connect(a.transport), b.client.connect(b.transport)]);
    const [resultA, resultB] = await Promise.all([
      a.client.callTool({ name: "list_websites", arguments: {} }),
      b.client.callTool({ name: "list_websites", arguments: {} }),
    ]);
    assert.notEqual(resultA.isError, true);
    assert.notEqual(resultB.isError, true);
    assert.equal(maxActive, 1);
    assert.equal(closeCount(), 0);
  } finally {
    await Promise.all([a.client.close(), b.client.close()]);
    await gateway.close();
  }
  assert.equal(closeCount(), 1);
});

test("gateway shutdown closes all sessions and the shared browser exactly once", async () => {
  const { runtime, closeCount } = runtimeFixture();
  const { security, clientA } = securityFixture();
  const gateway = new StreamableHttpGateway({ runtime, security });
  const url = await gateway.start();
  const client = clientFor(url, clientA.credential);
  await client.client.connect(client.transport);
  assert.equal(gateway.sessionCount, 1);
  await Promise.all([gateway.close(), gateway.close()]);
  await client.client.close().catch(() => undefined);
  assert.equal(gateway.sessionCount, 0);
  assert.equal(closeCount(), 1);
});

test("graceful shutdown waits for an in-flight browser operation before closing the runtime", async () => {
  let signalStarted!: () => void;
  let releaseOperation!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const operationGate = new Promise<void>((resolve) => { releaseOperation = resolve; });
  const { runtime, closeCount } = runtimeFixture({
    listWebsites: async () => {
      signalStarted();
      await operationGate;
      return [];
    },
  });
  const { security, clientA } = securityFixture();
  const gateway = new StreamableHttpGateway({ runtime, security });
  const client = clientFor(await gateway.start(), clientA.credential);
  await client.client.connect(client.transport);
  const call = client.client.callTool({ name: "list_websites", arguments: {} }).catch(() => undefined);
  await started;
  let shutdownFinished = false;
  const shutdown = gateway.close().then(() => { shutdownFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(shutdownFinished, false);
  assert.equal(closeCount(), 0);
  releaseOperation();
  await Promise.all([shutdown, call]);
  await client.client.close().catch(() => undefined);
  assert.equal(shutdownFinished, true);
  assert.equal(closeCount(), 1);
});

test("global and per-session admission limits reject before additional work enters the browser queue", async () => {
  let startedCount = 0;
  let releaseFirst!: () => void;
  let signalFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
  const browser = {
    listWebsites: async () => {
      startedCount += 1;
      if (startedCount === 1) {
        signalFirst();
        await firstGate;
      }
      return [];
    },
    close: async () => undefined,
  } as unknown as SquarespaceBrowserService;
  const runtime = new SharedBrowserRuntime({ browser });
  const { security, clientA: aCredential, clientB: bCredential } = securityFixture();
  const gateway = new StreamableHttpGateway({
    runtime,
    security,
    maxActiveRequests: 2,
    maxActiveRequestsPerSession: 1,
  });
  const url = await gateway.start();
  try {
    const sessionA = await initializeSession(url, aCredential.credential);
    const sessionB = await initializeSession(url, bCredential.credential);
    const firstCall = rawToolCall(url, aCredential.credential, sessionA);
    await firstStarted;

    const sameSessionRejected = await rawToolCall(url, aCredential.credential, sessionA);
    assert.equal(sameSessionRejected.status, 429);
    await sameSessionRejected.text();

    const secondSessionCall = rawToolCall(url, bCredential.credential, sessionB);
    await waitFor(() => gateway.activeRequestCount === 2);
    const globalRejected = await rawToolCall(url, aCredential.credential, sessionA);
    assert.equal(globalRejected.status, 429);
    await globalRejected.text();

    releaseFirst();
    const [firstResponse, secondResponse] = await Promise.all([firstCall, secondSessionCall]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    await Promise.all([firstResponse.text(), secondResponse.text()]);
    await waitFor(() => gateway.activeRequestCount === 0);
    assert.equal(startedCount, 2);
  } finally {
    releaseFirst();
    await gateway.close();
  }
});

test("global request admission rejects before entering a saturated browser-operation queue", async () => {
  let browserCallCount = 0;
  let signalStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const browser = {
    listWebsites: async () => {
      browserCallCount += 1;
      signalStarted();
      await gate;
      return [];
    },
    close: async () => undefined,
  } as unknown as SquarespaceBrowserService;
  const runtime = new SharedBrowserRuntime({
    browser,
    operationLock: new BrowserOperationLock(30_000, 0),
  });
  const { security, clientA: credentialA, clientB: credentialB } = securityFixture();
  const gateway = new StreamableHttpGateway({ runtime, security, maxActiveRequests: 1 });
  const url = await gateway.start();
  const sessionA = await initializeSession(url, credentialA.credential);
  const sessionB = await initializeSession(url, credentialB.credential);
  const first = rawToolCall(url, credentialA.credential, sessionA);
  try {
    await started;
    const rejected = await rawToolCall(url, credentialB.credential, sessionB);
    assert.equal(rejected.status, 429);
    await rejected.text();
    assert.equal(browserCallCount, 1);
  } finally {
    releaseFirst();
    const firstResponse = await first;
    await firstResponse.text();
    await gateway.close();
  }
});

test("malformed, oversized chunked, timed-out, and aborted initialization bodies release capacity", async () => {
  const { runtime } = runtimeFixture();
  const { security, clientA } = securityFixture();
  const gateway = new StreamableHttpGateway({
    runtime,
    security,
    maxRequestBytes: 512,
    maxRequestBodyReceiveTimeoutMs: 100,
    gracefulDrainTimeoutMs: 100,
  });
  const url = await gateway.start();
  const target = new URL(url);
  const headers = {
    authorization: `Bearer ${clientA.credential}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  let stage = "malformed";
  try {
    const malformed = await fetch(url, { method: "POST", headers, body: "{" });
    assert.equal(malformed.status, 400);
    await malformed.text();

    stage = "chunked oversized";
    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      let responseReceived = false;
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers,
      }, (response) => {
        responseReceived = true;
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", () => { if (!responseReceived) resolve(0); });
      request.write("{" + " ".repeat(400));
      request.write(" ".repeat(200));
      request.end();
    });
    assert.equal(chunkedStatus, 413);
    await waitFor(() => gateway.activeRequestCount === 0);

    stage = "slow body";
    const slowStatus = await new Promise<number>((resolve, reject) => {
      let responseReceived = false;
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { ...headers, "content-length": "200" },
      }, (response) => {
        responseReceived = true;
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", () => { if (!responseReceived) resolve(0); });
      request.write("{");
    });
    assert.equal(slowStatus, 408);
    await waitFor(() => gateway.activeRequestCount === 0);

    stage = "aborted body";
    const aborted = new Promise<void>((resolve) => {
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { ...headers, "content-length": "200" },
      });
      request.once("error", () => undefined);
      request.once("close", resolve);
      request.write("{");
      setTimeout(() => request.destroy(), 10);
    });
    await aborted;
    await waitFor(() => gateway.activeRequestCount === 0);
    assert.equal(gateway.sessionCount, 0);

    const initialized = await initializeSession(url, clientA.credential);
    assert.ok(initialized);
  } catch (error) {
    throw new Error(`Failure during ${stage}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await gateway.close().catch(() => undefined);
  }
});

test("shutdown timeout preserves active browser ownership and can be retried safely", async () => {
  const { runtime, closeCount } = runtimeFixture();
  const { security } = securityFixture();
  const gateway = new StreamableHttpGateway({
    runtime,
    security,
    gracefulDrainTimeoutMs: 100,
  });
  await gateway.start();
  let releaseMutation!: () => void;
  const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
  let mutationActive = false;
  const mutation = runtime.operationLock.runExclusive(async () => {
    mutationActive = true;
    await mutationGate;
    mutationActive = false;
  });
  try {
    await waitFor(() => mutationActive);
    await assert.rejects(gateway.close(), (error: unknown) =>
      error instanceof GatewayShutdownTimeoutError && error.browserOperationPending,
    );
    assert.equal(closeCount(), 0);
    assert.equal(runtime.operationLock.isIdle, false);
  } finally {
    releaseMutation();
  }
  await mutation;
  await gateway.close();
  assert.equal(closeCount(), 1);
});
