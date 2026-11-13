import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySquarespaceAuthentication,
  waitForSquarespaceAuthentication,
  type SquarespaceAuthenticationSignals,
} from "./squarespace-authentication.js";

function signals(overrides: Partial<SquarespaceAuthenticationSignals> = {}): SquarespaceAuthenticationSignals {
  return {
    hostname: "account.squarespace.com",
    pathname: "/",
    loginFormVisible: false,
    dashboardEvidenceVisible: false,
    dashboardMarkerPresent: false,
    websiteCardCount: 0,
    ...overrides,
  };
}

test("recognizes an existing authenticated dashboard from its marker or website cards", () => {
  assert.equal(classifySquarespaceAuthentication(signals({ dashboardMarkerPresent: true })), "authenticated");
  assert.equal(classifySquarespaceAuthentication(signals({ websiteCardCount: 1 })), "authenticated");
});

test("recognizes explicit login redirects and visible login forms as logged out", () => {
  assert.equal(classifySquarespaceAuthentication(signals({ hostname: "login.squarespace.com" })), "not_logged_in");
  assert.equal(classifySquarespaceAuthentication(signals({ pathname: "/login/" })), "not_logged_in");
  assert.equal(classifySquarespaceAuthentication(signals({ loginFormVisible: true })), "not_logged_in");
});

test("treats a loading dashboard with temporarily missing selectors as pending", () => {
  assert.equal(classifySquarespaceAuthentication(signals()), "pending");
  assert.equal(classifySquarespaceAuthentication(signals({ dashboardEvidenceVisible: true })), "pending");
});

test("waits through dashboard loading and does not misclassify a restored session", async () => {
  let reads = 0;
  let clock = 0;
  const state = await waitForSquarespaceAuthentication(async () => {
    reads++;
    return reads < 3 ? signals() : signals({ websiteCardCount: 1 });
  }, {
    timeoutMs: 100,
    pollIntervalMs: 10,
    now: () => clock,
    delay: async (milliseconds) => { clock += milliseconds; },
  });
  assert.equal(state, "authenticated");
  assert.equal(reads, 3);
});

test("returns pending after the bounded authentication check rather than claiming logout", async () => {
  let clock = 0;
  const state = await waitForSquarespaceAuthentication(async () => signals(), {
    timeoutMs: 20,
    pollIntervalMs: 10,
    now: () => clock,
    delay: async (milliseconds) => { clock += milliseconds; },
  });
  assert.equal(state, "pending");
});

test("repeated authentication checks reuse the same successful session evidence", async () => {
  let reads = 0;
  const readSignals = async () => {
    reads++;
    return signals({ dashboardMarkerPresent: true });
  };
  const options = { timeoutMs: 20, pollIntervalMs: 5 };
  assert.equal(await waitForSquarespaceAuthentication(readSignals, options), "authenticated");
  assert.equal(await waitForSquarespaceAuthentication(readSignals, options), "authenticated");
  assert.equal(reads, 2);
});
