import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  InstanceOwnershipError,
  sanitizeIdentity,
  type InstanceOwnershipLease,
  type InstanceOwnershipProvider,
} from "./instance-ownership.types.js";

const require = createRequire(import.meta.url);

interface NativeOwnershipHandle {
  identity: string;
  pipeName: string;
  release(): boolean;
  isOwned(): boolean;
}

interface NativeOwnershipAddon {
  acquireOwnership(identity: string): NativeOwnershipHandle;
  isSupported(): boolean;
  getNativeInfo(): { platform: string; arch: string; nodeApiVersion: number };
}

let cachedAddon: NativeOwnershipAddon | undefined;

export function resolveNativeAddonPath(cwd = process.cwd()): string | undefined {
  const candidates = [
    resolve(cwd, "build", "Release", "instance_ownership.node"),
    resolve(cwd, "build", "Debug", "instance_ownership.node"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function loadNativeAddon(cwd = process.cwd()): NativeOwnershipAddon {
  if (cachedAddon) {
    return cachedAddon;
  }

  if (process.platform !== "win32") {
    throw new InstanceOwnershipError(
      "PLATFORM_NOT_SUPPORTED",
      `Native instance ownership is only supported on Windows (platform: ${process.platform}).`,
    );
  }

  if (process.arch !== "x64") {
    throw new InstanceOwnershipError(
      "ARCHITECTURE_NOT_SUPPORTED",
      `Native instance ownership requires x64 architecture (current: ${process.arch}).`,
    );
  }

  const addonPath = resolveNativeAddonPath(cwd);
  if (!addonPath) {
    throw new InstanceOwnershipError(
      "NATIVE_ADDON_NOT_BUILT",
      "Native instance ownership addon binary is not available. Build it using 'npm run build:native'.",
    );
  }

  try {
    cachedAddon = require(addonPath) as NativeOwnershipAddon;
    return cachedAddon;
  } catch (error) {
    throw new InstanceOwnershipError(
      "INSTANCE_OWNERSHIP_ACQUISITION_FAILED",
      "Failed to load native instance ownership addon.",
      { cause: error },
    );
  }
}

export class NativeWindowsInstanceOwnershipProvider implements InstanceOwnershipProvider {
  constructor(private readonly cwd = process.cwd()) {}

  async acquire(identity?: string): Promise<InstanceOwnershipLease> {
    const cleanIdentity = sanitizeIdentity(identity);
    const addon = loadNativeAddon(this.cwd);

    let nativeHandle: NativeOwnershipHandle;
    try {
      nativeHandle = addon.acquireOwnership(cleanIdentity);
    } catch (error: any) {
      if (error && typeof error === "object" && error.message) {
        if (
          error.message.includes("Another service instance is already running") ||
          error.code === "INSTANCE_ALREADY_RUNNING"
        ) {
          throw new InstanceOwnershipError(
            "INSTANCE_ALREADY_RUNNING",
            `Another service instance is already running with ownership identity: ${cleanIdentity}`,
            { cause: error },
          );
        }
      }
      throw new InstanceOwnershipError(
        "INSTANCE_OWNERSHIP_ACQUISITION_FAILED",
        error?.message || "Failed to acquire native Windows single-instance ownership lease.",
        { cause: error },
      );
    }

    let isReleased = false;

    return {
      identity: nativeHandle.identity,
      pipeName: nativeHandle.pipeName,
      isOwned(): boolean {
        return !isReleased && nativeHandle.isOwned();
      },
      async release(): Promise<boolean> {
        if (isReleased) {
          return false;
        }
        try {
          const result = nativeHandle.release();
          isReleased = true;
          return result;
        } catch (error) {
          throw new InstanceOwnershipError(
            "OWNERSHIP_RELEASE_FAILED",
            "Failed to release native instance ownership pipe handle.",
            { cause: error },
          );
        }
      },
    };
  }
}
