import assert from "node:assert/strict";
import test from "node:test";
import {
  createSquarespaceHeroOperatorPlan,
  executeSquarespaceHeroPlan,
  type MeasuredSectionLayout,
  type SquarespaceOperatorDriver,
} from "./squarespace-operator-engine.js";

function specification() {
  return {
    content: {
      eyebrow: "WEB DEVELOPER & DIGITAL CREATOR",
      heading: "Turning Ideas Into Powerful Digital Experiences.",
      description: "I build modern responsive websites for businesses.",
      buttons: [
        { label: "View My Projects", destination: "/projects", variant: "primary" },
        { label: "Contact Me", destination: "/contact", variant: "secondary" },
      ],
      visual: { kind: "image", assetId: "portfolio-hero", description: "Portfolio workspace" },
    },
    styling: {
      backgroundColor: "#111111",
      textColor: "#FFFFFF",
      typography: { headingPreset: "Heading 1", bodyPreset: "Paragraph", alignment: "left" },
      spacing: { top: 96, bottom: 96, gap: 24 },
    },
    layout: {
      desktop: {
        section: { x: 0, y: 0, width: 1200, height: 700 },
        elementOrder: [
          "eyebrow", "heading", "description", "primary_button", "secondary_button", "visual",
        ],
        positions: {
          eyebrow: { x: 80, y: 100, width: 500, height: 24 },
          heading: { x: 80, y: 140, width: 550, height: 110 },
          description: { x: 80, y: 270, width: 550, height: 70 },
          primary_button: { x: 80, y: 370, width: 220, height: 56 },
          secondary_button: { x: 320, y: 370, width: 220, height: 56 },
          visual: { x: 700, y: 100, width: 420, height: 500 },
        },
      },
      mobile: {
        section: { x: 0, y: 0, width: 390, height: 900 },
        elementOrder: [
          "eyebrow", "heading", "description", "visual", "primary_button", "secondary_button",
        ],
        positions: {
          eyebrow: { x: 24, y: 48, width: 342, height: 20 },
          heading: { x: 24, y: 84, width: 342, height: 130 },
          description: { x: 24, y: 230, width: 342, height: 100 },
          primary_button: { x: 24, y: 650, width: 342, height: 52 },
          secondary_button: { x: 24, y: 714, width: 342, height: 52 },
          visual: { x: 24, y: 350, width: 342, height: 260 },
        },
      },
    },
  };
}

function plan(maxBrowserActions = 39) {
  return createSquarespaceHeroOperatorPlan({
    specification: specification(),
    section_id: "section-42",
    max_browser_actions: maxBrowserActions,
  });
}

function driverFor(
  planValue: ReturnType<typeof plan>,
  events: string[] = [],
  overrides: Partial<SquarespaceOperatorDriver> = {},
): SquarespaceOperatorDriver {
  const layout = (surface: "desktop" | "mobile"): MeasuredSectionLayout => ({
    section: planValue.specification.layout[surface].section,
    elements: planValue.blocks.map((block) => ({
      id: block.id,
      rect: planValue.specification.layout[surface].positions[block.id],
    })),
  });
  return {
    verifyTargetSection: async (sectionId) => {
      events.push(`verify:${sectionId}`);
      return { sectionId, empty: true };
    },
    insertTextBlock: async (sectionId, id) => {
      events.push(`insert-text:${sectionId}:${id}`);
      return { blockId: `native-${id}` };
    },
    setTextBlockContent: async (sectionId, blockId) => {
      events.push(`set-text:${sectionId}:${blockId}`);
    },
    insertButtonBlock: async (sectionId, id) => {
      events.push(`insert-button:${sectionId}:${id}`);
      return { blockId: `native-${id}` };
    },
    configureButtonBlock: async (sectionId, blockId) => {
      events.push(`configure-button:${sectionId}:${blockId}`);
    },
    insertImageBlock: async (sectionId, id) => {
      events.push(`insert-image:${sectionId}:${id}`);
      return { blockId: `native-${id}` };
    },
    selectImageAsset: async (sectionId, blockId) => {
      events.push(`select-image:${sectionId}:${blockId}`);
    },
    applySectionStyle: async (sectionId) => {
      events.push(`style:${sectionId}`);
    },
    placeResponsiveBlocks: async (sectionId, placements) => {
      assert.equal(sectionId, "section-42");
      assert.equal(placements.length, 6);
      events.push(`place:${sectionId}`);
    },
    inspectResponsiveLayout: async (sectionId, blockIds) => {
      assert.equal(sectionId, "section-42");
      assert.equal(blockIds.length, 6);
      events.push(`inspect:${sectionId}`);
      return { desktop: layout("desktop"), mobile: layout("mobile") };
    },
    ...overrides,
  };
}

test("creates a deterministic section-bound plan of native blocks below the action ceiling", () => {
  const first = plan();
  const second = plan();
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.estimatedBrowserActions, 16);
  assert.equal(first.maxBrowserActions, 39);
  assert.deepEqual(first.blocks.map(({ id, type, sectionId }) => [id, type, sectionId]), [
    ["eyebrow", "Text", "section-42"],
    ["heading", "Text", "section-42"],
    ["description", "Text", "section-42"],
    ["primary_button", "Button", "section-42"],
    ["secondary_button", "Button", "section-42"],
    ["visual", "Image", "section-42"],
  ]);
  assert.throws(
    () => createSquarespaceHeroOperatorPlan({
      specification: specification(),
      section_id: "section-42",
      max_browser_actions: 40,
    }),
    /<=39/,
  );
});

