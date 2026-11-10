import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpClientSession, type McpClientSession } from "../runtime/mcp-client-session.js";
import type { SharedBrowserRuntime } from "../runtime/shared-browser-runtime.js";
import { GatewaySecurity, GatewaySecurityError, type GatewayPrincipal } from "./gateway-security.js";

interface GatewaySession {
  id: string;
  readonly principal: GatewayPrincipal;
  readonly session: McpClientSession;
  readonly transport: StreamableHTTPServerTransport;
  lastActivityAt: number;
  activeRequests: number;
  closePromise?: Promise<void>;
}

export interface StreamableHttpGatewayOptions {
  runtime: SharedBrowserRuntime;
  security: GatewaySecurity;
  port?: number;
  maxRequestBytes?: number;
  maxSessions?: number;
  maxActiveRequests?: number;
  maxActiveRequestsPerSession?: number;
  idleSessionTimeoutMs?: number;
  idleSweepIntervalMs?: number;
  maxRequestBodyReceiveTimeoutMs?: number;
  gracefulDrainTimeoutMs?: number;
  now?: () => number;
}

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 32;
const MAX_ACTIVE_REQUESTS = 64;
const MAX_ACTIVE_REQUESTS_PER_SESSION = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_BODY_RECEIVE_TIMEOUT_MS = 10_000;
const DEFAULT_GRACEFUL_DRAIN_TIMEOUT_MS = 10_000;

export class GatewayShutdownTimeoutError extends Error {
  constructor(readonly activeRequestCount: number, readonly browserOperationPending: boolean) {
    super("Gateway shutdown timed out while work was still active. Browser ownership was retained; allow active work to finish, then retry close().");
    this.name = "GatewayShutdownTimeoutError";
  }
}

/** Stateful loopback MCP gateway. Each initialized principal receives a dedicated MCP server/transport. */
export class StreamableHttpGateway {
  private readonly runtime: SharedBrowserRuntime;
  private readonly security: GatewaySecurity;
  private readonly port: number;
  private readonly maxRequestBytes: number;
  private readonly maxSessions: number;
  private readonly maxActiveRequests: number;
  private readonly maxActiveRequestsPerSession: number;
  private readonly idleSessionTimeoutMs: number;
  private readonly idleSweepIntervalMs: number;
  private readonly maxRequestBodyReceiveTimeoutMs: number;
  private readonly gracefulDrainTimeoutMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly pendingSessionClosures = new Set<Promise<void>>();
  private server: Server | undefined;
  private idleSweepTimer: NodeJS.Timeout | undefined;
  private expectedHost: string | undefined;
  private reservedSessionSlots = 0;
  private closePromise: Promise<void> | undefined;
  private listenerClosePromise: Promise<void> | undefined;
  private activeRequests = 0;
  private closing = false;

