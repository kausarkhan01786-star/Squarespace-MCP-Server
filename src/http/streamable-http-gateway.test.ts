/**
 * Focused regression tests for StreamableHttpGateway (Phase 3C.3).
 *
 * Tests:
 *  - Session admission: global limit, concurrent init counting, factory failure cleanup
 *  - Body size cap: Content-Length header check, streaming byte count
 *  - Receive timeout: slow body → 408
 *  - Aborted body → capacity released, no crash
 *  - inFlightRequests always decremented in all error paths
 *  - DELETE /mcp/:id: 404 on unknown, 409 on in-flight, 204 and removal otherwise
 *  - Idle session expiration: idle sessions closed by sweeper, active sessions not evicted
 *  - Shutdown drains in-flight and closes sessions
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHttpGateway } from "./streamable-http-gateway.js";
import type { McpClientSession } from "../runtime/mcp-client-session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _sessionIdCounter = 0;

function makeFakeSession(id?: string): McpClientSession {
  const sessionId = id ?? `fake-session-${++_sessionIdCounter}`;
  return {
    sessionId,
    isClosed: false,
    async close() {
      (this as any).isClosed = true;
    },
  } as unknown as McpClientSession;
}

/** Build an IncomingMessage-like object from a stream with controllable body. */
function fakeRequest(opts: {
  method?: string;
  url?: string;
  host?: string;
  sessionId?: string;
  authorization?: string;
  contentLength?: number;
  body?: Buffer | null; // null = never end (timeout test), undefined = empty body
  abortAfterBytes?: number; // emit "aborted" after this many bytes
}): IncomingMessage {
  const headers: Record<string, string | number> = {
    host: opts.host ?? "localhost",
  };
  if (opts.sessionId) headers["mcp-session-id"] = opts.sessionId;
  if (opts.authorization) headers["authorization"] = opts.authorization;
  if (opts.contentLength !== undefined) headers["content-length"] = opts.contentLength;

  const readable = new Readable({ read() {} });
  const req = Object.assign(readable, {
    method: opts.method ?? "POST",
    url: opts.url ?? "/mcp",
    headers,
    socket: Object.assign(new EventEmitter(), { remoteAddress: "127.0.0.1" }),
  }) as unknown as IncomingMessage;

  // Push body data asynchronously
  if (opts.body === null) {
    // Never end — simulates timeout
  } else {
    setImmediate(() => {
      const body = opts.body ?? Buffer.alloc(0);
      if (opts.abortAfterBytes !== undefined && opts.abortAfterBytes < body.length) {
        readable.push(body.slice(0, opts.abortAfterBytes));
        readable.emit("aborted");
      } else {
        readable.push(body);
        readable.push(null);
      }
    });
  }

  return req;
}

function fakeResponse(): {
  res: ServerResponse;
  statusCode: () => number;
  body: () => string;
  headersSent: boolean;
} {
  let _status = 0;
  const fake = {
    headersSent: false,
    writeHead(code: number) {
      _status = code;
      this.headersSent = true;
    },
    end(data?: string) {
      void data;
    },
  } as unknown as ServerResponse & { headersSent: boolean };
  return {
    res: fake,
    statusCode: () => _status,
    body: () => "",
    headersSent: false,
  };
}

/** Create a gateway instance that bypasses real HTTP server binding. */
function makeGateway(
  factory: () => Promise<McpClientSession>,
  overrides: Partial<ConstructorParameters<typeof StreamableHttpGateway>[0]> = {},
): StreamableHttpGateway {
  return new StreamableHttpGateway({
    maxGlobalSessions: overrides.maxGlobalSessions ?? 10,
    maxBodyBytes: overrides.maxBodyBytes ?? 1_048_576,
    bodyReceiveTimeoutMs: overrides.bodyReceiveTimeoutMs ?? 10_000,
    idleSessionTimeoutMs: overrides.idleSessionTimeoutMs ?? 300_000,
    sessionFactory: factory,
    ...overrides,
  });
}

