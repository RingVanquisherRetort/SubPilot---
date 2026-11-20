import assert from "node:assert/strict";
import { test } from "node:test";
import { createLifecycleLeaseGuard } from "./lifecycle-lease-guard.js";

test("lifecycle lease guard starts owned", () => {
  const guard = createLifecycleLeaseGuard();
  assert.equal(guard.isOwned(), true);
});

test("lifecycle lease guard stays lost after ownership is revoked", () => {
  const guard = createLifecycleLeaseGuard();
  guard.markLost();
  assert.equal(guard.isOwned(), false);
  guard.markLost();
  assert.equal(guard.isOwned(), false);
});
