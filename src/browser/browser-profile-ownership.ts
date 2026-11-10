import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SquarespaceBrowserError } from "./browser-errors.js";

const processOwners = new Set<string>();

/**
 * Acquire an exclusive sidecar lease for one persistent Chromium profile.
 * The lock is outside the profile so this code never reads or modifies its contents.
 * A stale lease is deliberately fail-closed and requires an operator to verify the
 * old owner is stopped before clearing the sidecar directory.
 */
export async function acquireBrowserProfileOwnership(
  profileDirectory: string,
): Promise<() => Promise<void>> {
  const canonicalProfile = await realpath(resolve(profileDirectory));
  const processKey = process.platform === "win32"
    ? canonicalProfile.toLocaleLowerCase("en-US")
    : canonicalProfile;
  const lockDirectory = `${canonicalProfile}.mcp-owner`;
  const ownerFile = `${lockDirectory}/owner.json`;
  const ownershipToken = randomUUID();

  if (processOwners.has(processKey)) {
    throw profileInUseError();
  }
  processOwners.add(processKey);

  let directoryCreated = false;
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
    directoryCreated = true;
    await writeFile(ownerFile, JSON.stringify({ pid: process.pid, token: ownershipToken }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    processOwners.delete(processKey);
    if (directoryCreated) {
      try {
        await rmdir(lockDirectory);
      } catch {
        // Leave an unexpected sidecar in place; a later owner must fail closed.
      }
    }
    if (isAlreadyExistsError(error)) {
      throw profileInUseError();
    }
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    processOwners.delete(processKey);
    try {
      const owner = JSON.parse(await readFile(ownerFile, "utf8")) as { token?: string };
      if (owner.token !== ownershipToken) return;
      await unlink(ownerFile);
      await rmdir(lockDirectory);
    } catch {
      // Never remove a sidecar that cannot be proven to belong to this owner.
    }
  };
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function profileInUseError(): SquarespaceBrowserError {
  return new SquarespaceBrowserError(
    "BROWSER_PROFILE_IN_USE",
    "The persistent browser profile is owned by another Squarespace MCP process or has an uncleared ownership marker. Stop the other owner before retrying; do not start a second browser against this profile.",
  );
}