  constructor(options: StreamableHttpGatewayOptions) {
    this.runtime = options.runtime;
    this.security = options.security;
    this.port = options.port ?? 0;
    this.maxRequestBytes = options.maxRequestBytes ?? MAX_REQUEST_BYTES;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.maxActiveRequests = options.maxActiveRequests ?? MAX_ACTIVE_REQUESTS;
    this.maxActiveRequestsPerSession = options.maxActiveRequestsPerSession ??
      Math.min(MAX_ACTIVE_REQUESTS_PER_SESSION, this.maxActiveRequests);
    this.idleSessionTimeoutMs = options.idleSessionTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.idleSweepIntervalMs = options.idleSweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxRequestBodyReceiveTimeoutMs = options.maxRequestBodyReceiveTimeoutMs ?? DEFAULT_BODY_RECEIVE_TIMEOUT_MS;
    this.gracefulDrainTimeoutMs = options.gracefulDrainTimeoutMs ?? DEFAULT_GRACEFUL_DRAIN_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    assertIntegerRange(this.port, 0, 65_535, "port");
    assertIntegerRange(this.maxRequestBytes, 1, MAX_REQUEST_BYTES, "maxRequestBytes");
    assertIntegerRange(this.maxSessions, 1, 10_000, "maxSessions");
    assertIntegerRange(this.maxActiveRequests, 1, 10_000, "maxActiveRequests");
    assertIntegerRange(this.maxActiveRequestsPerSession, 1, this.maxActiveRequests, "maxActiveRequestsPerSession");
    assertIntegerRange(this.idleSessionTimeoutMs, 1_000, 24 * 60 * 60_000, "idleSessionTimeoutMs");
    assertIntegerRange(this.idleSweepIntervalMs, 100, 60 * 60_000, "idleSweepIntervalMs");
    assertIntegerRange(this.maxRequestBodyReceiveTimeoutMs, 100, 10 * 60_000, "maxRequestBodyReceiveTimeoutMs");
    assertIntegerRange(this.gracefulDrainTimeoutMs, 0, 10 * 60_000, "gracefulDrainTimeoutMs");
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get activeRequestCount(): number {
    return this.activeRequests;
  }

  get listeningUrl(): string | undefined {
    const address = this.server?.address();
    return address && typeof address !== "string"
      ? `http://127.0.0.1:${address.port}/mcp`
      : undefined;
  }

  /** Starts only the HTTP listener; callers explicitly own when this method is invoked. */
  async start(): Promise<string> {
    if (this.closing) throw new Error("The MCP gateway is closing.");
    if (this.server) throw new Error("The MCP gateway has already been started.");
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
        rejectAndTerminateRequest(request, response, 500, { error: "Internal gateway error." });
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(this.port, "127.0.0.1", () => {
          server.off("error", onError);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    const address = server.address() as AddressInfo;
    this.expectedHost = `127.0.0.1:${address.port}`;
    this.idleSweepTimer = setInterval(() => {
      void this.sweepIdleSessions();
    }, this.idleSweepIntervalMs);
    this.idleSweepTimer.unref();
    return this.listeningUrl!;
  }

  /** Reaps only idle sessions with no active HTTP request. SSE disconnects alone do not delete a session. */
  async sweepIdleSessions(now = this.now()): Promise<number> {
    const expired = [...this.sessions.values()].filter((entry) =>
      entry.activeRequests === 0 && now - entry.lastActivityAt >= this.idleSessionTimeoutMs,
    );
    for (const entry of expired) await this.removeAndCloseSession(entry);
    return expired.length;
  }

  /** Stops accepting requests, closes client sessions, then closes the shared runtime exactly once. */
  close(): Promise<void> {
    if (!this.closePromise) {
      const closing = this.closeGateway();
      this.closePromise = closing;
      void closing.catch(() => {
        if (this.closePromise === closing) this.closePromise = undefined;
      });
    }
    return this.closePromise;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closing || !this.server) {
      rejectAndTerminateRequest(request, response, 503, { error: "MCP gateway is unavailable." });
      return;
    }
    if (this.activeRequests >= this.maxActiveRequests) {
      rejectAndTerminateRequest(request, response, 429, { error: "MCP gateway request capacity reached." });
      return;
    }
    this.activeRequests += 1;
    try {
      await this.routeRequest(request, response);
    } finally {
      this.activeRequests -= 1;
    }
  }

  private async routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== "/mcp") {
      rejectAndTerminateRequest(request, response, 404, { error: "Not found." });
      return;
    }
    let principal: GatewayPrincipal;
    try {
      const sessionHeader = request.headers["mcp-session-id"];
      const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;
      principal = await this.security.authenticateAndAuthorize(request, this.expectedHost!, sessionId);
    } catch (error) {
      this.sendSecurityError(request, response, error);
      return;
    }

    if (this.closing) {
      rejectAndTerminateRequest(request, response, 503, { error: "MCP gateway is shutting down." });
      return;
    }
    const sessionHeader = request.headers["mcp-session-id"];
    if (sessionHeader !== undefined && typeof sessionHeader !== "string") {
      rejectAndTerminateRequest(request, response, 400, { error: "Invalid MCP session header." });
      return;
    }
    if (typeof sessionHeader === "string") {
      await this.handleSessionRequest(request, response, principal, sessionHeader);
      return;
    }
    if (request.method !== "POST") {
      rejectAndTerminateRequest(request, response, 400, { error: "A session ID is required after initialization." });
      return;
    }
    await this.handleInitialization(request, response, principal);
  }

