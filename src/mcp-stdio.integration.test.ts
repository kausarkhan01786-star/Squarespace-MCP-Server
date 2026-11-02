import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server supports stdio handshake, tool discovery, and a local read-only call", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      resolve(process.cwd(), "src", "index.ts"),
    ],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-integration-test", version: "1.0.0" });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    diagnostics += chunk.toString();
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "get_commerce_capabilities"));
    assert.ok(tools.some((tool) => tool.name === "get_workflow_status"));

    const failure = await client.callTool({
      name: "get_workflow_status",
      arguments: { workflow_id: "00000000-0000-4000-8000-000000000000" },
    });
    assert.equal(failure.isError, true);
    assert.ok(diagnostics.includes('"event":"mcp_tool_failed"'));
    assert.ok(diagnostics.includes('"code":"WORKFLOW_NOT_FOUND"'));

    const result = await client.callTool({
      name: "get_commerce_capabilities",
      arguments: {},
    });
    assert.notEqual(result.isError, true);
    assert.ok(Array.isArray(result.content));
    assert.ok(result.content.some((item) => item.type === "text"));
  } finally {
    await client.close();
  }
});
