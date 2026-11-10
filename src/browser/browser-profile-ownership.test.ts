import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireBrowserProfileOwnership } from "./browser-profile-ownership.js";

test("only one concurrent owner can hold a persistent profile lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "squarespace-profile-owner-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const profile = join(root, "persistent-profile");
  await mkdir(profile);
  const releaseFirst = await acquireBrowserProfileOwnership(profile);

  await assert.rejects(acquireBrowserProfileOwnership(profile), { code: "BROWSER_PROFILE_IN_USE" });
  await releaseFirst();

  const releaseSecond = await acquireBrowserProfileOwnership(profile);
  await releaseSecond();
});

test("a stale owner marker blocks launch instead of allowing a competing browser", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "squarespace-profile-stale-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const profile = join(root, "persistent-profile");
  await mkdir(profile);
  const marker = `${profile}.mcp-owner`;
  await mkdir(marker);
  await assert.rejects(acquireBrowserProfileOwnership(profile), { code: "BROWSER_PROFILE_IN_USE" });
});