  private async handleInitialization(
    request: IncomingMessage,
    response: ServerResponse,
    principal: GatewayPrincipal,
  ): Promise<void> {
    if (this.sessions.size + this.reservedSessionSlots >= this.maxSessions) {
      rejectAndTerminateRequest(request, response, 429, { error: "MCP gateway session limit reached." });
      return;
    }
    this.reservedSessionSlots += 1;
    let slotTransferredToSession = false;
    try {
      const body = await readBoundedJsonBody(
        request,
        response,
        this.maxRequestBytes,
        this.maxRequestBodyReceiveTimeoutMs,
      );
      if (body === undefined) return;
      if (!isInitializationRequest(body)) {
        sendJson(response, 400, { error: "A valid MCP initialization request is required." });
        return;
      }
      if (this.closing) {
        sendJson(response, 503, { error: "MCP gateway is shutting down." });
        return;
      }

      let entry: GatewaySession | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        maxRequestBodySize: this.maxRequestBytes,
        onsessioninitialized: (id) => {
          if (!entry || this.closing || this.sessions.size >= this.maxSessions) {
            throw new Error("Session capacity changed during initialization.");
          }
          this.reservedSessionSlots -= 1;
          slotTransferredToSession = true;
          entry.id = id;
          entry.lastActivityAt = this.now();
          this.sessions.set(id, entry);
        },
        onsessionclosed: (id) => {
          const current = this.sessions.get(id);
          if (current) {
            this.sessions.delete(id);
            this.scheduleSessionClose(current);
          }
        },
      });
      const session = createMcpClientSession(this.runtime, transport, {
        serverName: "squarespace-mcp-gateway",
      });
      entry = {
        id: "",
        principal,
        session,
        transport,
        lastActivityAt: this.now(),
        activeRequests: 0,
      };
      await session.server.connect(transport);
      try {
        await transport.handleRequest(request, response, body);
      } finally {
        entry.activeRequests = 0;
        entry.lastActivityAt = this.now();
      }
      if (!entry.id) await this.closeSession(entry);
    } finally {
      if (!slotTransferredToSession) this.reservedSessionSlots -= 1;
    }
  }

  private async handleSessionRequest(
    request: IncomingMessage,
    response: ServerResponse,
    principal: GatewayPrincipal,
    sessionId: string,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.principal.id !== principal.id) {
      rejectAndTerminateRequest(request, response, 404, { error: "MCP session not found." });
      return;
    }
    if (!(request.method === "GET" || request.method === "POST" || request.method === "DELETE")) {
      rejectAndTerminateRequest(request, response, 405, { error: "HTTP method is not supported." });
      return;
    }
    if (entry.activeRequests >= this.maxActiveRequestsPerSession) {
      rejectAndTerminateRequest(request, response, 429, { error: "MCP session request capacity reached." });
      return;
    }
    try {
      entry.activeRequests += 1;
      entry.lastActivityAt = this.now();
      await entry.transport.handleRequest(request, response);
    } finally {
      entry.activeRequests = Math.max(0, entry.activeRequests - 1);
      entry.lastActivityAt = this.now();
    }
  }

  private async removeAndCloseSession(entry: GatewaySession): Promise<void> {
    if (this.sessions.get(entry.id) === entry) this.sessions.delete(entry.id);
    await this.closeSession(entry);
  }

  private closeSession(entry: GatewaySession): Promise<void> {
    entry.closePromise ??= entry.session.close();
    return entry.closePromise;
  }

  private scheduleSessionClose(entry: GatewaySession): void {
    let tracked: Promise<void>;
    tracked = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.closeSession(entry).catch(() => undefined).finally(() => {
          this.pendingSessionClosures.delete(tracked);
          resolve();
        });
      });
    });
    this.pendingSessionClosures.add(tracked);
  }

  private async closeGateway(): Promise<void> {
    this.closing = true;
    if (this.idleSweepTimer) clearInterval(this.idleSweepTimer);
    const server = this.server;
    if (!server) {
      const safeToClose = await this.waitForWorkToDrain(this.gracefulDrainTimeoutMs, []);
      if (!safeToClose) {
        throw new GatewayShutdownTimeoutError(this.activeRequests, !this.runtime.operationLock.isIdle);
      }
      await this.runtime.shutdown();
      return;
    }

    this.listenerClosePromise ??= new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const sessions = [...this.sessions.values()];
    for (const entry of sessions) entry.transport.closeStandaloneSSEStream();
    const drainComplete = await this.waitForWorkToDrain(
      this.gracefulDrainTimeoutMs,
      sessions,
    );
    if (!drainComplete) {
      throw new GatewayShutdownTimeoutError(
        this.activeRequests,
        !this.runtime.operationLock.isIdle,
      );
    }

    const finalSessions = [...this.sessions.values()];
    this.sessions.clear();
    let shutdownError: unknown;
    try {
      const closeResults = await Promise.allSettled(finalSessions.map((entry) => this.closeSession(entry)));
      const sessionFailure = closeResults.find((result) => result.status === "rejected");
      await Promise.all(this.pendingSessionClosures);
      await this.listenerClosePromise;
      if (sessionFailure?.status === "rejected") shutdownError = sessionFailure.reason;
    } catch (error) {
      shutdownError = error;
    } finally {
      try {
        await this.runtime.shutdown();
      } catch (error) {
        shutdownError ??= error;
      }
      this.server = undefined;
    }
    if (shutdownError) throw shutdownError;
  }

  private async waitForWorkToDrain(
    timeoutMs: number,
    sessions: readonly GatewaySession[],
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (
      this.activeRequests > 0 ||
      sessions.some((entry) => entry.activeRequests > 0) ||
      !this.runtime.operationLock.isIdle
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(remaining, 20));
    }
    return true;
  }

  private sendSecurityError(request: IncomingMessage, response: ServerResponse, error: unknown): void {
    if (error instanceof GatewaySecurityError) {
      if (error.statusCode === 401) response.setHeader("www-authenticate", "Bearer");
      rejectAndTerminateRequest(request, response, error.statusCode, { error: error.publicMessage });
      return;
    }
    rejectAndTerminateRequest(request, response, 500, { error: "Gateway security check failed." });
  }
}

function assertIntegerRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} through ${max}.`);
  }
}

function isInitializationRequest(body: unknown): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body) &&
    "method" in body && body.method === "initialize";
}

async function readBoundedJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  maximumBytes: number,
  receiveTimeoutMs: number,
): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => rejectBody(408, "Request body receive timed out."), receiveTimeoutMs);
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      response.off("close", onResponseClosed);
    };
    const finish = (body: unknown | undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(body);
    };
    const rejectBody = (status: number, message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.pause();
      rejectAndTerminateRequest(request, response, status, { error: message });
      resolve(undefined);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maximumBytes) {
        rejectBody(413, "Request body exceeds the configured limit.");
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        rejectBody(400, "Request body must contain valid JSON.");
      }
    };
    const onAborted = () => finish(undefined);
    const onError = () => finish(undefined);
    const onResponseClosed = () => {
      if (!response.writableFinished) {
        request.destroy();
        finish(undefined);
      }
    };

    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined) {
      if (typeof contentLength !== "string" || !/^\d+$/.test(contentLength)) {
        rejectBody(400, "Invalid Content-Length header.");
        return;
      }
      const declaredLength = Number(contentLength);
      if (!Number.isSafeInteger(declaredLength)) {
        rejectBody(400, "Invalid Content-Length header.");
        return;
      }
      if (declaredLength > maximumBytes) {
        rejectBody(413, "Request body exceeds the configured limit.");
        return;
      }
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
    response.once("close", onResponseClosed);
    request.resume();
  });
}

function rejectAndTerminateRequest(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  request.pause();
  response.setHeader("connection", "close");
  sendJson(response, statusCode, body);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
