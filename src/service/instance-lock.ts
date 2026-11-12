import { createRequire } from "node:module";
import { isMainThread } from "node:worker_threads";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type InstanceLockErrorCode =
  | "INSTANCE_ALREADY_RUNNING"
  | "INSTANCE_LOCK_UNSUPPORTED"
  | "INSTANCE_LOCK_NATIVE_UNAVAILABLE"
  | "INSTANCE_LOCK_RELEASE_FAILED"
  | "INSTANCE_LOCK_ACQUIRE_FAILED"
  | "INSTANCE_LOCK_RELEASED";

export class InstanceLockError extends Error {
  constructor(readonly code: InstanceLockErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InstanceLockError";
  }
}

export interface NativeInstanceLock {
  acquire(): void;
  release(): void;
  isHeld(): boolean;
}

export interface InstanceLockCoordinator {
  acquire(): Promise<void>;
  release(): Promise<void>;
  isHeld(): boolean;
}

type NativeAddon = NativeInstanceLock;

/** Owns one Windows named-pipe lease. The production addon exposes only the fixed app/user identity. */
export class InstanceLock implements InstanceLockCoordinator {
  private state: "new" | "held" | "released" = "new";
  private acquisition: Promise<void> | undefined;
  private releaseOperation: Promise<void> | undefined;

  constructor(private readonly native: NativeInstanceLock = loadNativeAddon()) {}

  acquire(): Promise<void> {
    if (this.state === "held") return Promise.resolve();
    if (this.state === "released") {
      return Promise.reject(new InstanceLockError(
        "INSTANCE_LOCK_RELEASED",
        "This service coordinator has already released its ownership lease.",
      ));
    }
    if (!this.acquisition) {
      this.acquisition = Promise.resolve().then(() => {
        try {
          this.native.acquire();
          this.state = "held";
        } catch (error) {
          this.acquisition = undefined;
          throw normalizeAcquireError(error);
        }
      });
    }
    return this.acquisition;
  }

  release(): Promise<void> {
    if (this.state === "new" || this.state === "released") return Promise.resolve();
    if (!this.releaseOperation) {
      const current = Promise.resolve().then(() => {
        try {
          this.native.release();
          this.state = "released";
        } catch (error) {
          throw normalizeReleaseError(error);
        }
      });
      this.releaseOperation = current;
      void current.catch(() => {
        if (this.releaseOperation === current) this.releaseOperation = undefined;
      });
    }
    return this.releaseOperation;
  }

  isHeld(): boolean {
    return this.state === "held" && this.native.isHeld();
  }
}

function loadNativeAddon(): NativeAddon {
  if (process.platform !== "win32") {
    throw new InstanceLockError(
      "INSTANCE_LOCK_UNSUPPORTED",
      "The HTTP service requires Windows named-pipe ownership and cannot start on this platform.",
    );
  }
  if (process.arch !== "x64") {
    throw new InstanceLockError(
      "INSTANCE_LOCK_UNSUPPORTED",
      "The HTTP service native ownership addon currently supports Windows x64 only.",
    );
  }
  if (!isMainThread) {
    throw new InstanceLockError(
      "INSTANCE_LOCK_UNSUPPORTED",
      "The HTTP service ownership lease must be acquired from the main Node.js thread.",
    );
  }

  const addonPath = resolve(fileURLToPath(new URL("../../native/build/Release/instance_lock.node", import.meta.url)));
  try {
    return createRequire(import.meta.url)(addonPath) as NativeAddon;
  } catch (cause) {
    throw new InstanceLockError(
      "INSTANCE_LOCK_NATIVE_UNAVAILABLE",
      "The Windows service ownership addon is unavailable or incompatible. Build it with `npm run build:native` on Windows x64 with the Windows C++ toolchain installed.",
      { cause },
    );
  }
}

function normalizeAcquireError(error: unknown): InstanceLockError {
  if (hasCode(error, "INSTANCE_ALREADY_RUNNING")) {
    return new InstanceLockError(
      "INSTANCE_ALREADY_RUNNING",
      "Another Universal CMS AI Agent HTTP service already owns this Windows user instance.",
      { cause: error },
    );
  }
  if (hasCode(error, "INSTANCE_LOCK_NATIVE_UNAVAILABLE")) {
    return new InstanceLockError("INSTANCE_LOCK_NATIVE_UNAVAILABLE", "The Windows service ownership addon is unavailable.", { cause: error });
  }
  return new InstanceLockError(
    "INSTANCE_LOCK_ACQUIRE_FAILED",
    "Windows service ownership could not be acquired; startup was stopped safely.",
    { cause: error },
  );
}

function normalizeReleaseError(error: unknown): InstanceLockError {
  return new InstanceLockError(
    "INSTANCE_LOCK_RELEASE_FAILED",
    "Windows service ownership could not be released; it remains held for a shutdown retry.",
    { cause: error },
  );
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
