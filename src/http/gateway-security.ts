import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface GatewaySecurityOptions {
  authToken?: string | undefined;
  allowLocalhostHostHeader?: boolean | undefined;
}

export class GatewaySecurity {
  private readonly authToken: Buffer | undefined;
  private readonly allowLocalhost: boolean;

  constructor(options: GatewaySecurityOptions = {}) {
    const rawToken = options.authToken ?? process.env.MCP_GATEWAY_TOKEN?.trim() ?? undefined;
    // Store as Buffer for timing-safe comparison; undefined when no token is configured.
    this.authToken = rawToken !== undefined ? Buffer.from(rawToken, "utf8") : undefined;
    this.allowLocalhost = options.allowLocalhostHostHeader ?? true;
  }

  isLoopbackAddress(ip: string | undefined): boolean {
    if (!ip) return false;
    return (
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip === "::ffff:127.0.0.1" ||
      ip.startsWith("127.")
    );
  }

  /**
   * Parse the hostname from a Host header value.
   *
   * Handles:
   *   "127.0.0.1"          → "127.0.0.1"
   *   "127.0.0.1:3000"     → "127.0.0.1"
   *   "localhost"          → "localhost"
   *   "localhost:3000"     → "localhost"
   *   "[::1]"              → "::1"
   *   "[::1]:3000"         → "::1"
   */
  private parseHostname(host: string): string {
    // IPv6 literal: starts with "["
    if (host.startsWith("[")) {
      const closingBracket = host.indexOf("]");
      if (closingBracket === -1) return host; // malformed — return as-is (will fail isAllowedHost)
      return host.slice(1, closingBracket).toLowerCase();
    }
    // IPv4 or hostname — take the part before the first ":"
    const colon = host.indexOf(":");
    return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
  }

  isAllowedHost(host: string | undefined): boolean {
    if (!host) return false;
    const hostname = this.parseHostname(host);
    if (hostname === "127.0.0.1") return true;
    if (hostname === "::1") return true;
    if (this.allowLocalhost && hostname === "localhost") return true;
    return false;
  }

  isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true; // Direct non-browser clients (curl, IDEs) often omit Origin
    try {
      const parsed = new URL(origin);
      return this.isAllowedHost(parsed.host);
    } catch {
      return false;
    }
  }

  /**
   * Compare a candidate bearer token against the configured authToken in constant time.
   *
   * Returns false immediately (without comparing bytes) when lengths differ — this avoids a
   * length-based timing oracle while remaining safe because length is not a secret once you
   * know the constant-time comparison is skipped.
   */
  private isValidToken(candidate: string): boolean {
    if (!this.authToken) return true; // No token configured: always valid
    const candidateBuf = Buffer.from(candidate, "utf8");
    if (candidateBuf.length !== this.authToken.length) return false;
    return timingSafeEqual(candidateBuf, this.authToken);
  }

  authorizeRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const remoteIp = req.socket.remoteAddress;
    if (!this.isLoopbackAddress(remoteIp)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "FORBIDDEN",
          message: "Access is strictly limited to local loopback connections.",
        }),
      );
      return false;
    }

    const host = req.headers.host;
    if (!this.isAllowedHost(host)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "FORBIDDEN_HOST",
          message: "Host header must resolve to loopback address (127.0.0.1, ::1, or localhost).",
        }),
      );
      return false;
    }

    const origin = req.headers.origin;
    if (origin && !this.isAllowedOrigin(origin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "FORBIDDEN_ORIGIN",
          message: "Cross-origin requests from non-loopback origins are rejected.",
        }),
      );
      return false;
    }

    if (this.authToken) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "UNAUTHORIZED",
            message: "Missing or malformed Authorization Bearer header.",
          }),
        );
        return false;
      }
      const candidate = authHeader.slice(7).trim();
      if (!this.isValidToken(candidate)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "UNAUTHORIZED",
            message: "Invalid gateway authorization token.",
          }),
        );
        return false;
      }
    }

    return true;
  }
}
