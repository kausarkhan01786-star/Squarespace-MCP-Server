import { existsSync } from "node:fs";
import { readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
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
