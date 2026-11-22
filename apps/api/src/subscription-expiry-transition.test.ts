import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { claimSubscriptionExpiry, withSubscriptionExpiryRowLock } from "./subscription-expiry-transition.js";

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


test("PostgreSQL expiry row lock re-reads a renewed entitlement before revocation", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let actorId: string | undefined;
  let workspaceId: string | undefined;

  try {
    const actor = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Expiry race test" }
    });
    actorId = actor.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Expiry race " + suffix,
        slug: "expiry-race-" + suffix,
        createdById: actor.id,
        members: { create: { userId: actor.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Expiry race project",
        slug: "project-" + suffix
      }
    });
    const plan = await prisma.creatorPlan.create({
      data: {
        projectId: project.id,
        title: "Expiry race plan",
        price: "100",
        currency: "XTR",
        durationDays: 30
      }
    });
    const customer = await prisma.projectCustomer.create({
      data: { projectId: project.id, telegramUserId: telegramBase + 1n }
    });
    const chat = await prisma.connectedChat.create({
      data: {
        projectId: project.id,
        telegramChatId: telegramBase + 2n,
        type: "CHANNEL",
        title: "Expiry race chat"
      }
    });
    const now = new Date();
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 30 * 24 * 60 * 60_000);

    const expiryFirst = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: new Date(now.getTime() - 31 * 24 * 60 * 60_000),
        endsAt: past
      }
    });
    const grantAfterExpiryFirst = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: expiryFirst.id,
        connectedChatId: chat.id,
        inviteLink: "",
        expiresAt: new Date(0),
        joinedAt: new Date(now.getTime() - 2 * 60_000)
      }
    });

    let revokeCalls = 0;
    const firstResult = await prisma.$transaction(async (tx) =>
      withSubscriptionExpiryRowLock(tx, expiryFirst.id, now, async (currentStatus) => {
        revokeCalls += 1;
        await tx.subscriptionAccessGrant.update({
          where: { id: grantAfterExpiryFirst.id },
          data: {
            revokedAt: now,
            revocationReason: currentStatus === "CANCELLED" ? "ADMIN_REVOKED" : "SUBSCRIPTION_EXPIRED"
          }
        });
        return "REVOKED";
      })
    );
    assert.equal(firstResult.shouldRevoke, true);
    assert.equal(firstResult.result, "REVOKED");
    assert.equal(revokeCalls, 1);
    const expiredGrant = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grantAfterExpiryFirst.id }
    });
    assert.equal(expiredGrant.revokedAt?.getTime(), now.getTime());
    assert.equal(expiredGrant.revocationReason, "SUBSCRIPTION_EXPIRED");

    // A paid renewal that gets the same lock after expiry removal restores the
    // entitlement. The worker must then skip any remaining stale grant work.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
        expiryFirst.id
      );
      await tx.subscription.update({
        where: { id: expiryFirst.id },
        data: { status: "ACTIVE", endsAt: future }
      });
    });
    const afterPaymentResult = await prisma.$transaction((tx) =>
      withSubscriptionExpiryRowLock(tx, expiryFirst.id, now, async () => {
        revokeCalls += 1;
        return "SHOULD_NOT_RUN";
      })
    );
    assert.equal(afterPaymentResult.shouldRevoke, false);
    assert.equal(revokeCalls, 1);

    // In the opposite ordering, a renewal committed before the worker acquires
    // the lock means no Telegram access-removal callback is allowed to run.
    const renewalFirst = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: new Date(now.getTime() - 31 * 24 * 60 * 60_000),
        endsAt: past
      }
    });
    const grantAfterRenewalFirst = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: renewalFirst.id,
        connectedChatId: chat.id,
        inviteLink: "",
        expiresAt: new Date(0),
        joinedAt: new Date(now.getTime() - 2 * 60_000)
      }
    });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
        renewalFirst.id
      );
      await tx.subscription.update({
        where: { id: renewalFirst.id },
        data: { status: "ACTIVE", endsAt: future }
      });
    });

    const renewalFirstResult = await prisma.$transaction((tx) =>
      withSubscriptionExpiryRowLock(tx, renewalFirst.id, now, async () => {
        revokeCalls += 1;
        await tx.subscriptionAccessGrant.update({
          where: { id: grantAfterRenewalFirst.id },
          data: { revokedAt: now }
        });
        return "SHOULD_NOT_RUN";
      })
    );
    assert.equal(renewalFirstResult.shouldRevoke, false);
    assert.equal(revokeCalls, 1);

    const untouchedGrant = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grantAfterRenewalFirst.id }
    });
    assert.equal(untouchedGrant.revokedAt, null);
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
  }
});
