import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import { SquarespaceBrowserService } from "../browser/squarespace-browser.service.js";
import { createMcpClientSession } from "./mcp-client-session.js";
import { SharedBrowserRuntime } from "./shared-browser-runtime.js";

test("two independent MCP sessions share one runtime and isolate session state", async () => {
  let browserCloseCount = 0;
  const browser = {
    close: async () => { browserCloseCount += 1; },
  } as unknown as SquarespaceBrowserService;
  const runtime = new SharedBrowserRuntime({ browser, operationLock: new BrowserOperationLock() });
  const [transportA, serverTransportA] = InMemoryTransport.createLinkedPair();
  const [transportB, serverTransportB] = InMemoryTransport.createLinkedPair();
  // Replace the unused constructor transports with the linked pairs used by the clients.
  const connectedA = createMcpClientSession(runtime, serverTransportA, { serverName: "session-a" });
  const connectedB = createMcpClientSession(runtime, serverTransportB, { serverName: "session-b" });
  const clientA = new Client({ name: "client-a", version: "1.0.0" });
  const clientB = new Client({ name: "client-b", version: "1.0.0" });

  try {
    await connectedA.server.connect(serverTransportA);
    await connectedB.server.connect(serverTransportB);
    await clientA.connect(transportA);
    await clientB.connect(transportB);

    assert.notEqual(connectedA.server, connectedB.server);
    assert.notEqual(connectedA.mutationApproval, connectedB.mutationApproval);
    assert.notEqual(connectedA.workflow, connectedB.workflow);
    assert.equal(connectedA.runtime, runtime);
    assert.equal(connectedB.runtime, runtime);
    assert.equal(connectedA.browserOperationLock, runtime.operationLock);
    assert.equal(connectedB.browserOperationLock, runtime.operationLock);

    const [toolsA, toolsB] = await Promise.all([clientA.listTools(), clientB.listTools()]);
    assert.deepEqual(toolsA.tools.map((tool) => tool.name), toolsB.tools.map((tool) => tool.name));
    assert.ok(toolsA.tools.some((tool) => tool.name === "list_websites"));
    assert.ok(toolsA.tools.some((tool) => tool.name === "add_text_section"));

    await clientA.close();
    await connectedA.close();
    assert.equal(browserCloseCount, 0);

    const capabilities = await clientB.callTool({ name: "get_commerce_capabilities", arguments: {} });
    assert.notEqual(capabilities.isError, true);
    await clientB.close();
    await connectedB.close();
    assert.equal(browserCloseCount, 0);

    await runtime.shutdown();
    await runtime.shutdown();
    assert.equal(browserCloseCount, 1);
  } finally {
    await clientA.close().catch(() => undefined);
    await clientB.close().catch(() => undefined);
    await connectedA.close().catch(() => undefined);
    await connectedB.close().catch(() => undefined);
    await runtime.shutdown();
  }
});

test("the process-shared operation lock serializes browser transactions across sessions", async () => {
  const runtime = new SharedBrowserRuntime({
    browser: { close: async () => undefined } as unknown as SquarespaceBrowserService,
  });
  const sessionA = createMcpClientSession(runtime, InMemoryTransport.createLinkedPair()[1]);
  const sessionB = createMcpClientSession(runtime, InMemoryTransport.createLinkedPair()[1]);
  let active = 0;
  let maximumActive = 0;
  const run = (session: typeof sessionA) => session.browserOperationLock.runExclusive(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  try {
    await Promise.all([run(sessionA), run(sessionB)]);
    assert.equal(maximumActive, 1);
  } finally {
    await sessionA.close();
    await sessionB.close();
    await runtime.shutdown();
  }
});

test("closing one client session leaves another connected session usable", async () => {
  let browserCloseCount = 0;
  const runtime = new SharedBrowserRuntime({
    browser: {
      close: async () => { browserCloseCount += 1; },
    } as unknown as SquarespaceBrowserService,
  });
  const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
  const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
  const sessionA = createMcpClientSession(runtime, serverTransportA);
  const sessionB = createMcpClientSession(runtime, serverTransportB);
  const clientA = new Client({ name: "surviving-client", version: "1.0.0" });
  const clientB = new Client({ name: "closing-client", version: "1.0.0" });
  try {
    await sessionA.server.connect(serverTransportA);
    await sessionB.server.connect(serverTransportB);
    await clientA.connect(clientTransportA);
    await clientB.connect(clientTransportB);
    await clientB.close();
    await sessionB.close();
    const response = await clientA.callTool({ name: "get_commerce_capabilities", arguments: {} });
    assert.notEqual(response.isError, true);
    assert.equal(browserCloseCount, 0);
  } finally {
    await clientA.close().catch(() => undefined);
    await clientB.close().catch(() => undefined);
    await sessionA.close().catch(() => undefined);
    await sessionB.close().catch(() => undefined);
    await runtime.shutdown();
  }
});

test("runtime shutdown does not require a browser context to have been created", async () => {
  let closeCount = 0;
  const browser = {
    close: async () => { closeCount += 1; },
  } as unknown as SquarespaceBrowserService;
  const runtime = new SharedBrowserRuntime({ browser });
  await Promise.all([runtime.shutdown(), runtime.shutdown()]);
  assert.equal(closeCount, 1);
});
