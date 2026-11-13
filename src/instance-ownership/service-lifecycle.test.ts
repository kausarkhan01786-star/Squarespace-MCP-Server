import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

import { MockInstanceOwnershipProvider } from "./mock-instance-ownership.js";
import { ServiceLifecycleCoordinator } from "../service/main.js";
import { BrowserProfileOwnership, PROFILE_OWNERSHIP_MARKER_FILE } from "../browser/browser-profile-ownership.js";
import { SquarespaceBrowserError } from "../browser/browser-errors.js";
import { InstanceOwnershipError } from "./instance-ownership.types.js";

test("lifecycle: acquires ownership lease before browser runtime construction", async () => {
  MockInstanceOwnershipProvider.resetGlobalState();
  const provider = new MockInstanceOwnershipProvider();
  const order: string[] = [];

  const tempDir = await mkdtemp(join(tmpdir(), "sqsp-lifecycle-test-"));
  try {
    const coordinator = new ServiceLifecycleCoordinator({
      ownershipIdentity: "test-lifecycle-order",
      profileDirectory: tempDir,
      ownershipProvider: {
        async acquire(id) {
          order.push("lease_acquire");
          return provider.acquire(id);
        },
      },
      browserRuntimeFactory: (opts) => {
        order.push("runtime_constructed");
        return {
          browserService: { close: async () => {} } as any,
          profileDirectory: opts.profileDirectory,
          isShutDown: false,
          constructedAt: new Date(),
          initialize: async () => {
            order.push("runtime_initialized");
          },
          shutdown: async () => {},
        } as any;
      },
      gatewayFactory: () => {
        order.push("gateway_constructed");
        return {
          isRunning: false,
          isStopped: false,
          start: async () => {
            order.push("gateway_started");
          },
          stop: async () => {},
        } as any;
      },
    });

    await coordinator.start();

    assert.equal(coordinator.getStatus(), "running");
    assert.deepEqual(order, [
      "lease_acquire",
      "runtime_constructed",
      "runtime_initialized",
      "gateway_constructed",
      "gateway_started",
    ]);

    await coordinator.shutdown();
    assert.equal(coordinator.getStatus(), "stopped");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("lifecycle: prevents service startup if acquisition fails and never constructs runtime", async () => {
  MockInstanceOwnershipProvider.resetGlobalState();
  const provider = new MockInstanceOwnershipProvider();
  provider.forceFailAcquisition = true;

  let runtimeConstructed = false;
  const tempDir = await mkdtemp(join(tmpdir(), "sqsp-lifecycle-fail-"));
  try {
    const coordinator = new ServiceLifecycleCoordinator({
      ownershipIdentity: "test-fail-acquisition",
      profileDirectory: tempDir,
      ownershipProvider: provider,
      browserRuntimeFactory: () => {
        runtimeConstructed = true;
        throw new Error("Runtime factory must not be called when acquisition fails!");
      },
    });

    await assert.rejects(
      async () => {
        await coordinator.start();
      },
      (err: any) => {
        assert.equal(err.code, "INSTANCE_OWNERSHIP_ACQUISITION_FAILED");
        return true;
      },
    );

    assert.equal(runtimeConstructed, false, "Runtime must not be constructed when acquisition fails.");
    assert.equal(coordinator.getStatus(), "unstarted");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("lifecycle: retains ownership when browser shutdown fails and allows shutdown retry", async () => {
  MockInstanceOwnershipProvider.resetGlobalState();
  const provider = new MockInstanceOwnershipProvider();
  const tempDir = await mkdtemp(join(tmpdir(), "sqsp-lifecycle-retry-"));

  try {
    let failRuntimeShutdown = true;
    let runtimeClosed = false;
    let gatewayStopped = false;

    const coordinator = new ServiceLifecycleCoordinator({
      ownershipIdentity: "test-shutdown-fail",
      profileDirectory: tempDir,
      ownershipProvider: provider,
      browserRuntimeFactory: (opts) => {
        return {
          browserService: { close: async () => {} } as any,
          profileDirectory: opts.profileDirectory,
          isShutDown: false,
          constructedAt: new Date(),
          initialize: async () => {},
          shutdown: async () => {
            if (failRuntimeShutdown) {
              throw new Error("Simulated browser close crash during shutdown");
            }
            runtimeClosed = true;
          },
        } as any;
      },
      gatewayFactory: () => {
        return {
          isRunning: true,
          isStopped: false,
          start: async () => {},
          stop: async () => {
            gatewayStopped = true;
          },
        } as any;
      },
    });

    await coordinator.start();
    assert.equal(coordinator.getStatus(), "running");

    const lease = coordinator.getLease();
    assert.ok(lease);
    assert.equal(lease.isOwned(), true);

    // Shutdown attempt fails because runtime shutdown fails
    await assert.rejects(
      async () => {
        await coordinator.shutdown();
      },
      /Simulated browser close crash/,
    );

    // CRITICAL: Ownership must NOT be released in a finally block when shutdown fails!
    assert.equal(coordinator.getStatus(), "shutdown_failed");
    assert.equal(lease.isOwned(), true, "Ownership lease must remain active when shutdown fails.");

    // Another service cannot acquire this identity while shutdown is unresolved
    const secondCoordinator = new ServiceLifecycleCoordinator({
      ownershipIdentity: "test-shutdown-fail",
      profileDirectory: tempDir,
      ownershipProvider: provider,
    });
    await assert.rejects(
      async () => {
        await secondCoordinator.start();
      },
      (err: any) => {
        assert.equal(err.code, "INSTANCE_ALREADY_RUNNING");
        return true;
      },
    );

    // Now perform shutdown retry after clearing the failure condition
    failRuntimeShutdown = false;
    await coordinator.retryShutdown();

    assert.equal(coordinator.getStatus(), "stopped");
    assert.equal(lease.isOwned(), false, "Lease must be released after successful shutdown retry.");
    assert.equal(runtimeClosed, true);
    assert.equal(gatewayStopped, true);

    // Now a new coordinator can acquire ownership
    await secondCoordinator.start();
    assert.equal(secondCoordinator.getStatus(), "running");
    await secondCoordinator.shutdown();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("lifecycle: stale browser-profile marker remains untouched after crash and blocks startup", async () => {
  MockInstanceOwnershipProvider.resetGlobalState();
  const provider = new MockInstanceOwnershipProvider();
  const tempDir = await mkdtemp(join(tmpdir(), "sqsp-profile-stale-"));

  try {
    const markerPath = BrowserProfileOwnership.getMarkerPath(tempDir);
    const staleContent = JSON.stringify({
      pid: 99999,
      acquiredAt: new Date(Date.now() - 3600_000).toISOString(),
      host: "crash-host",
    });
    await writeFile(markerPath, staleContent, "utf8");

    let runtimeConstructed = false;

    const coordinator = new ServiceLifecycleCoordinator({
      ownershipIdentity: "test-stale-marker",
      profileDirectory: tempDir,
      ownershipProvider: provider,
      browserRuntimeFactory: () => {
        runtimeConstructed = true;
        return {} as any;
      },
    });

    await assert.rejects(
      async () => {
        await coordinator.start();
      },
      (err: any) => {
        assert.ok(err instanceof SquarespaceBrowserError);
        assert.equal(err.code, "BROWSER_LAUNCH_FAILED");
        return true;
      },
    );

    assert.equal(runtimeConstructed, false, "Runtime should not be constructed when profile is locked.");
    assert.ok(existsSync(markerPath), "Stale marker must NOT be deleted or bypassed.");
    const contentAfter = await readFile(markerPath, "utf8");
    assert.equal(contentAfter, staleContent, "Stale marker content must remain untouched.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("lifecycle: repeated release is idempotent and does not throw", async () => {
  MockInstanceOwnershipProvider.resetGlobalState();
  const provider = new MockInstanceOwnershipProvider();
  const lease = await provider.acquire("test-idempotent-release");

  assert.equal(lease.isOwned(), true);
  const first = await lease.release();
  assert.equal(first, true);
  assert.equal(lease.isOwned(), false);

  const second = await lease.release();
  assert.equal(second, false);
  assert.equal(lease.isOwned(), false);
});
