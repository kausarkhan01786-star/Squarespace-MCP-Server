import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHeroTools } from "./hero-tools.js";

const specification = {
  content: {
    eyebrow: "Developer",
    heading: "Digital experiences",
    description: "Modern websites for teams.",
    buttons: [
      { label: "Projects", variant: "primary" },
      { label: "Contact", variant: "secondary" },
    ],
    visual: { kind: "decorative", description: "Abstract color shape" },
  },
  styling: {
    backgroundColor: "#111111",
    textColor: "#FFFFFF",
    typography: {
      headingPreset: "Heading 1",
      bodyPreset: "Paragraph",
      alignment: "left",
    },
    spacing: { top: 80, bottom: 80, gap: 20 },
  },
  layout: {
    desktop: {
      section: { x: 0, y: 0, width: 1200, height: 600 },
      elementOrder: [
        "eyebrow",
        "heading",
        "description",
        "primary_button",
        "secondary_button",
        "visual",
      ],
      positions: {
        eyebrow: { x: 40, y: 40, width: 500, height: 20 },
        heading: { x: 40, y: 80, width: 500, height: 100 },
        description: { x: 40, y: 200, width: 500, height: 60 },
        primary_button: { x: 40, y: 300, width: 200, height: 50 },
        secondary_button: { x: 260, y: 300, width: 200, height: 50 },
        visual: { x: 700, y: 40, width: 400, height: 500 },
      },
    },
    mobile: {
      section: { x: 0, y: 0, width: 390, height: 900 },
      elementOrder: [
        "eyebrow",
        "heading",
        "description",
        "visual",
        "primary_button",
        "secondary_button",
      ],
      positions: {
        eyebrow: { x: 20, y: 20, width: 350, height: 20 },
        heading: { x: 20, y: 60, width: 350, height: 120 },
        description: { x: 20, y: 190, width: 350, height: 80 },
        visual: { x: 20, y: 300, width: 350, height: 240 },
        primary_button: { x: 20, y: 560, width: 350, height: 50 },
        secondary_button: { x: 20, y: 620, width: 350, height: 50 },
      },
    },
  },
};

test("registers a read-only Hero planner and returns a plan without editing a website", async () => {
  const server = new McpServer({ name: "hero-tools-test", version: "1.0.0" });
  const client = new Client({ name: "hero-tools-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerHeroTools(server);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "plan_squarespace_hero");
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, true);

    const result = await client.callTool({
      name: "plan_squarespace_hero",
      arguments: { specification },
    });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");
    assert.equal(payload.result.executionStarted, false);
    assert.equal(payload.result.saved, false);
    assert.equal(payload.result.published, false);
    assert.equal(payload.result.boundary, "Agent-controlled shared browser; no MCP browser bridge");
  } finally {
    await client.close();
    await server.close();
  }
});