// Call the private handleRequest method directly (bypasses HTTP server binding)
async function callHandle(
  gw: StreamableHttpGateway,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return (gw as any).handleRequest(req, res);
}

// ---------------------------------------------------------------------------
// Session admission
// ---------------------------------------------------------------------------

test("session admission: creates new session when map is empty", async () => {
  const session = makeFakeSession();
  const gw = makeGateway(async () => session);
  const { res, statusCode } = fakeResponse();
  const req = fakeRequest({ method: "POST", url: "/mcp" });
  await callHandle(gw, req, res);
  assert.equal(gw.getActiveSessionCount(), 1);
});

test("session admission: reuses existing session when mcp-session-id matches", async () => {
  const session = makeFakeSession("my-session");
  const gw = makeGateway(async () => session);
  const req1 = fakeRequest({ method: "POST", url: "/mcp" });
  const { res: res1 } = fakeResponse();
  await callHandle(gw, req1, res1);
  assert.equal(gw.getActiveSessionCount(), 1);

  const req2 = fakeRequest({ method: "POST", url: "/mcp", sessionId: "my-session" });
  const { res: res2 } = fakeResponse();
  await callHandle(gw, req2, res2);
  // Still only 1 session
  assert.equal(gw.getActiveSessionCount(), 1);
});

test("session admission: rejects new session when global limit reached", async () => {
  let callCount = 0;
  const gw = makeGateway(async () => { callCount++; return makeFakeSession(); }, {
    maxGlobalSessions: 2,
  });

  // Fill up to limit
  for (let i = 0; i < 2; i++) {
    const req = fakeRequest({ method: "POST", url: "/mcp" });
    const { res } = fakeResponse();
    await callHandle(gw, req, res);
  }
  assert.equal(gw.getActiveSessionCount(), 2);

  // Next new session request must get 429
  const req429 = fakeRequest({ method: "POST", url: "/mcp" });
  const { res: res429, statusCode } = fakeResponse();
  await callHandle(gw, req429, res429);
  assert.equal(statusCode(), 429, "Must return 429 when session limit is reached.");
  assert.equal(gw.getActiveSessionCount(), 2, "Session count must not change on rejection.");
});

test("session admission: sessionsInitializing counted during async factory, decremented after", async () => {
  let resolveFactory!: (s: McpClientSession) => void;
  const factoryPromise = new Promise<McpClientSession>((r) => { resolveFactory = r; });

  const gw = makeGateway(async () => factoryPromise, { maxGlobalSessions: 1 });

  // Start a request — factory will hang
  const req = fakeRequest({ method: "POST", url: "/mcp" });
  const { res } = fakeResponse();
  const handlePromise = callHandle(gw, req, res);

  // Give the event loop a tick so the factory is invoked
  await new Promise((r) => setImmediate(r));

  // sessionsInitializing should be 1 (admission slot reserved)
  assert.equal((gw as any).sessionsInitializing, 1, "sessionsInitializing must be 1 while factory is pending.");

  // A second request should be rejected (1 initializing + 0 sessions = at limit of 1)
  const req2 = fakeRequest({ method: "POST", url: "/mcp" });
  const { res: res2, statusCode: sc2 } = fakeResponse();
  await callHandle(gw, req2, res2);
  assert.equal(sc2(), 429, "Second session must be rejected while first is initializing.");

  // Complete the first factory
  resolveFactory(makeFakeSession());
  await handlePromise;

  assert.equal((gw as any).sessionsInitializing, 0, "sessionsInitializing must be 0 after factory completes.");
  assert.equal(gw.getActiveSessionCount(), 1);
});

test("session admission: factory failure decrements sessionsInitializing, session not added", async () => {
  const gw = makeGateway(async () => { throw new Error("factory error"); });
  const req = fakeRequest({ method: "POST", url: "/mcp" });
  const { res, statusCode } = fakeResponse();
  await callHandle(gw, req, res);
  assert.equal(statusCode(), 500);
  assert.equal(gw.getActiveSessionCount(), 0);
  assert.equal((gw as any).sessionsInitializing, 0, "sessionsInitializing must return to 0 on factory failure.");
});

