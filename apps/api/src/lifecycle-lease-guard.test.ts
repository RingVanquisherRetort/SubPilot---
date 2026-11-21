import assert from "node:assert/strict";
import { test } from "node:test";
import { createLifecycleLeaseGuard, startLifecycleLeaseHeartbeat } from "./lifecycle-lease-guard.js";

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


test("lifecycle heartbeat never overlaps renewal calls", async () => {
  let calls = 0;
  let resolveRenewal: ((value: boolean) => void) | undefined;
  const heartbeat = startLifecycleLeaseHeartbeat({
    intervalMs: 5,
    renew: () => {
      calls++;
      return new Promise<boolean>((resolve) => { resolveRenewal = resolve; });
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 24));
  assert.equal(calls, 1);
  resolveRenewal?.(true);
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(calls, 2);
  heartbeat.stop();
});

test("lifecycle heartbeat permanently fails closed after a rejected renewal", async () => {
  let calls = 0;
  const reasons: string[] = [];
  const heartbeat = startLifecycleLeaseHeartbeat({
    intervalMs: 5,
    renew: async () => { calls++; throw new Error("database unavailable"); },
    onLost: (reason) => reasons.push(reason)
  });
  await new Promise((resolve) => setTimeout(resolve, 24));
  assert.equal(heartbeat.isOwned(), false);
  assert.equal(calls, 1);
  assert.deepEqual(reasons, ["RENEWAL_ERROR"]);
  heartbeat.stop();
});
