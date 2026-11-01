import assert from "node:assert/strict";
import test from "node:test";
import { validateLayout, validateResponsiveLayouts } from "./layout-validation.js";

const section = { x: 0, y: 0, width: 1200, height: 600 };

test("rejects two overlapping CTA buttons", () => {
  const result = validateLayout({
    surface: "desktop",
    section,
    elements: [
      { id: "primary-button", rect: { x: 80, y: 300, width: 220, height: 56 } },
      { id: "secondary-button", rect: { x: 80, y: 300, width: 220, height: 56 } },
    ],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /primary-button overlaps secondary-button on desktop/);
});

test("accepts separated buttons and checks both desktop and mobile layouts", () => {
  const result = validateResponsiveLayouts([
    {
      surface: "desktop",
      section,
      elements: [
        { id: "primary-button", rect: { x: 80, y: 300, width: 220, height: 56 } },
        { id: "secondary-button", rect: { x: 320, y: 300, width: 220, height: 56 } },
      ],
    },
    {
      surface: "mobile",
      section: { x: 0, y: 0, width: 390, height: 700 },
      elements: [
        { id: "primary-button", rect: { x: 24, y: 400, width: 342, height: 52 } },
        { id: "secondary-button", rect: { x: 24, y: 464, width: 342, height: 52 } },
      ],
    },
  ]);
  assert.deepEqual(result.map((surface) => surface.valid), [true, true]);
});

test("rejects elements that exceed section bounds", () => {
  const result = validateLayout({
    surface: "mobile",
    section: { x: 0, y: 0, width: 390, height: 700 },
    elements: [{ id: "heading", rect: { x: 24, y: 100, width: 400, height: 60 } }],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0]!, /outside the mobile section boundary/);
});
