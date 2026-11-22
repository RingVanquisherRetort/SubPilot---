import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  acquireSubscriptionLifecycleLease,
  releaseSubscriptionLifecycleLease,
  renewSubscriptionLifecycleLease,
  SUBSCRIPTION_LIFECYCLE_LEASE_KEY
} from "./subscription-lifecycle-lease.js";

test("PostgreSQL lifecycle lease admits one worker and safely transfers ownership after expiry", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const firstLeaseId = randomUUID();
  const secondLeaseId = randomUUID();

  try {
    await prisma.workerLease.deleteMany({ where: { key: SUBSCRIPTION_LIFECYCLE_LEASE_KEY } });
    assert.equal(await acquireSubscriptionLifecycleLease(firstLeaseId), true);
    assert.equal(await acquireSubscriptionLifecycleLease(secondLeaseId), false);
    assert.equal(await renewSubscriptionLifecycleLease(firstLeaseId), true);

    await prisma.workerLease.update({
      where: { key: SUBSCRIPTION_LIFECYCLE_LEASE_KEY },
      data: { lockedUntil: new Date(0) }
    });

    assert.equal(await acquireSubscriptionLifecycleLease(secondLeaseId), true);
    assert.equal(await renewSubscriptionLifecycleLease(firstLeaseId), false);
    await releaseSubscriptionLifecycleLease(firstLeaseId);
    assert.equal(await renewSubscriptionLifecycleLease(secondLeaseId), true);

    // The optional key parameter must be honored by release as well as acquire/renew.
    const customKey = "subscription-lifecycle-test:" + randomUUID();
    assert.equal(await acquireSubscriptionLifecycleLease(firstLeaseId, customKey), true);
    await releaseSubscriptionLifecycleLease(firstLeaseId, customKey);
    assert.equal(await prisma.workerLease.findUnique({ where: { key: customKey } }), null);
  } finally {
    await releaseSubscriptionLifecycleLease(firstLeaseId);
    await releaseSubscriptionLifecycleLease(secondLeaseId);
    await prisma.$disconnect();
  }
});
