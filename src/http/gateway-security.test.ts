/**
 * Focused regression tests for GatewaySecurity (Phase 3C.3).
 *
 * Tests:
 *  - isLoopbackAddress: IPv4, IPv6, 127.x.x.x range, negatives
 *  - isAllowedHost: plain IPv4, IPv4+port, localhost, localhost+port,
 *                   IPv6 literal "[::1]", IPv6 literal+port "[::1]:3000",
 *                   negative cases
 *  - isAllowedOrigin: loopback origins pass, cross-origin fails, missing origin passes
 *  - Bearer token: exact match passes, length mismatch fails, content mismatch fails,
 *                  missing header 401, malformed header 401
 *  - authorizeRequest: 403 on remote IP, 403 on bad host, 403 on bad origin,
 *                      401 on missing token, 200 on valid request
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { GatewaySecurity } from "./gateway-security.js";

// ---------------------------------------------------------------------------
// Minimal fakes for IncomingMessage / ServerResponse
// ---------------------------------------------------------------------------

function fakeResponse(): { res: ServerResponse; statusCode: () => number; body: () => string } {
  let _status = 0;
  let _body = "";
  const res = {
    headersSent: false,
    writeHead(code: number) {
      _status = code;
      this.headersSent = true;
    },
    end(data?: string) {
      _body = data ?? "";
    },
  } as unknown as ServerResponse;
  return { res, statusCode: () => _status, body: () => _body };
}

function fakeRequest(opts: {
  remoteAddress?: string;
  host?: string;
  origin?: string;
  authorization?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  // Default to a valid loopback host so bearer-token tests don't fail at the Host check
  const resolvedHost = opts.host !== undefined ? opts.host : "localhost";
  headers["host"] = resolvedHost;
  if (opts.origin !== undefined) headers["origin"] = opts.origin;
  if (opts.authorization !== undefined) headers["authorization"] = opts.authorization;

  const socket = new EventEmitter() as any;
  socket.remoteAddress = opts.remoteAddress ?? "127.0.0.1";

  return {
    socket,
    headers,
  } as unknown as IncomingMessage;
}

// ---------------------------------------------------------------------------
// isLoopbackAddress
// ---------------------------------------------------------------------------

test("isLoopbackAddress: 127.0.0.1 is loopback", () => {
  const sec = new GatewaySecurity();
  assert.equal(sec.isLoopbackAddress("127.0.0.1"), true);
});

test("isLoopbackAddress: ::1 is loopback", () => {
  const sec = new GatewaySecurity();
  assert.equal(sec.isLoopbackAddress("::1"), true);
});

test("isLoopbackAddress: ::ffff:127.0.0.1 is loopback", () => {
  const sec = new GatewaySecurity();
  assert.equal(sec.isLoopbackAddress("::ffff:127.0.0.1"), true);
});

test("isLoopbackAddress: 127.100.0.1 is loopback (127.x.x.x range)", () => {
  const sec = new GatewaySecurity();
  assert.equal(sec.isLoopbackAddress("127.100.0.1"), true);
});

test("isLoopbackAddress: 192.168.1.1 is not loopback", () => {
  const sec = new GatewaySecurity();
  assert.equal(sec.isLoopbackAddress("192.168.1.1"), false);
});

test("isLoopbackAddress: undefined is not loopback", () => {
  const sec = new GatewaySecurity();
  assert.equal(sec.isLoopbackAddress(undefined), false);
});

// ---------------------------------------------------------------------------
// isAllowedHost
// ---------------------------------------------------------------------------

test("isAllowedHost: '127.0.0.1' passes", () => {
  assert.equal(new GatewaySecurity().isAllowedHost("127.0.0.1"), true);
});

test("isAllowedHost: '127.0.0.1:3000' passes", () => {
  assert.equal(new GatewaySecurity().isAllowedHost("127.0.0.1:3000"), true);
});

test("isAllowedHost: 'localhost' passes (allowLocalhostHostHeader default true)", () => {
  assert.equal(new GatewaySecurity().isAllowedHost("localhost"), true);
});

test("isAllowedHost: 'localhost:3000' passes", () => {
  assert.equal(new GatewaySecurity().isAllowedHost("localhost:3000"), true);
});

test("isAllowedHost: '[::1]' passes (IPv6 literal, no port)", () => {
  assert.equal(new GatewaySecurity().isAllowedHost("[::1]"), true);
});

test("isAllowedHost: '[::1]:3000' passes (IPv6 literal with port)", () => {
  assert.equal(new GatewaySecurity().isAllowedHost("[::1]:3000"), true);
});

test("isAllowedHost: '[::1]:' passes (IPv6 literal with empty port)", () => {
  // Colon after bracket should still strip correctly
  assert.equal(new GatewaySecurity().isAllowedHost("[::1]:"), true);
});

test("isAllowedHost: 'evil.com' is rejected", () => {
  assert.equal(new GatewaySecurity().isAllowedHost("evil.com"), false);
});

test("isAllowedHost: '[::2]' is rejected (non-loopback IPv6)", () => {
  assert.equal(new GatewaySecurity().isAllowedHost("[::2]"), false);
});

test("isAllowedHost: '192.168.1.1' is rejected", () => {
  assert.equal(new GatewaySecurity().isAllowedHost("192.168.1.1"), false);
});

test("isAllowedHost: empty string is rejected", () => {
  assert.equal(new GatewaySecurity().isAllowedHost(""), false);
});

test("isAllowedHost: undefined is rejected", () => {
  assert.equal(new GatewaySecurity().isAllowedHost(undefined), false);
});

test("isAllowedHost: 'localhost' rejected when allowLocalhostHostHeader is false", () => {
  const sec = new GatewaySecurity({ allowLocalhostHostHeader: false });
  assert.equal(sec.isAllowedHost("localhost"), false);
});

// ---------------------------------------------------------------------------
// isAllowedOrigin
// ---------------------------------------------------------------------------

test("isAllowedOrigin: undefined passes (non-browser client)", () => {
  assert.equal(new GatewaySecurity().isAllowedOrigin(undefined), true);
});

test("isAllowedOrigin: 'http://localhost:3000' passes", () => {
  assert.equal(new GatewaySecurity().isAllowedOrigin("http://localhost:3000"), true);
});

test("isAllowedOrigin: 'http://127.0.0.1:3000' passes", () => {
  assert.equal(new GatewaySecurity().isAllowedOrigin("http://127.0.0.1:3000"), true);
});

test("isAllowedOrigin: 'http://[::1]:3000' passes", () => {
  assert.equal(new GatewaySecurity().isAllowedOrigin("http://[::1]:3000"), true);
});

test("isAllowedOrigin: 'https://evil.com' is rejected", () => {
  assert.equal(new GatewaySecurity().isAllowedOrigin("https://evil.com"), false);
});

test("isAllowedOrigin: malformed origin string is rejected", () => {
  assert.equal(new GatewaySecurity().isAllowedOrigin("not-a-url"), false);
});

// ---------------------------------------------------------------------------
// Bearer token: timing-safe comparison
// ---------------------------------------------------------------------------

test("bearer token: correct token passes", () => {
  const sec = new GatewaySecurity({ authToken: "secret-token" });
  const req = fakeRequest({ host: "localhost", authorization: "Bearer secret-token" });
  const { res, statusCode } = fakeResponse();
  const result = sec.authorizeRequest(req, res);
  assert.equal(result, true);
  assert.equal(statusCode(), 0, "No error response should be written on success.");
});

test("bearer token: wrong content (same length) is rejected", () => {
  const sec = new GatewaySecurity({ authToken: "AAAAAAAAAAAA" });
  const req = fakeRequest({ host: "localhost", authorization: "Bearer BBBBBBBBBBBB" });
  const { res, statusCode } = fakeResponse();
  const result = sec.authorizeRequest(req, res);
  assert.equal(result, false);
  assert.equal(statusCode(), 401);
});

test("bearer token: wrong length is rejected immediately", () => {
  const sec = new GatewaySecurity({ authToken: "short" });
  const req = fakeRequest({ host: "localhost", authorization: "Bearer much-longer-token-value" });
  const { res, statusCode } = fakeResponse();
  const result = sec.authorizeRequest(req, res);
  assert.equal(result, false);
  assert.equal(statusCode(), 401);
});

test("bearer token: empty candidate is rejected when token is configured", () => {
  const sec = new GatewaySecurity({ authToken: "my-token" });
  const req = fakeRequest({ host: "localhost", authorization: "Bearer " }); // .trim() → empty
  const { res, statusCode } = fakeResponse();
  const result = sec.authorizeRequest(req, res);
  assert.equal(result, false);
  assert.equal(statusCode(), 401);
});

test("bearer token: missing Authorization header returns 401", () => {
  const sec = new GatewaySecurity({ authToken: "token" });
  const req = fakeRequest({ host: "localhost" }); // no authorization header
  const { res, statusCode } = fakeResponse();
  const result = sec.authorizeRequest(req, res);
  assert.equal(result, false);
  assert.equal(statusCode(), 401);
});

test("bearer token: malformed Authorization header (no Bearer prefix) returns 401", () => {
  const sec = new GatewaySecurity({ authToken: "token" });
  const req = fakeRequest({ host: "localhost", authorization: "Basic dXNlcjpwYXNz" });
  const { res, statusCode } = fakeResponse();
  const result = sec.authorizeRequest(req, res);
  assert.equal(result, false);
  assert.equal(statusCode(), 401);
});

test("bearer token: no token configured means any request passes token check", () => {
  const sec = new GatewaySecurity({}); // no authToken
  const req = fakeRequest({ host: "localhost" }); // no Authorization header either
  const { res, statusCode } = fakeResponse();
  const result = sec.authorizeRequest(req, res);
  assert.equal(result, true);
  assert.equal(statusCode(), 0);
});

// ---------------------------------------------------------------------------
// authorizeRequest: full pipeline
// ---------------------------------------------------------------------------

test("authorizeRequest: remote IP not loopback returns 403", () => {
  const sec = new GatewaySecurity();
  const req = fakeRequest({ remoteAddress: "10.0.0.1", host: "localhost" });
  const { res, statusCode } = fakeResponse();
  assert.equal(sec.authorizeRequest(req, res), false);
  assert.equal(statusCode(), 403);
});

test("authorizeRequest: bad Host header returns 403", () => {
  const sec = new GatewaySecurity();
  const req = fakeRequest({ remoteAddress: "127.0.0.1", host: "attacker.com" });
  const { res, statusCode } = fakeResponse();
  assert.equal(sec.authorizeRequest(req, res), false);
  assert.equal(statusCode(), 403);
});

test("authorizeRequest: cross-origin returns 403", () => {
  const sec = new GatewaySecurity();
  const req = fakeRequest({
    remoteAddress: "127.0.0.1",
    host: "localhost",
    origin: "https://attacker.com",
  });
  const { res, statusCode } = fakeResponse();
  assert.equal(sec.authorizeRequest(req, res), false);
  assert.equal(statusCode(), 403);
});

test("authorizeRequest: valid IPv4 loopback request passes", () => {
  const sec = new GatewaySecurity();
  const req = fakeRequest({ remoteAddress: "127.0.0.1", host: "127.0.0.1:3000" });
  const { res, statusCode } = fakeResponse();
  assert.equal(sec.authorizeRequest(req, res), true);
  assert.equal(statusCode(), 0);
});

test("authorizeRequest: valid IPv6 loopback request passes", () => {
  const sec = new GatewaySecurity();
  const req = fakeRequest({ remoteAddress: "::1", host: "[::1]:3000" });
  const { res, statusCode } = fakeResponse();
  assert.equal(sec.authorizeRequest(req, res), true);
  assert.equal(statusCode(), 0);
});
