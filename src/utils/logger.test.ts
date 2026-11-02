import assert from "node:assert/strict";
import test from "node:test";
import { logError, logInfo } from "./logger.js";

test("writes sanitized application diagnostics to stderr and leaves stdout untouched", () => {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;

  try {
    logInfo("safe_operation", {
      operation: "inspect_page",
      resultCount: 2,
      apiKey: "private-api-key",
      customerEmail: "private@example.com",
      text: "private page content",
    });
    logError(
      "safe_failure",
      Object.assign(new Error("private message containing a password"), {
        code: "SAFE_FAILURE",
      }),
      { toolName: "list_pages", url: "https://example.test/private" },
    );
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  assert.deepEqual(stdoutChunks, []);
  assert.equal(stderrChunks.length, 2);
  const records = stderrChunks.map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
  assert.deepEqual(records[0], {
    level: "info",
    event: "safe_operation",
    operation: "inspect_page",
    resultCount: 2,
  });
  assert.deepEqual(records[1], {
    level: "error",
    event: "safe_failure",
    toolName: "list_pages",
    error: { name: "Error", code: "SAFE_FAILURE" },
  });
  assert.equal(stderrChunks.join("").includes("private"), false);
  assert.equal(stderrChunks.join("").includes("password"), false);
});
