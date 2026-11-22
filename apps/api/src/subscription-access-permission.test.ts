import assert from "node:assert/strict";
import { test } from "node:test";
import { isSubscriptionAccessPermissionActive } from "./subscription-access-permission.js";

const now = new Date("2026-11-22T12:00:00.000Z");
const activeSubscription = {
  subscriptionStatus: "ACTIVE",
  subscriptionStartsAt: new Date("2026-11-01T00:00:00.000Z"),
  subscriptionEndsAt: new Date("2026-12-01T00:00:00.000Z"),
  grantRevokedAt: null
};

test("an active subscription and an explicitly active chat grant permit invite delivery", () => {
  assert.equal(isSubscriptionAccessPermissionActive(activeSubscription, now), true);
});

test("a revoked chat grant blocks invite delivery even while its subscription is active", () => {
  assert.equal(isSubscriptionAccessPermissionActive({
    ...activeSubscription,
    grantRevokedAt: new Date("2026-11-22T11:59:00.000Z")
  }, now), false);
});

test("a missing chat grant fails closed", () => {
  assert.equal(isSubscriptionAccessPermissionActive({
    ...activeSubscription,
    grantRevokedAt: undefined
  }, now), false);
});

test("cancelled or expired subscriptions do not authorize a chat grant", () => {
  assert.equal(isSubscriptionAccessPermissionActive({
    ...activeSubscription,
    subscriptionStatus: "CANCELLED"
  }, now), false);
  assert.equal(isSubscriptionAccessPermissionActive({
    ...activeSubscription,
    subscriptionEndsAt: new Date(now.getTime())
  }, now), false);
});

test("future subscriptions do not authorize early invite delivery", () => {
  assert.equal(isSubscriptionAccessPermissionActive({
    ...activeSubscription,
    subscriptionStartsAt: new Date(now.getTime() + 1)
  }, now), false);
});