test("executes blocks in one ordered pass, scopes every action, and checks measured collisions once", async () => {
  const operatorPlan = plan();
  const events: string[] = [];
  let clock = 0;
  const report = await executeSquarespaceHeroPlan(
    operatorPlan,
    driverFor(operatorPlan, events),
    { now: () => (clock += 2) },
  );
  assert.equal(report.status, "succeeded");
  assert.equal(report.failureCode, null);
  assert.equal(report.collisionCheckCount, 1);
  assert.deepEqual(report.layoutErrors, []);
  assert.equal(report.executionMetrics.browserActionCount, 16);
  assert.deepEqual(
    Object.keys(report.executionMetrics.stageDurationsMs),
    ["website_verification", "block_creation", "style_application", "result_verification"],
  );
  assert.ok(Object.values(report.executionMetrics.stageDurationsMs)
    .every((duration) => duration !== undefined && duration > 0));
  assert.deepEqual(report.actions.map(({ action }) => action), [
    "verify_target_section",
    "insert_text_block:eyebrow",
    "set_text_content:eyebrow",
    "insert_text_block:heading",
    "set_text_content:heading",
    "insert_text_block:description",
    "set_text_content:description",
    "insert_button_block:primary_button",
    "configure_button:primary_button",
    "insert_button_block:secondary_button",
    "configure_button:secondary_button",
    "insert_image_block:visual",
    "select_image_asset:visual",
    "apply_section_style",
    "place_responsive_blocks",
    "inspect_placed_layout_once",
  ]);
  assert.ok(report.actions.every(({ sectionId, durationMs }) =>
    sectionId === "section-42" && durationMs === 2));
  assert.equal(events.at(-1), "inspect:section-42");
  assert.equal(report.saved, false);
  assert.equal(report.published, false);
});

test("stops before an action would exceed the configured budget", async () => {
  const operatorPlan = plan(3);
  const events: string[] = [];
  const report = await executeSquarespaceHeroPlan(
    operatorPlan,
    driverFor(operatorPlan, events),
  );
  assert.equal(report.status, "action_budget_exceeded");
  assert.equal(report.failureCode, "action_budget_exceeded");
  assert.equal(report.executionMetrics.browserActionCount, 3);
  assert.equal(report.actions.length, 3);
  assert.equal(report.collisionCheckCount, 0);
  assert.equal(events.length, 3);
});

test("reports collisions from the single post-placement measurement", async () => {
  const operatorPlan = plan();
  const report = await executeSquarespaceHeroPlan(
    operatorPlan,
    driverFor(operatorPlan, [], {
      inspectResponsiveLayout: async () => ({
        desktop: {
          section: operatorPlan.specification.layout.desktop.section,
          elements: operatorPlan.blocks.map((block) => ({
            id: block.id,
            rect: block.id === "secondary_button"
              ? operatorPlan.specification.layout.desktop.positions.primary_button
              : operatorPlan.specification.layout.desktop.positions[block.id],
          })),
        },
        mobile: {
          section: operatorPlan.specification.layout.mobile.section,
          elements: operatorPlan.blocks.map((block) => ({
            id: block.id,
            rect: operatorPlan.specification.layout.mobile.positions[block.id],
          })),
        },
      }),
    }),
  );
  assert.equal(report.status, "collision_detected");
  assert.equal(report.collisionCheckCount, 1);
  assert.ok(report.layoutErrors.some((error) =>
    error.includes("primary_button overlaps secondary_button on desktop")));
});

test("does not retry a failed native block action", async () => {
  const operatorPlan = plan();
  let textAttempts = 0;
  const report = await executeSquarespaceHeroPlan(
    operatorPlan,
    driverFor(operatorPlan, [], {
      insertTextBlock: async () => {
        textAttempts += 1;
        throw new Error("adapter details are not returned in the report");
      },
    }),
  );
  assert.equal(textAttempts, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.failureCode, "operator_action_failed");
  assert.equal(report.actions.length, 2);
  assert.equal(report.collisionCheckCount, 0);
});

test("halts when the inspected section ID does not match the plan", async () => {
  const operatorPlan = plan();
  const events: string[] = [];
  const report = await executeSquarespaceHeroPlan(
    operatorPlan,
    driverFor(operatorPlan, events, {
      verifyTargetSection: async () => {
        events.push("verify:wrong-section");
        return { sectionId: "section-other", empty: true };
      },
    }),
  );
  assert.equal(report.status, "failed");
  assert.equal(report.failureCode, "target_section_mismatch");
  assert.equal(report.executionMetrics.browserActionCount, 1);
  assert.equal(report.createdBlocks.length, 0);
  assert.deepEqual(events, ["verify:wrong-section"]);
});

test("rejects a modified plan before making browser actions", async () => {
  const operatorPlan = plan();
  operatorPlan.blocks[0]!.sectionId = "section-other";
  let actionCalled = false;
  const driver = driverFor(operatorPlan, [], {
    verifyTargetSection: async () => {
      actionCalled = true;
      return { sectionId: "section-42", empty: true };
    },
  });
  await assert.rejects(
    executeSquarespaceHeroPlan(operatorPlan, driver),
    /invalid or has changed/,
  );
  assert.equal(actionCalled, false);
});
