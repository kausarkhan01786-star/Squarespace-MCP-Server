import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as ProtocolMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkflowTools } from "./workflow-tools.js";
import { WebsiteWorkflowService } from "../workflow/website-workflow.service.js";
import type { WorkflowAdapter } from "../workflow/workflow-types.js";

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

test("registers the complete workflow MCP surface", () => {
  const registered: string[] = [];
  const server = {
    registerTool(name: string) {
      registered.push(name);
    },
  } as unknown as McpServer;
  const workflow = new WebsiteWorkflowService(new Map());
  registerWorkflowTools(server, workflow);

  assert.deepEqual(registered, [
    "analyze_client_requirements",
    "plan_website_workflow",
    "approve_workflow_tasks",
    "execute_website_workflow",
    "get_workflow_status",
    "get_workflow_qa_report",
    "list_workflow_adapters",
  ]);
});

test("serves workflow discovery and requirement analysis over MCP protocol", async () => {
  const adapter: WorkflowAdapter = {
    cms: "test-cms",
    getCapabilities: () => [{
      action: "inspect_pages",
      supported: true,
      toolName: "list_pages",
      readOnly: true,
      approvalRequired: false,
      retrySafe: true,
      limitation: null,
    }],
    async verifyWebsite(websiteId) {
      return { id: websiteId, name: "Test", url: "https://test.squarespace.com" };
    },
    async execute() {
      return {};
    },
  };
  const service = new WebsiteWorkflowService(new Map([[adapter.cms, adapter]]));
  const server = new ProtocolMcpServer({ name: "workflow-integration-test", version: "1.0.0" });
  const client = new Client({ name: "workflow-integration-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerWorkflowTools(server, service);

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "analyze_client_requirements"));
    assert.ok(listed.tools.some((tool) => tool.name === "plan_website_workflow"));
    assert.ok(listed.tools.some((tool) => tool.name === "execute_website_workflow"));

    const analysis = await client.callTool({
      name: "analyze_client_requirements",
      arguments: { brief },
    });
    assert.equal(analysis.isError, undefined);
    assert.match(analysis.content[0]?.type === "text" ? analysis.content[0].text : "", /requestedPageCount/);

    const adapters = await client.callTool({
      name: "list_workflow_adapters",
      arguments: {},
    });
    assert.equal(adapters.isError, undefined);
    assert.match(adapters.content[0]?.type === "text" ? adapters.content[0].text : "", /test-cms/);
  } finally {
    await client.close();
    await server.close();
  }
});
