import assert from "node:assert/strict";
import test from "node:test";
import { SquarespaceBrowserError } from "../browser/browser-errors.js";
import { runTool } from "./tool-helpers.js";

test("preserves safe domain errors but redacts unexpected error messages", async () => {
  const expectedError = await runTool("known-error", async () => {
    throw new SquarespaceBrowserError("PAGE_NOT_FOUND", "The page was not found.");
  });
  assert.equal(expectedError.isError, true);
  assert.match(expectedError.content[0]!.text, /PAGE_NOT_FOUND/);
  assert.match(expectedError.content[0]!.text, /The page was not found/);

  const unexpectedError = await runTool("unexpected-error", async () => {
    throw new Error("Authorization: Bearer secret-value");
  });
  assert.equal(unexpectedError.isError, true);
  assert.doesNotMatch(unexpectedError.content[0]!.text, /secret-value|Bearer/);
  assert.match(unexpectedError.content[0]!.text, /UNEXPECTED_ERROR/);
});
