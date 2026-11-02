import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import { SettingsChangePlanner } from "../planning/settings-change-planner.js";
import { registerSettingsChangePlanningTools } from "./settings-change-planning-tools.js";

test("registers only dry-run planning tools with read-only annotations", async () => {
  let inspectionCalls = 0;
  let mutationCalls = 0;
  const provider = {
    cms: "squarespace" as const,
    async listSites() {
      return [{ id: "site-1", name: "Fixture site" }];
    },
    async inspectCategory() {
      inspectionCalls += 1;
      return {
        status: "PARTIALLY_AVAILABLE" as const,
        fields: [{
          fieldId: "timezone",
          fieldLabel: "Time Zone",
          currentValue: "America/New_York",
          valueType: "string" as const,
          valueStatus: "AVAILABLE" as const,
          source: "fixture_settings_ui",
          inspectionConfidence: 0.98,
          isSensitive: false,
          limitations: [],
        }],
        source: "fixture_settings_ui",
        limitations: [],
        errors: [],
      };
    },
    capabilityIdForCategory(categoryId: string) {
      return categoryId === "website" ? "settings.website" : undefined;
    },
  };
  const planner = new SettingsChangePlanner(
    new Map([["squarespace", provider]]),
  );
  const server = new McpServer({ name: "settings-planner-test", version: "1.0.0" });
  const client = new Client({ name: "settings-planner-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerSettingsChangePlanningTools(
    server,
    planner,
    new BrowserOperationLock(),
  );

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "analyze_settings_change_request",
        "get_settings_change_plan",
        "preview_settings_changes",
      ],
    );
    assert.ok(listed.tools.every((tool) =>
      tool.annotations?.readOnlyHint === true &&
      tool.annotations.destructiveHint === false));
    assert.equal(
      listed.tools.some((tool) =>
        /^(save|publish|update|delete|create|execute)_/i.test(tool.name)),
      false,
    );

    const analyzed = await client.callTool({
      name: "analyze_settings_change_request",
      arguments: {
        instruction: "Change my website timezone to Dhaka.",
        cms_provider: "squarespace",
        site_id: "site-1",
      },
    });
    assert.equal(analyzed.isError, undefined);
    const parsedPlan = analyzed.structuredContent?.result as {
      planId: string;
      executionEnabled: false;
      status: string;
    };
    assert.equal(parsedPlan.executionEnabled, false);
    assert.equal(parsedPlan.status, "BLOCKED");
    assert.equal(inspectionCalls, 1);

    const retrieved = await client.callTool({
      name: "get_settings_change_plan",
      arguments: { plan_id: parsedPlan.planId },
    });
    assert.equal(retrieved.isError, undefined);
    assert.equal(
      (retrieved.structuredContent?.result as { planId: string }).planId,
      parsedPlan.planId,
    );

    const preview = await client.callTool({
      name: "preview_settings_changes",
      arguments: {
        original_instruction: "Set Time Zone to Dhaka.",
        cms_provider: "squarespace",
        site_id: "site-1",
        changes: [{
          category_id: "website",
          field_label: "Time Zone",
          proposed_value: "Dhaka",
          value_type: "string",
        }],
      },
    });
    assert.equal(preview.isError, undefined);
    assert.equal(
      (preview.structuredContent?.result as { executionEnabled: boolean }).executionEnabled,
      false,
    );
    assert.equal(inspectionCalls, 2);
    assert.equal(mutationCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("structured tool validation rejects malformed change types before inspection", async () => {
  let inspectionCalls = 0;
  const provider = {
    cms: "squarespace" as const,
    async listSites() {
      return [{ id: "site-1", name: "Fixture site" }];
    },
    async inspectCategory() {
      inspectionCalls += 1;
      return {
        status: "UNKNOWN" as const,
        fields: [],
        source: "fixture",
        limitations: [],
        errors: [],
      };
    },
    capabilityIdForCategory() {
      return undefined;
    },
  };
  const server = new McpServer({ name: "settings-planner-validation", version: "1.0.0" });
  const client = new Client({ name: "settings-planner-validation-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerSettingsChangePlanningTools(
    server,
    new SettingsChangePlanner(new Map([["squarespace", provider]])),
    new BrowserOperationLock(),
  );
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "preview_settings_changes",
      arguments: {
        original_instruction: "Malformed preview",
        cms_provider: "squarespace",
        site_id: "site-1",
        changes: [{
          category_id: "website",
          field_label: "Time Zone",
          proposed_value: "not a boolean",
          value_type: "booleanish",
        }],
      },
    });
    assert.equal(result.isError, true);
    assert.equal(inspectionCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
