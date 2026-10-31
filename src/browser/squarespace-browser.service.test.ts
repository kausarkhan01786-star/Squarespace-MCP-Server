import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAuthenticatedSquarespaceDashboard,
  type AuthenticationSignals,
} from "./squarespace-browser.service.js";

function signals(
  overrides: Partial<AuthenticationSignals> = {},
): AuthenticationSignals {
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

test("detects an authenticated dashboard from visible website cards", () => {
  assert.equal(
    isAuthenticatedSquarespaceDashboard(signals({ websiteCardCount: 2 })),
    true,
  );
});

test("detects an authenticated dashboard from the observed dashboard marker", () => {
  assert.equal(
    isAuthenticatedSquarespaceDashboard(
      signals({ dashboardMarkerPresent: true }),
    ),
    true,
  );
});

test("does not mistake generic dashboard text during loading for authentication", () => {
  assert.equal(
    isAuthenticatedSquarespaceDashboard(
      signals({ dashboardEvidenceVisible: true }),
    ),
    false,
  );
});

test("rejects login forms and sign-in URLs as unauthenticated", () => {
  assert.equal(
    isAuthenticatedSquarespaceDashboard(
      signals({ loginFormVisible: true, websiteCardCount: 1 }),
    ),
    false,
  );
  assert.equal(
    isAuthenticatedSquarespaceDashboard(
      signals({ pathname: "/login", dashboardMarkerPresent: true }),
    ),
    false,
  );
});

test("rejects unrelated hosts and pages without dashboard evidence", () => {
  assert.equal(
    isAuthenticatedSquarespaceDashboard(
      signals({ hostname: "example.com", websiteCardCount: 1 }),
    ),
    false,
  );
  assert.equal(isAuthenticatedSquarespaceDashboard(signals()), false);
});