// ---------------------------------------------------------------------------
// Body size cap
// ---------------------------------------------------------------------------

test("body size: Content-Length header exceeding limit → 413", async () => {
  const gw = makeGateway(async () => makeFakeSession(), { maxBodyBytes: 100 });
  const req = fakeRequest({ method: "POST", url: "/mcp", contentLength: 200, body: null });
  const { res, statusCode } = fakeResponse();
  await callHandle(gw, req, res);
  assert.equal(statusCode(), 413);
});

test("body size: streamed body exceeding limit → 413", async () => {
  const gw = makeGateway(async () => makeFakeSession(), { maxBodyBytes: 10 });
  // Provide a 20-byte body (Content-Length header omitted to exercise streaming check)
  const req = fakeRequest({ method: "POST", url: "/mcp", body: Buffer.alloc(20, 0x41) });
  const { res, statusCode } = fakeResponse();
  await callHandle(gw, req, res);
  assert.equal(statusCode(), 413);
});

test("body size: inFlightRequests decremented after 413", async () => {
  const gw = makeGateway(async () => makeFakeSession(), { maxBodyBytes: 5 });
  const req = fakeRequest({ method: "POST", url: "/mcp", body: Buffer.alloc(10, 0x41) });
  const { res } = fakeResponse();
  await callHandle(gw, req, res);
  assert.equal((gw as any).inFlightRequests, 0, "inFlightRequests must be 0 after 413 response.");
});

// ---------------------------------------------------------------------------
// Receive timeout
// ---------------------------------------------------------------------------

test("body receive timeout: slow body → 408", async () => {
  const gw = makeGateway(async () => makeFakeSession(), { bodyReceiveTimeoutMs: 10 });
  // body: null → stream never ends (simulates stall)
  const req = fakeRequest({ method: "POST", url: "/mcp", body: null });
  const { res, statusCode } = fakeResponse();
  await callHandle(gw, req, res);
  assert.equal(statusCode(), 408);
});

test("body receive timeout: inFlightRequests decremented after 408", async () => {
  const gw = makeGateway(async () => makeFakeSession(), { bodyReceiveTimeoutMs: 10 });
  const req = fakeRequest({ method: "POST", url: "/mcp", body: null });
  const { res } = fakeResponse();
  await callHandle(gw, req, res);
  assert.equal((gw as any).inFlightRequests, 0);
});

// ---------------------------------------------------------------------------
// Aborted body
// ---------------------------------------------------------------------------

test("aborted body: inFlightRequests decremented on abort", async () => {
  const gw = makeGateway(async () => makeFakeSession());
  const req = fakeRequest({ method: "POST", url: "/mcp", body: Buffer.alloc(10), abortAfterBytes: 5 });
  const { res } = fakeResponse();
  await callHandle(gw, req, res);
  assert.equal((gw as any).inFlightRequests, 0, "inFlightRequests must be 0 after abort.");
});

// ---------------------------------------------------------------------------
// DELETE /mcp/:sessionId
// ---------------------------------------------------------------------------

test("DELETE /mcp/:id: 404 for unknown session ID", async () => {
  const gw = makeGateway(async () => makeFakeSession());
  const req = fakeRequest({ method: "DELETE", url: "/mcp/nonexistent-session" });
  const { res, statusCode } = fakeResponse();
  await callHandle(gw, req, res);
  assert.equal(statusCode(), 404);
});

test("DELETE /mcp/:id: 409 when session has in-flight requests", async () => {
  const session = makeFakeSession("delete-test");
  const gw = makeGateway(async () => session);

  // Artificially inject session and set inFlightRequests > 0
  (gw as any).sessions.set("delete-test", {
    session,
    inFlightRequests: 1,
    lastActivityAt: Date.now(),
  });

  const req = fakeRequest({ method: "DELETE", url: "/mcp/delete-test" });
  const { res, statusCode } = fakeResponse();
  await callHandle(gw, req, res);
  assert.equal(statusCode(), 409);
  assert.equal(gw.getActiveSessionCount(), 1, "Session must not be removed on 409.");
});

