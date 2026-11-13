import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import readline from "node:readline";

import { resolveNativeAddonPath } from "./native-instance-ownership.js";
import { BrowserProfileOwnership } from "../browser/browser-profile-ownership.js";

const WORKER_SCRIPT = resolve(process.cwd(), "test", "fixtures", "ownership-worker.mjs");

class WorkerSession {
  public readonly proc: ChildProcess;
  private readonly rl: readline.Interface;
  private readonly eventWaiters = new Map<string, Array<{ resolve: (val: any) => void; reject: (err: Error) => void }>>();
  private readonly eventBuffer: any[] = [];
  public exited = false;
  public exitCode: number | null = null;

  constructor(options: { cwd?: string } = {}) {
    this.proc = spawn(process.execPath, [WORKER_SCRIPT], {
      cwd: options.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env },
    });

    this.rl = readline.createInterface({
      input: this.proc.stdout!,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      try {
        const msg = JSON.parse(text);
        const waiters = this.eventWaiters.get(msg.event);
        if (waiters && waiters.length > 0) {
          const waiter = waiters.shift()!;
          waiter.resolve(msg);
        } else {
          this.eventBuffer.push(msg);
        }
      } catch {
        // ignore unparseable
      }
    });

    this.proc.on("exit", (code) => {
      this.exited = true;
      this.exitCode = code;
      for (const [evt, waiters] of this.eventWaiters.entries()) {
        for (const waiter of waiters) {
          waiter.reject(new Error(`Worker exited with code ${code} while waiting for event '${evt}'.`));
        }
      }
      this.eventWaiters.clear();
    });
  }

  send(cmd: any): void {
    if (this.exited) {
      throw new Error("Cannot send to exited worker process.");
    }
    this.proc.stdin!.write(JSON.stringify(cmd) + "\n");
  }

  waitForEvent(expectedEvent: string, timeoutMs = 8000): Promise<any> {
    const bufferedIdx = this.eventBuffer.findIndex((e) => e.event === expectedEvent);
    if (bufferedIdx >= 0) {
      const item = this.eventBuffer.splice(bufferedIdx, 1)[0];
      return Promise.resolve(item);
    }

    if (this.exited) {
      return Promise.reject(new Error(`Worker already exited before receiving event '${expectedEvent}'.`));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for event '${expectedEvent}' after ${timeoutMs}ms.`));
      }, timeoutMs);

      const list = this.eventWaiters.get(expectedEvent) || [];
      list.push({
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.eventWaiters.set(expectedEvent, list);
    });
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (!this.exited) {
      this.proc.kill(signal);
    }
  }

  async close(): Promise<void> {
    if (!this.exited) {
      try {
        this.send({ command: "exit" });
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.kill("SIGKILL");
          resolve();
        }, 1500);
        this.proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

const isNativeBuilt = () => {
  const p = resolveNativeAddonPath();
  return !!p && existsSync(p);
};

test("native addon availability / fallback check", async () => {
  const built = isNativeBuilt();
  if (!built) {
    console.log(
      "[native-integration-test] Notice: Native addon binary not compiled locally.\n" +
      "[native-integration-test] Native integration tests require compiled addon (built in GitHub Actions windows-2022)."
    );
  }
  assert.ok(true);
});

test("native integration: two concurrent processes attempting same identity (exactly one succeeds)", async (t) => {
  if (!isNativeBuilt()) {
    t.skip("Native addon not compiled on this host. Tested in GitHub Actions windows-2022 runner.");
    return;
  }

  const identity = `concurrent-test-${Date.now()}`;
  const workerA = new WorkerSession();
  const workerB = new WorkerSession();

  try {
    workerA.send({ command: "acquire_direct", identity });
    const evA = await workerA.waitForEvent("DIRECT_ACQUIRED");
    assert.equal(evA.identity, identity);
    assert.equal(evA.isOwned, true);

    workerB.send({ command: "acquire_direct", identity });
    const evB = await workerB.waitForEvent("DIRECT_ERROR");
    assert.equal(evB.code, "INSTANCE_ALREADY_RUNNING");
    assert.ok(evB.message.includes("Another service instance is already running"));
  } finally {
    await workerA.close();
    await workerB.close();
  }
});

test("native integration: losing process fails before constructing fake runtime", async (t) => {
  if (!isNativeBuilt()) {
    t.skip("Native addon not compiled on this host. Tested in GitHub Actions windows-2022 runner.");
    return;
  }

  const identity = `losing-runtime-${Date.now()}`;
  const worker1 = new WorkerSession();
  const worker2 = new WorkerSession();

  const tempDir = await mkdtemp(join(tmpdir(), "sqsp-int-runtime-"));

  try {
    worker1.send({
      command: "start_service",
      identity,
      profileDirectory: tempDir,
    });
    const ev1 = await worker1.waitForEvent("SERVICE_STARTED");
    assert.equal(ev1.fakeRuntimeConstructed, true);

    // Worker 2 attempts same identity
    worker2.send({
      command: "start_service",
      identity,
      profileDirectory: tempDir,
    });
    const ev2 = await worker2.waitForEvent("SERVICE_START_FAILED");
    assert.equal(ev2.code, "INSTANCE_ALREADY_RUNNING");
    assert.equal(ev2.fakeRuntimeConstructed, false, "Losing process must fail before constructing runtime.");
  } finally {
    await worker1.close();
    await worker2.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("native integration: different working directories do not bypass ownership", async (t) => {
  if (!isNativeBuilt()) {
    t.skip("Native addon not compiled on this host. Tested in GitHub Actions windows-2022 runner.");
    return;
  }

  const identity = `different-cwd-${Date.now()}`;
  const dir1 = await mkdtemp(join(tmpdir(), "sqsp-cwd-1-"));
  const dir2 = await mkdtemp(join(tmpdir(), "sqsp-cwd-2-"));

  const worker1 = new WorkerSession({ cwd: dir1 });
  const worker2 = new WorkerSession({ cwd: dir2 });

  try {
    worker1.send({ command: "acquire_direct", identity, cwd: dir1 });
    const ev1 = await worker1.waitForEvent("DIRECT_ACQUIRED");
    assert.equal(ev1.identity, identity);

    worker2.send({ command: "acquire_direct", identity, cwd: dir2 });
    const ev2 = await worker2.waitForEvent("DIRECT_ERROR");
    assert.equal(ev2.code, "INSTANCE_ALREADY_RUNNING");
  } finally {
    await worker1.close();
    await worker2.close();
    await rm(dir1, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
});

test("native integration: normal release allows a later process to acquire ownership", async (t) => {
  if (!isNativeBuilt()) {
    t.skip("Native addon not compiled on this host. Tested in GitHub Actions windows-2022 runner.");
    return;
  }

  const identity = `normal-release-${Date.now()}`;
  const worker1 = new WorkerSession();
  const worker2 = new WorkerSession();

  try {
    worker1.send({ command: "acquire_direct", identity });
    await worker1.waitForEvent("DIRECT_ACQUIRED");

    // Release direct
    worker1.send({ command: "release_direct" });
    const relEv = await worker1.waitForEvent("DIRECT_RELEASED");
    assert.equal(relEv.result, true);

    // Later process acquires
    worker2.send({ command: "acquire_direct", identity });
    const ev2 = await worker2.waitForEvent("DIRECT_ACQUIRED");
    assert.equal(ev2.identity, identity);
    assert.equal(ev2.isOwned, true);
  } finally {
    await worker1.close();
    await worker2.close();
  }
});

test("native integration: abrupt child-process termination releases OS pipe handle", async (t) => {
  if (!isNativeBuilt()) {
    t.skip("Native addon not compiled on this host. Tested in GitHub Actions windows-2022 runner.");
    return;
  }

  const identity = `abrupt-term-${Date.now()}`;
  const worker1 = new WorkerSession();
  const worker2 = new WorkerSession();

  try {
    worker1.send({ command: "acquire_direct", identity });
    await worker1.waitForEvent("DIRECT_ACQUIRED");

    // Abrupt termination via SIGKILL
    worker1.kill("SIGKILL");

    // Give kernel a moment to release handles on process death
    await new Promise((r) => setTimeout(r, 200));

    // Later process acquires ownership
    worker2.send({ command: "acquire_direct", identity });
    const ev2 = await worker2.waitForEvent("DIRECT_ACQUIRED");
    assert.equal(ev2.identity, identity);
    assert.equal(ev2.isOwned, true);
  } finally {
    await worker1.close();
    await worker2.close();
  }
});

test("native integration: fake stale browser-profile marker remains untouched", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "sqsp-int-profile-"));
  try {
    const markerPath = BrowserProfileOwnership.getMarkerPath(tempDir);
    const staleData = JSON.stringify({ pid: 1234, marker: "stale-crashed" });
    await writeFile(markerPath, staleData, "utf8");

    const worker = new WorkerSession();
    try {
      worker.send({
        command: "start_service",
        identity: `stale-marker-${Date.now()}`,
        profileDirectory: tempDir,
      });

      const ev = await worker.waitForEvent("SERVICE_START_FAILED");
      assert.equal(ev.fakeRuntimeConstructed, false);
      assert.ok(existsSync(markerPath), "Marker must remain untouched.");
      const readBack = await readFile(markerPath, "utf8");
      assert.equal(readBack, staleData);
    } finally {
      await worker.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("native integration: repeated release does not cause errors or release twice", async (t) => {
  if (!isNativeBuilt()) {
    t.skip("Native addon not compiled on this host. Tested in GitHub Actions windows-2022 runner.");
    return;
  }

  const identity = `double-release-${Date.now()}`;
  const worker = new WorkerSession();

  try {
    worker.send({ command: "acquire_direct", identity });
    await worker.waitForEvent("DIRECT_ACQUIRED");

    worker.send({ command: "release_direct" });
    const r1 = await worker.waitForEvent("DIRECT_RELEASED");
    assert.equal(r1.result, true);

    worker.send({ command: "release_direct" });
    const r2 = await worker.waitForEvent("DIRECT_RELEASED");
    assert.equal(r2.result, false); // already released, idempotent
  } finally {
    await worker.close();
  }
});

test("native integration: shutdown failure retains native ownership and successful retry releases it", async (t) => {
  if (!isNativeBuilt()) {
    t.skip("Native addon not compiled on this host. Tested in GitHub Actions windows-2022 runner.");
    return;
  }

  const identity = `shutdown-retry-${Date.now()}`;
  const worker1 = new WorkerSession();
  const worker2 = new WorkerSession();
  const tempDir = await mkdtemp(join(tmpdir(), "sqsp-int-retry-"));

  try {
    worker1.send({
      command: "start_service",
      identity,
      profileDirectory: tempDir,
      simulateRuntimeShutdownFailure: true,
    });
    await worker1.waitForEvent("SERVICE_STARTED");

    // Initiate shutdown which fails
    worker1.send({ command: "shutdown_service" });
    const failEv = await worker1.waitForEvent("SERVICE_SHUTDOWN_FAILED");
    assert.equal(failEv.status, "shutdown_failed");

    // Worker 2 attempts to acquire ownership - must be BLOCKED
    worker2.send({ command: "acquire_direct", identity });
    const blockEv = await worker2.waitForEvent("DIRECT_ERROR");
    assert.equal(blockEv.code, "INSTANCE_ALREADY_RUNNING");

    // Retry shutdown on Worker 1 with failure cleared
    worker1.send({ command: "retry_shutdown", fixRuntimeFailure: true });
    const retryEv = await worker1.waitForEvent("RETRY_SHUTDOWN_SUCCESS");
    assert.equal(retryEv.status, "stopped");

    // Now Worker 2 can acquire ownership
    worker2.send({ command: "acquire_direct", identity });
    const acqEv = await worker2.waitForEvent("DIRECT_ACQUIRED");
    assert.equal(acqEv.identity, identity);
  } finally {
    await worker1.close();
    await worker2.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
