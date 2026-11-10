import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface GatewayPrincipal {
  readonly id: string;
  readonly scopes: readonly string[];
}

export interface ProvisionedGatewayCredential {
  /** Returned exactly once to the trusted provisioning caller; never log or expose to frontend JS. */
  readonly credential: string;
  readonly principal: GatewayPrincipal;
}

export interface GatewayAuthorizationContext {
  readonly principal: GatewayPrincipal;
  readonly request: IncomingMessage;
  readonly sessionId?: string;
}

export interface GatewaySecurityOptions {
  allowedOrigins?: readonly string[];
  authorizeRequest?: (context: GatewayAuthorizationContext) => boolean | Promise<boolean>;
}

export class GatewaySecurityError extends Error {
  constructor(
    readonly statusCode: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "GatewaySecurityError";
  }
}

/** In-memory credential authority. Persist issued credentials only in an OS-protected client store. */
export class GatewaySecurity {
  private readonly clientsByCredentialHash = new Map<string, GatewayPrincipal>();
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly authorizeRequest: NonNullable<GatewaySecurityOptions["authorizeRequest"]>;

  constructor(options: GatewaySecurityOptions = {}) {
    this.allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin));
    this.authorizeRequest = options.authorizeRequest ?? (() => true);
  }

  provisionClient(principal: GatewayPrincipal): ProvisionedGatewayCredential {
    const id = principal.id.trim();
    const scopes = [...new Set(principal.scopes.map((scope) => scope.trim()).filter(Boolean))];
    if (!id || scopes.length === 0 || this.findPrincipal(id)) {
      throw new TypeError("A unique client ID and at least one scope are required.");
    }
    const normalized = Object.freeze({ id, scopes: Object.freeze(scopes) });
    const credential = randomBytes(32).toString("base64url");
    this.clientsByCredentialHash.set(hashCredential(credential), normalized);
    return Object.freeze({ credential, principal: normalized });
  }

  revokeClient(clientId: string): void {
    for (const [digest, principal] of this.clientsByCredentialHash) {
      if (principal.id === clientId) this.clientsByCredentialHash.delete(digest);
    }
  }

  async authenticateAndAuthorize(
    request: IncomingMessage,
    expectedHost: string,
    sessionId?: string,
  ): Promise<GatewayPrincipal> {
    const host = request.headers.host;
    if (typeof host !== "string" || host.toLowerCase() !== expectedHost.toLowerCase()) {
      throw new GatewaySecurityError(403, "Request Host is not allowed.");
    }

    const origin = request.headers.origin;
    if (origin !== undefined) {
      let allowed = false;
      try {
        allowed = typeof origin === "string" && this.allowedOrigins.has(normalizeOrigin(origin));
      } catch {
        allowed = false;
      }
      if (!allowed) throw new GatewaySecurityError(403, "Request Origin is not allowed.");
    }

    const authorization = request.headers.authorization;
    const match = typeof authorization === "string"
      ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
      : null;
    if (!match) throw new GatewaySecurityError(401, "Valid bearer authentication is required.");

    const digest = hashCredential(match[1]!);
    const principal = this.findPrincipalForDigest(digest);
    if (!principal) {
      throw new GatewaySecurityError(401, "Valid bearer authentication is required.");
    }
    if (!principal.scopes.includes("mcp:connect")) {
      throw new GatewaySecurityError(403, "Client is not authorized to use the MCP gateway.");
    }
    if (!await this.authorizeRequest({ principal, request, ...(sessionId ? { sessionId } : {}) })) {
      throw new GatewaySecurityError(403, "Client is not authorized for this request.");
    }
    return principal;
  }

  private findPrincipal(clientId: string): GatewayPrincipal | undefined {
    return [...this.clientsByCredentialHash.values()].find((candidate) => candidate.id === clientId);
  }

  private findPrincipalForDigest(suppliedDigest: string): GatewayPrincipal | undefined {
    const supplied = Buffer.from(suppliedDigest, "hex");
    let match: GatewayPrincipal | undefined;
    for (const [storedDigest, principal] of this.clientsByCredentialHash) {
      if (constantTimeDigestEqual(supplied, Buffer.from(storedDigest, "hex"))) match = principal;
    }
    return match;
  }
}

export function constantTimeDigestEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  Buffer.from(left).copy(paddedLeft);
  Buffer.from(right).copy(paddedRight);
  const equal = timingSafeEqual(paddedLeft, paddedRight);
  return equal && left.byteLength === right.byteLength;
}

function normalizeOrigin(origin: string): string {
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== origin || parsed.username || parsed.password
    ) {
      throw new Error("invalid origin");
    }
    return parsed.origin;
  } catch {
    throw new TypeError("Allowed origins must be exact HTTP or HTTPS origins.");
  }
}

function hashCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}
