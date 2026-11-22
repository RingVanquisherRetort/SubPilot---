import assert from "node:assert/strict";
import { test } from "node:test";
import { claimSubscriptionExpiry } from "./subscription-expiry-transition.js";

test("a concurrent renewal prevents expiry side effects and access revocation", async () => {
  let endsAt = new Date("2026-11-21T12:00:00.000Z");
  const now = new Date("2026-11-22T12:00:00.000Z");
  let revokeAccessCalls = 0;
  let enqueueExpiryNotificationCalls = 0;

  // Simulate a successful renewal committing after the worker's initial read,
  // but before its guarded UPDATE ... WHERE endsAt <= now is applied.
  const claimed = await claimSubscriptionExpiry(
    async () => {
      endsAt = new Date("2026-12-22T12:00:00.000Z");
      return { count: endsAt <= now ? 1 : 0 };
    },
    async () => { enqueueExpiryNotificationCalls += 1; }
  );

  if (claimed) revokeAccessCalls += 1;

  assert.equal(claimed, false);
  assert.equal(enqueueExpiryNotificationCalls, 0);
  assert.equal(revokeAccessCalls, 0);
});

test("expiry side effects run only after the conditional expiry update succeeds", async () => {
  let enqueueExpiryNotificationCalls = 0;
  const claimed = await claimSubscriptionExpiry(
    async () => ({ count: 1 }),
    async () => { enqueueExpiryNotificationCalls += 1; }
  );

  assert.equal(claimed, true);
  assert.equal(enqueueExpiryNotificationCalls, 1);
});
