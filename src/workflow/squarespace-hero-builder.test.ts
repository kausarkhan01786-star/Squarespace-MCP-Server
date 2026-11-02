import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  inspectHeroDuplicates,
  planSquarespaceHero,
  recordHeroOperation,
  SquarespaceHeroExecutionSession,
} from "./squarespace-hero-builder.js";
import { heroSpecificationSchema } from "./hero-specification.js";

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
      visual: {
        kind: "image",
        assetId: "portfolio-hero",
        description: "Portfolio workspace image",
      },
    },
    styling: {
      backgroundColor: "#111111",
      textColor: "#FFFFFF",
      typography: {
        headingPreset: "Heading 1",
        bodyPreset: "Paragraph",
        alignment: "left",
      },
      spacing: { top: 96, bottom: 96, gap: 24 },
    },
    layout: {
      desktop: {
        section: { x: 0, y: 0, width: 1200, height: 700 },
        elementOrder: [
          "eyebrow",
          "heading",
          "description",
          "primary_button",
          "secondary_button",
          "visual",
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
          "eyebrow",
          "heading",
          "description",
          "visual",
          "primary_button",
          "secondary_button",
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

test("validates ordered content, distinct buttons, and desktop/mobile element positions", () => {
  assert.equal(heroSpecificationSchema.parse(specification()).content.buttons.length, 2);
  const invalid = specification();
  invalid.layout.desktop.positions.secondary_button = {
    ...invalid.layout.desktop.positions.primary_button,
  };
  assert.doesNotThrow(() => heroSpecificationSchema.parse(invalid));
});

test("rejects incorrect element order, duplicate button labels, and missing visual assets", () => {
  const wrongOrder = specification();
  wrongOrder.layout.mobile.elementOrder.reverse();
  assert.throws(() => heroSpecificationSchema.parse(wrongOrder), z.ZodError);

  const sameLabels = specification();
  sameLabels.content.buttons[1].label = sameLabels.content.buttons[0].label;
  assert.throws(() => heroSpecificationSchema.parse(sameLabels), z.ZodError);

  const noAsset = specification();
  delete noAsset.content.visual.assetId;
  assert.throws(() => heroSpecificationSchema.parse(noAsset), z.ZodError);

  const unsafeDestination = specification();
  unsafeDestination.content.buttons[0].destination = "javascript:alert(1)";
  assert.throws(() => heroSpecificationSchema.parse(unsafeDestination), z.ZodError);
});

test("plans observed editor primitives separately from unsupported hero operations", () => {
  const plan = planSquarespaceHero({
    specification: specification(),
    deadline_ms: 120_000,
    max_browser_actions: 42,
  });
  assert.equal(plan.executionStarted, false);
  assert.equal(plan.saved, false);
  assert.equal(plan.published, false);
  assert.equal(plan.deadlineMs, 120_000);
  assert.equal(plan.maxBrowserActions, 42);
  assert.equal(plan.executionMetrics, null);
  assert.deepEqual(
    plan.operations.filter((operation) => operation.readiness === "observed_once")
      .map((operation) => operation.id),
    [
      "create_section",
      "add_eyebrow",
      "add_heading",
      "add_description",
      "add_primary_button",
      "add_secondary_button",
    ],
  );
  assert.equal(plan.operations.find((operation) => operation.id === "add_visual")?.status, "unsupported");
  assert.equal(plan.operations.find((operation) => operation.id === "position_elements")?.status, "unsupported");
  assert.equal(plan.stages.find((stage) => stage.id === "layout")?.status, "unsupported");
});

test("prevents duplicate content from being scheduled and refuses unsupported execution", () => {
  const plan = planSquarespaceHero({ specification: specification() });
  const duplicates = inspectHeroDuplicates(plan.specification, {
    sectionExists: true,
    elements: [{ elementId: "primary_button", text: "  VIEW MY PROJECTS " }],
  });
  assert.deepEqual(duplicates, ["primary_button"]);
  const session = new SquarespaceHeroExecutionSession(plan);
  assert.deepEqual(session.preventDuplicates({
    sectionExists: true,
    elements: [{ elementId: "primary_button", text: "View My Projects" }],
  }), ["primary_button"]);
  assert.equal(plan.operations.find((operation) => operation.id === "add_primary_button")?.status, "blocked_duplicate");
  assert.throws(
    () => recordHeroOperation(plan, "add_visual", { executed: true }),
    /Unsupported Hero operations/,
  );
  assert.throws(
    () => session.recordOperation("add_heading", {
      visuallyVerified: true,
      evidence: "agent://evidence",
    }),
    /must be executed/,
  );
});

test("records execution and visual verification distinctly, requiring evidence", () => {
  const plan = planSquarespaceHero({ specification: specification() });
  recordHeroOperation(plan, "create_section", { executed: true });
  assert.equal(plan.operations.find((operation) => operation.id === "create_section")?.status, "executed");
  assert.throws(
    () => recordHeroOperation(plan, "create_section", { executed: true }),
    /Only a planned Hero operation/,
  );

  recordHeroOperation(plan, "add_heading", { executed: true });
  assert.equal(plan.operations.find((operation) => operation.id === "add_heading")?.status, "executed");
  assert.throws(
    () => recordHeroOperation(plan, "add_description", {
      executed: true,
      visuallyVerified: true,
    }),
    /requires a sanitized evidence reference/,
  );
  recordHeroOperation(plan, "add_description", {
    executed: true,
    visuallyVerified: true,
    evidence: "agent-evidence:hero-description",
  });
  assert.equal(
    plan.operations.find((operation) => operation.id === "add_description")?.status,
    "visually_verified",
  );
  assert.throws(
    () => recordHeroOperation(plan, "add_eyebrow", {
      executed: true,
      visuallyVerified: true,
    }),
    /requires a sanitized evidence reference/,
  );
  assert.throws(
    () => recordHeroOperation(plan, "add_eyebrow", {
      executed: true,
      visuallyVerified: true,
      evidence: "https://private.example/screenshot.png",
    }),
    /sanitized, non-path reference/,
  );
});

test("hero execution session enforces a deadline and cancellation between actions", () => {
  const plan = planSquarespaceHero({ specification: specification(), deadline_ms: 1_000 });
  let now = 0;
  const deadlineSession = new SquarespaceHeroExecutionSession(plan, { now: () => now });
  deadlineSession.beforeSharedBrowserAction();
  now = 1_000;
  assert.throws(() => deadlineSession.beforeSharedBrowserAction(), { reason: "timed_out" });
  assert.equal(deadlineSession.finish("timed_out").browserActionCount, 1);

  const cancellation = new AbortController();
  const cancelled = new SquarespaceHeroExecutionSession(plan, { signal: cancellation.signal });
  cancellation.abort();
  assert.throws(() => cancelled.checkpoint(), { reason: "cancelled" });
  assert.equal(cancelled.finish("cancelled").status, "cancelled");
});
