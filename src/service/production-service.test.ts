import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MockInstanceOwnershipProvider } from "../instance-ownership/mock-instance-ownership.js";
import { ServiceLifecycleCoordinator, runService, createProductionService } from "./main.js";
import { BrowserOperationLock } from "../browser/browser-operation-lock.js";
import { BrowserProfileOwnership } from "../browser/browser-profile-ownership.js";

test("production composition: acquires lease before runtime, creates exactly one runtime and gateway", async () => {
  MockInstanceOwnershipProvider.resetGlobalState();
  const provider = new MockInstanceOwnershipProvider();
  const events: string[] = [];
  let runtimeConstructionCount = 0;
  let gatewayConstructionCount = 0;

  const tempDir = await mkdtemp(join(tmpdir(), "prod-service-comp-"));
  try {
    const coordinator = new ServiceLifecycleCoordinator({
      ownershipIdentity: "test-prod-comp",
      profileDirectory: tempDir,
      ownershipProvider: {
        async acquire(id) {
          events.push("acquire_lease");
          return provider.acquire(id);
        },
      },
      browserRuntimeFactory: (opts) => {
        runtimeConstructionCount++;
        events.push("construct_runtime");
        return {
          browserService: { close: async () => {} } as any,
          profileDirectory: opts.profileDirectory,
          isShutDown: false,
          constructedAt: new Date(),
          initialize: async () => {
            events.push("init_runtime");
          },
          shutdown: async () => {
            events.push("shutdown_runtime");
          },
        } as any;
      },
      gatewayFactory: () => {
        gatewayConstructionCount++;
        events.push("construct_gateway");
        return {
          isRunning: false,
          isStopped: false,
          setSessionFactory: () => {},
          start: async () => {
            events.push("start_gateway");
          },
          stop: async () => {
            events.push("stop_gateway");
          },
        } as any;
      },
    });

    await coordinator.start();

    assert.equal(coordinator.getStatus(), "running");
    assert.equal(runtimeConstructionCount, 1, "Exactly one runtime must be created.");
    assert.equal(gatewayConstructionCount, 1, "Exactly one gateway must be created.");

    // Assert sequence: lease acquisition MUST precede runtime construction
    assert.deepEqual(events, [
      "acquire_lease",
      "construct_runtime",
      "init_runtime",
      "construct_gateway",
      "start_gateway",
    ]);

    await coordinator.shutdown();
    assert.equal(coordinator.getStatus(), "stopped");
    assert.ok(events.indexOf("stop_gateway") < events.indexOf("shutdown_runtime"), "Gateway stop must precede runtime shutdown.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("production composition: registers production tools for client sessions with isolated approval and workflow", async () => {
  MockInstanceOwnershipProvider.resetGlobalState();
  const provider = new MockInstanceOwnershipProvider();
  const tempDir = await mkdtemp(join(tmpdir(), "prod-service-tools-"));

  try {
    let capturedSessionFactory: (() => Promise<any>) | undefined;

    const fakeBrowser = {
      close: async () => {},
    } as any;

    const coordinator = new ServiceLifecycleCoordinator({
      ownershipIdentity: "test-prod-tools",
      profileDirectory: tempDir,
      ownershipProvider: provider,
      browserRuntimeFactory: (opts) => {
        return {
          browserService: fakeBrowser,
          profileDirectory: opts.profileDirectory,
          isShutDown: false,
          constructedAt: new Date(),
          initialize: async () => {},
          shutdown: async () => {},
        } as any;
      },
      gatewayFactory: () => {
        return {
          isRunning: false,
          isStopped: false,
          setSessionFactory: (factory: any) => {
            capturedSessionFactory = factory;
          },
          start: async () => {},
          stop: async () => {},
        } as any;
      },
    });

    await coordinator.start();
    assert.ok(capturedSessionFactory, "Session factory must be provided to gateway.");

    // Create session 1
    const session1 = await capturedSessionFactory!();
    // Create session 2
    const session2 = await capturedSessionFactory!();

    assert.ok(session1.server, "Session 1 must have an MCP server.");
    assert.ok(session2.server, "Session 2 must have an MCP server.");
    assert.notEqual(session1.sessionId, session2.sessionId, "Session IDs must be distinct.");
    assert.notEqual(
      session1.mutationApproval,
      session2.mutationApproval,
      "Mutation approval guards must be isolated per session.",
    );
    assert.notEqual(
      session1.workflow,
      session2.workflow,
      "Workflow services must be isolated per session.",
    );

    // Verify session close cleans up
    await session1.close();
    assert.equal(session1.isClosed, true);
    await session2.close();
    assert.equal(session2.isClosed, true);

    await coordinator.shutdown();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("production composition: startup failure cleans up resources safely", async () => {
  MockInstanceOwnershipProvider.resetGlobalState();
  const provider = new MockInstanceOwnershipProvider();
  const tempDir = await mkdtemp(join(tmpdir(), "prod-service-fail-"));

  try {
    const coordinator = new ServiceLifecycleCoordinator({
      ownershipIdentity: "test-prod-fail",
      profileDirectory: tempDir,
      ownershipProvider: provider,
      browserRuntimeFactory: (opts) => {
        return {
          browserService: { close: async () => {} } as any,
          profileDirectory: opts.profileDirectory,
          isShutDown: false,
          constructedAt: new Date(),
          initialize: async () => {},
          shutdown: async () => {},
        } as any;
      },
      gatewayFactory: () => {
        return {
          isRunning: false,
          isStopped: false,
          setSessionFactory: () => {},
          start: async () => {
            throw new Error("Port 3000 already in use");
          },
          stop: async () => {},
        } as any;
      },
    });

    await assert.rejects(
      async () => {
        await coordinator.start();
      },
      /Port 3000 already in use/,
    );

    assert.equal(coordinator.getStatus(), "stopped");
    assert.equal(coordinator.getLease(), undefined, "Lease must be released on startup failure.");

    // A new coordinator should be able to acquire ownership because lease was freed
    const secondCoordinator = new ServiceLifecycleCoordinator({
      ownershipIdentity: "test-prod-fail",
      profileDirectory: tempDir,
      ownershipProvider: provider,
      browserRuntimeFactory: (opts) => ({
        browserService: { close: async () => {} } as any,
        profileDirectory: opts.profileDirectory,
        isShutDown: false,
        constructedAt: new Date(),
        initialize: async () => {},
        shutdown: async () => {},
      } as any),
      gatewayFactory: () => ({
        isRunning: false,
        isStopped: false,
        setSessionFactory: () => {},
        start: async () => {},
        stop: async () => {},
      } as any),
    });

    await secondCoordinator.start();
    assert.equal(secondCoordinator.getStatus(), "running");
    await secondCoordinator.shutdown();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("production composition: repeated shutdown requests are idempotent and avoid unhandled rejections", async () => {
  MockInstanceOwnershipProvider.resetGlobalState();
  const provider = new MockInstanceOwnershipProvider();
  const tempDir = await mkdtemp(join(tmpdir(), "prod-service-idem-"));

  try {
    let stopCallCount = 0;
    const coordinator = new ServiceLifecycleCoordinator({
      ownershipIdentity: "test-prod-idem",
      profileDirectory: tempDir,
      ownershipProvider: provider,
      browserRuntimeFactory: (opts) => ({
        browserService: { close: async () => {} } as any,
        profileDirectory: opts.profileDirectory,
        isShutDown: false,
        constructedAt: new Date(),
        initialize: async () => {},
        shutdown: async () => {},
      } as any),
      gatewayFactory: () => ({
        isRunning: false,
        isStopped: false,
        setSessionFactory: () => {},
        start: async () => {},
        stop: async () => {
          stopCallCount++;
        },
      } as any),
    });

    await coordinator.start();
    assert.equal(coordinator.getStatus(), "running");

    // Initiate concurrent shutdown calls
    const p1 = coordinator.shutdown();
    const p2 = coordinator.shutdown();
    const p3 = coordinator.shutdown();

    await Promise.all([p1, p2, p3]);

    assert.equal(coordinator.getStatus(), "stopped");
    assert.equal(stopCallCount, 1, "Gateway stop must only be executed once.");

    // Subsequent call after stopped
    await coordinator.shutdown();
    assert.equal(coordinator.getStatus(), "stopped");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("production composition: gateway failure retains ownership and retry releases it", async () => {
  MockInstanceOwnershipProvider.resetGlobalState();
  const provider = new MockInstanceOwnershipProvider();
  const tempDir = await mkdtemp(join(tmpdir(), "prod-service-gw-fail-"));

  try {
    let gatewayFail = true;
    const coordinator = new ServiceLifecycleCoordinator({
      ownershipIdentity: "test-gw-fail",
      profileDirectory: tempDir,
      ownershipProvider: provider,
      browserRuntimeFactory: (opts) => ({
        browserService: { close: async () => {} } as any,
        profileDirectory: opts.profileDirectory,
        isShutDown: false,
        constructedAt: new Date(),
        initialize: async () => {},
        shutdown: async () => {},
      } as any),
      gatewayFactory: () => ({
        isRunning: true,
        isStopped: false,
        setSessionFactory: () => {},
        start: async () => {},
        stop: async () => {
          if (gatewayFail) {
            throw new Error("Simulated gateway drain crash");
          }
        },
      } as any),
    });

    await coordinator.start();
    const lease = coordinator.getLease()!;
    assert.ok(lease);

    await assert.rejects(
      async () => {
        await coordinator.shutdown();
      },
      /Simulated gateway drain crash/,
    );

    assert.equal(coordinator.getStatus(), "shutdown_failed");
    assert.equal(lease.isOwned(), true, "Ownership must be retained on gateway failure.");

    // Retry after fixing condition
    gatewayFail = false;
    await coordinator.retryShutdown();
    assert.equal(coordinator.getStatus(), "stopped");
    assert.equal(lease.isOwned(), false, "Ownership must be released on retry success.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
