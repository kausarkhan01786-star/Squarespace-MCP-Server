import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readJson(url: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function versionTuple(version: string): number[] {
  return version.split(".").map((part) => Number(part));
}

function compareVersions(left: string, right: string): number {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

test("declared and locked MCP SDK minimum matches the audited Streamable HTTP API version", () => {
  const manifest = readJson(new URL("../../package.json", import.meta.url));
  const lock = readJson(new URL("../../package-lock.json", import.meta.url));
  const installed = readJson(new URL("../../node_modules/@modelcontextprotocol/sdk/package.json", import.meta.url));
  const rootPackages = lock.packages as Record<string, { dependencies?: Record<string, string> }>;
  const lockPackages = lock.packages as Record<string, { version?: string }>;
  const declaredRange = (manifest.dependencies as Record<string, string>)["@modelcontextprotocol/sdk"];
  const lockedRange = rootPackages[""]?.dependencies?.["@modelcontextprotocol/sdk"];
  const lockedVersion = lockPackages["node_modules/@modelcontextprotocol/sdk"]?.version;
  const installedVersion = installed.version as string;

  assert.equal(declaredRange, "^1.32.2");
  assert.equal(lockedRange, declaredRange);
  assert.equal(lockedVersion, "1.32.2");
  assert.equal(installedVersion, lockedVersion);
  assert.ok(compareVersions(lockedVersion, "1.32.2") >= 0);
});
