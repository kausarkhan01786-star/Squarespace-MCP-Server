import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { GatewaySecurity, type GatewaySecurityOptions } from "./gateway-security.js";
import type { McpClientSession } from "../runtime/mcp-client-session.js";
import { logError, logInfo } from "../utils/logger.js";

export interface StreamableHttpGatewayOptions {
  host?: string | undefined;
  port?: number | undefined;
  security?: GatewaySecurityOptions | undefined;
  drainTimeoutMs?: number | undefined;
  sessionFactory?: (() => Promise<McpClientSession>) | undefined;
  simulateShutdownFailure?: boolean | undefined;
  /** Maximum number of concurrent MCP sessions (default: 10). */
  maxGlobalSessions?: number | undefined;
  /** Maximum request body size in bytes (default: 1 MiB). */
  maxBodyBytes?: number | undefined;
  /** Maximum milliseconds to wait for the full request body (default: 10 000 ms). */
  bodyReceiveTimeoutMs?: number | undefined;
  /** Milliseconds of inactivity before an idle session is closed (default: 300 000 ms / 5 min). */
  idleSessionTimeoutMs?: number | undefined;
}

/** Internal wrapper that augments a McpClientSession with gateway-level bookkeeping. */
interface SessionEntry {
  session: McpClientSession;
  inFlightRequests: number;
  lastActivityAt: number;
}