test("DELETE /mcp/:id: 204 and session removed when no in-flight requests", async () => {
  const session = makeFakeSession("clean-delete");
  const gw = makeGateway(async () => session);

  (gw as any).sessions.set("clean-delete", {
    session,
    inFlightRequests: 0,
    lastActivityAt: Date.now(),
  });

  const req = fakeRequest({ method: "DELETE", url: "/mcp/clean-delete" });
  const { res, statusCode } = fakeResponse();
  await callHandle(gw, req, res);
  assert.equal(statusCode(), 204);
  assert.equal(gw.getActiveSessionCount(), 0, "Session must be removed after 204 DELETE.");
  assert.equal(session.isClosed, true, "Session must be closed after DELETE.");
});

// ---------------------------------------------------------------------------
// Idle session expiration
// ---------------------------------------------------------------------------

test("idle session sweeper: closes sessions idle beyond threshold, skips active ones", async () => {
  const idleSession = makeFakeSession("idle-one");
  const activeSession = makeFakeSession("active-one");
  const idleThreshold = 100; // 100 ms for testing

  const gw = makeGateway(async () => makeFakeSession(), {
    idleSessionTimeoutMs: idleThreshold,
  });

  const now = Date.now();
  // Inject idle session (last activity well past threshold)
  (gw as any).sessions.set("idle-one", {
    session: idleSession,
    inFlightRequests: 0,
    lastActivityAt: now - (idleThreshold + 1),
  });
  // Inject active session (last activity just now)
  (gw as any).sessions.set("active-one", {
    session: activeSession,
    inFlightRequests: 0,
    lastActivityAt: now,
  });

  // Run sweeper directly
  await (gw as any).sweepIdleSessions();

  assert.equal(idleSession.isClosed, true, "Idle session must be closed by sweeper.");
  assert.equal(activeSession.isClosed, false, "Active session must not be touched by sweeper.");
  assert.equal(gw.getActiveSessionCount(), 1, "Only active session remains.");
});

test("idle session sweeper: does not evict sessions with in-flight requests", async () => {
  const session = makeFakeSession("in-flight-idle");
  const idleThreshold = 100;
  const gw = makeGateway(async () => makeFakeSession(), {
    idleSessionTimeoutMs: idleThreshold,
  });
  // Session is old but has an in-flight request
  (gw as any).sessions.set("in-flight-idle", {
    session,
    inFlightRequests: 1,
    lastActivityAt: Date.now() - (idleThreshold + 1),
  });

  await (gw as any).sweepIdleSessions();

  assert.equal(session.isClosed, false, "Session with in-flight request must not be swept.");
  assert.equal(gw.getActiveSessionCount(), 1);
});

// ---------------------------------------------------------------------------
// Shutdown drains and closes sessions
// ---------------------------------------------------------------------------

test("stop: closes all sessions during shutdown", async () => {
  const session = makeFakeSession("shutdown-sess");
  const gw = makeGateway(async () => session);

  (gw as any).sessions.set("shutdown-sess", {
    session,
    inFlightRequests: 0,
    lastActivityAt: Date.now(),
  });
  (gw as any).isStopping = false;
  (gw as any).isRunning = true;

  // Skip the actual server binding; test only the cleanup path
  // by calling stop() without a real server
  (gw as any).server = { close: (cb: () => void) => cb() };

  await gw.stop();

  assert.equal(session.isClosed, true, "Session must be closed on gateway stop.");
  assert.equal(gw.getActiveSessionCount(), 0);
  assert.equal(gw.isStopped, true);
});

test("stop: idempotent — second call is a no-op", async () => {
  const gw = makeGateway(async () => makeFakeSession());
  (gw as any).isStopped = true;
  // Should not throw
  await gw.stop();
});
