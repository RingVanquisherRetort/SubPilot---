import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { prisma } from "@subpilot/database";
import {
  acquireSubscriptionLifecycleLease,
  releaseSubscriptionLifecycleLease,
  renewSubscriptionLifecycleLease
} from "./subscription-lifecycle-lease.js";
import { runLifecyclePassWithLease } from "./subscription-lifecycle-runner.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("lifecycle pass stops after lease loss during a stage and cannot release a successor lease", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const key = "subscription-lifecycle-test:" + randomUUID();
  const firstLeaseId = randomUUID();
  const successorLeaseId = randomUUID();
  let laterStageStarted = false;
  let lossReason: string | undefined;

  try {
    const completed = await runLifecyclePassWithLease({
      leaseId: firstLeaseId,
      heartbeatMs: 5,
      acquire: (id) => acquireSubscriptionLifecycleLease(id, key),
      renew: (id) => renewSubscriptionLifecycleLease(id, key),
      release: (id) => releaseSubscriptionLifecycleLease(id, key),
      onLeaseLost: (reason) => { lossReason = reason; },
      stages: [
        async () => {
          // Simulate a paused/partitioned worker whose lease expires while the
          // current stage is in flight. A second replica legitimately takes it.
          await prisma.workerLease.update({
            where: { key },
            data: { lockedUntil: new Date(0) }
          });
          assert.equal(await acquireSubscriptionLifecycleLease(successorLeaseId, key), true);
          await delay(30);
        },
        async () => { laterStageStarted = true; }
      ]
    });

    assert.equal(completed, false);
    assert.equal(laterStageStarted, false);
    assert.equal(lossReason, "NOT_OWNER");

    // The stale worker's finally block must not delete the successor's lease.
    assert.equal(await renewSubscriptionLifecycleLease(successorLeaseId, key), true);
  } finally {
    await releaseSubscriptionLifecycleLease(firstLeaseId, key);
    await releaseSubscriptionLifecycleLease(successorLeaseId, key);
    await prisma.workerLease.deleteMany({ where: { key } });
  }
});

test("lifecycle pass does not start when another replica owns the lease", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const key = "subscription-lifecycle-test:" + randomUUID();
  const owner = randomUUID();
  const contender = randomUUID();
  let stageStarted = false;
  try {
    assert.equal(await acquireSubscriptionLifecycleLease(owner, key), true);
    const completed = await runLifecyclePassWithLease({
      leaseId: contender,
      heartbeatMs: 5,
      acquire: (id) => acquireSubscriptionLifecycleLease(id, key),
      renew: (id) => renewSubscriptionLifecycleLease(id, key),
      release: (id) => releaseSubscriptionLifecycleLease(id, key),
      stages: [async () => { stageStarted = true; }]
    });
    assert.equal(completed, false);
    assert.equal(stageStarted, false);
    assert.equal(await renewSubscriptionLifecycleLease(owner, key), true);
  } finally {
    await releaseSubscriptionLifecycleLease(owner, key);
    await releaseSubscriptionLifecycleLease(contender, key);
    await prisma.workerLease.deleteMany({ where: { key } });
  }
});