export class StreamableHttpGateway {
  public readonly host: string;
  public readonly port: number;
  public readonly security: GatewaySecurity;
  public isRunning = false;
  public isStopped = false;
  private isStopping = false;
  private server: Server | undefined = undefined;
  private inFlightRequests = 0;
  private readonly drainTimeoutMs: number;
  private readonly maxGlobalSessions: number;
  private readonly maxBodyBytes: number;
  private readonly bodyReceiveTimeoutMs: number;
  private readonly idleSessionTimeoutMs: number;
  private readonly sessions = new Map<string, SessionEntry>();
  /** Number of sessions currently going through factory initialization. */
  private sessionsInitializing = 0;
  private sessionFactory: (() => Promise<McpClientSession>) | undefined;
  private idleSweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: StreamableHttpGatewayOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3000);
    this.security = new GatewaySecurity(options.security);
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5000;
    this.maxGlobalSessions = options.maxGlobalSessions ?? 10;
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576; // 1 MiB
    this.bodyReceiveTimeoutMs = options.bodyReceiveTimeoutMs ?? 10_000;
    this.idleSessionTimeoutMs = options.idleSessionTimeoutMs ?? 300_000; // 5 min
    this.sessionFactory = options.sessionFactory;
  }

  setSessionFactory(factory: () => Promise<McpClientSession>): void {
    this.sessionFactory = factory;
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const srv = createServer((req, res) => void this.handleRequest(req, res));
        this.server = srv;

        srv.on("error", (err) => {
          logError("http_gateway_server_error", err);
          if (!this.isRunning) {
            reject(err);
          }
        });

        // Strictly bind to loopback host
        srv.listen(this.port, this.host, () => {
          this.isRunning = true;
          this.isStopped = false;
          this.isStopping = false;
          this.startIdleSweep();
          logInfo("http_mcp_gateway_started", {
            host: this.host,
            port: this.port,
          });
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Idle-session sweeper
  // ---------------------------------------------------------------------------

  private startIdleSweep(): void {
    // Sweep every 60 s; idle threshold is configurable.
    const sweepIntervalMs = Math.min(60_000, Math.floor(this.idleSessionTimeoutMs / 2));
    this.idleSweepTimer = setInterval(() => {
      void this.sweepIdleSessions();
    }, sweepIntervalMs);
    // Don't prevent process exit
    this.idleSweepTimer.unref?.();
  }

  private async sweepIdleSessions(): Promise<void> {
    const now = Date.now();
    const toClose: Array<[string, SessionEntry]> = [];

    for (const [id, entry] of this.sessions.entries()) {
      if (
        entry.inFlightRequests === 0 &&
        now - entry.lastActivityAt >= this.idleSessionTimeoutMs
      ) {
        toClose.push([id, entry]);
      }
    }

    for (const [id, entry] of toClose) {
      this.sessions.delete(id);
      try {
        await entry.session.close();
      } catch (err) {
        logError("mcp_idle_session_close_error", err, { sessionId: id });
      }
      logInfo("mcp_idle_session_expired", { sessionId: id });
    }
  }

  // ---------------------------------------------------------------------------
  // Request body reader with size cap + receive timeout
  // ---------------------------------------------------------------------------

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      // Check Content-Length up front
      const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
      if (!isNaN(contentLength) && contentLength > this.maxBodyBytes) {
        req.destroy();
        reject(Object.assign(new Error("Request body too large."), { code: "BODY_TOO_LARGE" }));
        return;
      }

      const chunks: Buffer[] = [];
      let bytesReceived = 0;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(Object.assign(new Error("Request body receive timeout."), { code: "BODY_TIMEOUT" }));
      }, this.bodyReceiveTimeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
      };

      req.on("data", (chunk: Buffer) => {
        bytesReceived += chunk.length;
        if (bytesReceived > this.maxBodyBytes) {
          if (settled) return;
          settled = true;
          cleanup();
          req.destroy();
          reject(Object.assign(new Error("Request body too large."), { code: "BODY_TOO_LARGE" }));
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Buffer.concat(chunks));
      });

      req.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      req.on("aborted", () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(Object.assign(new Error("Request aborted by client."), { code: "BODY_ABORTED" }));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Request handler
  // ---------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.inFlightRequests++;
    try {
      if (this.isStopping) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "SERVICE_UNAVAILABLE", message: "Gateway is shutting down." }));
        return;
      }

      if (!this.security.authorizeRequest(req, res)) {
        return;
      }

      const url = req.url ?? "/";

      if (url === "/health" || url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            activeSessions: this.sessions.size,
            sessionsInitializing: this.sessionsInitializing,
            inFlightRequests: this.inFlightRequests,
          }),
        );
        return;
      }

      // DELETE /mcp/:sessionId — explicit session teardown
      if (req.method === "DELETE" && url.startsWith("/mcp/")) {
        const sessionId = url.slice(5); // strip "/mcp/"
        const entry = this.sessions.get(sessionId);
        if (!entry) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "NOT_FOUND", message: "Session not found." }));
          return;
        }
        if (entry.inFlightRequests > 0) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "CONFLICT", message: "Session has in-flight requests." }));
          return;
        }
        this.sessions.delete(sessionId);
        try {
          await entry.session.close();
        } catch (err) {
          logError("mcp_session_delete_close_error", err, { sessionId });
        }
        res.writeHead(204);
        res.end();
        return;
      }

      // POST /mcp — session creation or request routing
      if (url === "/mcp" || url.startsWith("/mcp/")) {
        const clientSessionId = req.headers["mcp-session-id"] as string | undefined;

        // Look up an existing session by the client-supplied ID.
        let entry = clientSessionId ? this.sessions.get(clientSessionId) : undefined;

        if (!entry) {
          // New session: check admission limit atomically BEFORE creating
          if (this.sessions.size + this.sessionsInitializing >= this.maxGlobalSessions) {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "TOO_MANY_SESSIONS",
                message: `Maximum concurrent sessions (${this.maxGlobalSessions}) reached.`,
              }),
            );
            return;
          }

          if (!this.sessionFactory) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "SERVICE_UNAVAILABLE", message: "Session factory not configured." }));
            return;
          }

          // Atomically reserve a slot
          this.sessionsInitializing++;
          let newSession: McpClientSession;
          try {
            newSession = await this.sessionFactory();
          } catch (factoryErr) {
            this.sessionsInitializing--;
            throw factoryErr; // surfaces as 500
          }
          this.sessionsInitializing--;

          entry = {
            session: newSession,
            inFlightRequests: 0,
            lastActivityAt: Date.now(),
          };
          this.sessions.set(newSession.sessionId, entry);
        }

        // Track in-flight request for this specific session
        entry.inFlightRequests++;
        entry.lastActivityAt = Date.now();
        try {
          // Read and validate the request body for POST requests
          if (req.method === "POST") {
            let _body: Buffer;
            try {
              _body = await this.readBody(req);
            } catch (bodyErr: any) {
              if (bodyErr?.code === "BODY_TOO_LARGE") {
                if (!res.headersSent) {
                  res.writeHead(413, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the allowed limit." }));
                }
                return;
              }
              if (bodyErr?.code === "BODY_TIMEOUT") {
                if (!res.headersSent) {
                  res.writeHead(408, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "REQUEST_TIMEOUT", message: "Timed out waiting for request body." }));
                }
                return;
              }
              if (bodyErr?.code === "BODY_ABORTED") {
                // Client disconnected; nothing to respond to
                return;
              }
              throw bodyErr;
            }
            // Body successfully read; in a real MCP integration the SDK would process it here.
            // We hand it back to the response for the stub reply.
            void _body; // used by real integration; stub responds below
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "connected",
              sessionId: entry.session.sessionId,
            }),
          );
        } finally {
          entry.lastActivityAt = Date.now();
          entry.inFlightRequests = Math.max(0, entry.inFlightRequests - 1);
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "NOT_FOUND", message: "Endpoint not found." }));
    } catch (err: any) {
      logError("http_gateway_request_error", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "INTERNAL_ERROR", message: err?.message || "Internal error." }));
      }
    } finally {
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  async stop(): Promise<void> {
    if (this.isStopped) {
      return;
    }

    if (this.options.simulateShutdownFailure) {
      throw new Error("Simulated HTTP gateway shutdown failure.");
    }

    this.isStopping = true;

    // Stop the idle sweeper
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = undefined;
    }

    logInfo("http_mcp_gateway_stopping", {
      activeSessions: this.sessions.size,
      inFlightRequests: this.inFlightRequests,
    });

    // 1. Drain active in-flight requests (bounded wait)
    const drainDeadline = Date.now() + this.drainTimeoutMs;
    while (this.inFlightRequests > 0 && Date.now() < drainDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // 2. Close active MCP sessions
    for (const [id, entry] of this.sessions.entries()) {
      try {
        await entry.session.close();
      } catch (err) {
        logError("mcp_session_close_error", err, { sessionId: id });
      }
    }
    this.sessions.clear();

    // 3. Close the HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
    }

    this.isRunning = false;
    this.isStopped = true;
    logInfo("http_mcp_gateway_stopped");
  }
}
