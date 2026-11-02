import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import { SettingsExecutionService } from "../execution/settings-execution-service.js";
import { SettingsChangePlanner } from "../planning/settings-change-planner.js";
import { registerSettingsExecutionTools } from "./settings-execution-tools.js";

test("exposes only read-only settings execution status while no provider is verified", async () => {
  const server = new McpServer({ name: "settings-execution-test", version: "1.0.0" });
  const client = new Client({ name: "settings-execution-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const service = new SettingsExecutionService({
    planner: new SettingsChangePlanner(new Map()),
    providers: new Map(),
  });
  registerSettingsExecutionTools(server, service, new BrowserOperationLock());

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["get_settings_execution_status"],
    );
    assert.equal(listed.tools[0]?.annotations?.readOnlyHint, true);
    assert.equal(listed.tools[0]?.annotations?.destructiveHint, false);

    const response = await client.callTool({
      name: "get_settings_execution_status",
      arguments: { cms_provider: "squarespace" },
    });
    assert.equal(response.isError, undefined);
    const status = response.structuredContent?.result as {
      executionProviderConfigured: boolean;
      mutationToolExposed: boolean;
      capabilities: Array<{
        capabilityId: string;
        updateStatus: string | null;
        executable: boolean;
      }>;
    };
    assert.equal(status.executionProviderConfigured, false);
    assert.equal(status.mutationToolExposed, false);
    assert.ok(status.capabilities.some((capability) =>
      capability.capabilityId === "settings.website" &&
      capability.updateStatus === "NOT_IMPLEMENTED" &&
      capability.executable === false));
  } finally {
    await client.close();
    await server.close();
  }
});
