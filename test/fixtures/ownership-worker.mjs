import readline from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NativeWindowsInstanceOwnershipProvider, resolveNativeAddonPath } from "../../dist/instance-ownership/native-instance-ownership.js";
import { ServiceLifecycleCoordinator } from "../../dist/service/main.js";
import { BrowserProfileOwnership } from "../../dist/browser/browser-profile-ownership.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let coordinator = null;
let fakeRuntimeConstructed = false;
let lease = null;

function sendEvent(type, payload = {}) {
  process.stdout.write(JSON.stringify({ event: type, ...payload }) + "\n");
}

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;

  try {
    const msg = JSON.parse(text);

    if (msg.command === "ping") {
      sendEvent("PONG");
      return;
    }

    if (msg.command === "check_native") {
      const addonPath = resolveNativeAddonPath();
      sendEvent("NATIVE_STATUS", {
        available: !!addonPath && existsSync(addonPath),
        path: addonPath || null,
      });
      return;
    }

    if (msg.command === "acquire_direct") {
      const provider = new NativeWindowsInstanceOwnershipProvider(msg.cwd || process.cwd());
      try {
        lease = await provider.acquire(msg.identity);
        sendEvent("DIRECT_ACQUIRED", {
          identity: lease.identity,
          pipeName: lease.pipeName,
          isOwned: lease.isOwned(),
        });
      } catch (err) {
        sendEvent("DIRECT_ERROR", {
          code: err.code || "UNKNOWN_ERROR",
          message: err.message,
        });
      }
      return;
    }

    if (msg.command === "release_direct") {
      if (lease) {
        const result = await lease.release();
        sendEvent("DIRECT_RELEASED", {
          result,
          isOwned: lease.isOwned(),
        });
      } else {
        sendEvent("DIRECT_RELEASED", { result: false, isOwned: false });
      }
      return;
    }

    if (msg.command === "start_service") {
      fakeRuntimeConstructed = false;
      const provider = new NativeWindowsInstanceOwnershipProvider(msg.cwd || process.cwd());

      coordinator = new ServiceLifecycleCoordinator({
        ownershipIdentity: msg.identity,
        profileDirectory: msg.profileDirectory,
        ownershipProvider: provider,
        simulateRuntimeShutdownFailure: !!msg.simulateRuntimeShutdownFailure,
        simulateGatewayShutdownFailure: !!msg.simulateGatewayShutdownFailure,
        browserRuntimeFactory: (opts) => {
          fakeRuntimeConstructed = true;
          return {
            browserService: { close: async () => {} },
            profileDirectory: opts.profileDirectory,
            isShutDown: false,
            constructedAt: new Date(),
            initialize: async () => {
              if (msg.createStaleMarkerFirst) {
                // marker already exists
              }
              await BrowserProfileOwnership.writeMarker(opts.profileDirectory);
            },
            shutdown: async () => {
              if (msg.simulateRuntimeShutdownFailure) {
                throw new Error("Simulated browser runtime shutdown failure.");
              }
            },
          };
        },
        gatewayFactory: (opts) => {
          return {
            isRunning: false,
            isStopped: false,
            start: async () => {},
            stop: async () => {
              if (msg.simulateGatewayShutdownFailure) {
                throw new Error("Simulated gateway shutdown failure.");
              }
            },
          };
        },
      });

      try {
        await coordinator.start();
        sendEvent("SERVICE_STARTED", {
          fakeRuntimeConstructed,
          status: coordinator.getStatus(),
          identity: coordinator.getLease()?.identity,
          pipeName: coordinator.getLease()?.pipeName,
        });
      } catch (err) {
        sendEvent("SERVICE_START_FAILED", {
          fakeRuntimeConstructed,
          code: err.code || "UNKNOWN_ERROR",
          message: err.message,
        });
      }
      return;
    }

    if (msg.command === "shutdown_service") {
      if (!coordinator) {
        sendEvent("SHUTDOWN_FAILED", { message: "No active coordinator." });
        return;
      }
      try {
        await coordinator.shutdown();
        sendEvent("SERVICE_SHUTDOWN_SUCCESS", {
          status: coordinator.getStatus(),
        });
      } catch (err) {
        sendEvent("SERVICE_SHUTDOWN_FAILED", {
          status: coordinator.getStatus(),
          message: err.message,
        });
      }
      return;
    }

    if (msg.command === "retry_shutdown") {
      if (!coordinator) {
        sendEvent("RETRY_SHUTDOWN_FAILED", { message: "No active coordinator." });
        return;
      }
      try {
        await coordinator.retryShutdown({
          fixGatewayFailure: !!msg.fixGatewayFailure,
          fixRuntimeFailure: !!msg.fixRuntimeFailure,
        });
        sendEvent("RETRY_SHUTDOWN_SUCCESS", {
          status: coordinator.getStatus(),
        });
      } catch (err) {
        sendEvent("RETRY_SHUTDOWN_FAILED", {
          status: coordinator.getStatus(),
          message: err.message,
        });
      }
      return;
    }

    if (msg.command === "exit") {
      process.exit(0);
    }
  } catch (parseError) {
    sendEvent("PARSE_ERROR", { message: parseError.message });
  }
});
