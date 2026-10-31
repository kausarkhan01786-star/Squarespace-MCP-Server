import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertAllowedSquarespaceUrl,
  isAllowedSquarespaceUrl,
  redactUrl,
  resolveProfileDirectory,
} from "./browser-security.js";

test("allows HTTPS Squarespace domains and subdomains", () => {
  assert.equal(isAllowedSquarespaceUrl("https://account.squarespace.com/"), true);
  assert.equal(isAllowedSquarespaceUrl("https://my-site.squarespace.com/config"), true);
});

test("rejects non-Squarespace, insecure, and credential-bearing URLs", () => {
  assert.equal(isAllowedSquarespaceUrl("http://account.squarespace.com/"), false);
  assert.equal(isAllowedSquarespaceUrl("https://squarespace.com.example.org/"), false);
  assert.equal(isAllowedSquarespaceUrl("https://example.org/"), false);
  assert.equal(isAllowedSquarespaceUrl("https://user:pass@squarespace.com/"), false);
  assert.throws(() => assertAllowedSquarespaceUrl("https://example.org/"), {
    code: "INVALID_URL",
  });
});

test("removes query strings and fragments before exposing URLs", () => {
  assert.equal(
    redactUrl("https://account.squarespace.com/websites?id=private#section"),
    "https://account.squarespace.com/websites",
  );
});

test("rejects project-local browser profiles", () => {
  assert.throws(() => resolveProfileDirectory("browser-profile", "C:\\workspace\\project"), {
    code: "PROFILE_DIRECTORY_UNSAFE",
  });
  assert.throws(
    () => resolveProfileDirectory("C:\\workspace\\project\\browser-profile", "C:\\workspace\\project"),
    { code: "PROFILE_DIRECTORY_UNSAFE" },
  );
  assert.equal(
    resolveProfileDirectory("C:\\Users\\user\\AppData\\Local\\squarespace-profile", "C:\\workspace\\project"),
    "C:\\Users\\user\\AppData\\Local\\squarespace-profile",
  );
});
