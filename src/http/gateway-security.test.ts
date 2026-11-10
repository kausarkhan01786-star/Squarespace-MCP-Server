import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { constantTimeDigestEqual } from "./gateway-security.js";

test("credential digest comparison checks the stored candidate and safely handles unequal lengths", () => {
  const stored = createHash("sha256").update("stored-fixture-token").digest();
  const same = Buffer.from(stored);
  const different = createHash("sha256").update("other-fixture-token").digest();
  assert.equal(constantTimeDigestEqual(stored, same), true);
  assert.equal(constantTimeDigestEqual(stored, different), false);
  assert.equal(constantTimeDigestEqual(stored, Buffer.from([1, 2, 3])), false);
  assert.equal(constantTimeDigestEqual(Buffer.alloc(0), Buffer.alloc(0)), true);
});
