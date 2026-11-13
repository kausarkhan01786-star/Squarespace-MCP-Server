import { existsSync } from "node:fs";
import { readFile, unlink, writeFile, mkdir, realpath, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";
import { SquarespaceBrowserError } from "./browser-errors.js";

export const PROFILE_OWNERSHIP_MARKER_FILE = "browser-profile.owner.json";

export interface BrowserProfileMarkerData {
  pid: number;
  acquiredAt: string;
  host: string;
}

export class BrowserProfileOwnership {
  static getMarkerPath(profileDirectory: string): string {
    return join(profileDirectory, PROFILE_OWNERSHIP_MARKER_FILE);
  }

  static async hasMarker(profileDirectory: string): Promise<boolean> {
    const markerPath = BrowserProfileOwnership.getMarkerPath(profileDirectory);
    return existsSync(markerPath);
  }

  static async assertProfileAvailable(profileDirectory: string): Promise<void> {
    const markerPath = BrowserProfileOwnership.getMarkerPath(profileDirectory);
    if (existsSync(markerPath)) {
      let markerContent: string | undefined;
      try {
        markerContent = await readFile(markerPath, "utf8");
      } catch {
        // preserve marker even if unreadable
      }

      // Preserve the existing separate browser-profile ownership mechanism.
      // Do not delete or bypass its marker after a crash.
      throw new SquarespaceBrowserError(
        "BROWSER_LAUNCH_FAILED",
        "Could not launch visible Chromium with the persistent profile. If another browser is using this profile, close it before retrying. Do not delete the profile to recover a session.",
      );
    }
  }

  static async writeMarker(profileDirectory: string): Promise<void> {
    await BrowserProfileOwnership.assertProfileAvailable(profileDirectory);
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    const markerPath = BrowserProfileOwnership.getMarkerPath(profileDirectory);
    const data: BrowserProfileMarkerData = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      host: process.env.COMPUTERNAME || "localhost",
    };
    await writeFile(markerPath, JSON.stringify(data, null, 2), "utf8");
  }

  static async removeMarker(profileDirectory: string): Promise<void> {
    const markerPath = BrowserProfileOwnership.getMarkerPath(profileDirectory);
    if (existsSync(markerPath)) {
      await unlink(markerPath);
    }
  }
}

import { randomUUID } from "node:crypto";

const processOwners = new Set<string>();

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
