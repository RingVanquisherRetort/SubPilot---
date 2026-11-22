import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("PostgreSQL scope lease coalesces revisions, rejects stale owners, and retries safely", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const {
    requestSubscriptionAccessReconciliation,
    claimNextSubscriptionAccessScope,
    claimSubscriptionAccessScope,
    renewSubscriptionAccessScopeLease,
    completeSubscriptionAccessScope,
    failSubscriptionAccessScope
  } = await import("@subpilot/payments");

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let ownerId: string | undefined;
  let workspaceId: string | undefined;
  let scopeId: string | undefined;

  try {
    const owner = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Access scope lease test" }
    });
    ownerId = owner.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Access scope lease " + suffix,
        slug: "access-scope-lease-" + suffix,
        createdById: owner.id
      }
    });
    workspaceId = workspace.id;
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Access scope lease project",
        slug: "scope-" + suffix
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
        title: "Access scope lease chat"
      }
    });

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id, chat.id], now);
      await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id], now);
    });

    const scope = await prisma.subscriptionAccessScope.findUniqueOrThrow({
      where: {
        customerId_connectedChatId: {
          customerId: customer.id,
          connectedChatId: chat.id
        }
      }
    });
    scopeId = scope.id;
    assert.equal(scope.desiredRevision, 2n);
    assert.equal(scope.appliedRevision, 0n);

    assert.equal(await claimSubscriptionAccessScope(prisma, "not-this-customer", chat.id, { now }), null);
    const first = await claimSubscriptionAccessScope(prisma, customer.id, chat.id, {
      now,
      leaseTtlMs: 30_000
    });
    assert.ok(first);
    assert.equal(first.id, scope.id);
    assert.equal(first.revision, 2n);
    assert.equal(first.attempts, 1);

    // A second worker cannot take an unexpired lease.
    assert.equal(await claimNextSubscriptionAccessScope(prisma, { now }), null);
    assert.equal(await renewSubscriptionAccessScopeLease(prisma, first, {
      now: new Date(now.getTime() + 1_000),
      leaseTtlMs: 30_000
    }), true);

    // A concurrent entitlement change advances the desired revision while the
    // Telegram operation is in flight; completing revision 2 must requeue revision 3.
    await prisma.$transaction((tx) =>
      requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id], new Date(now.getTime() + 2_000))
    );
    // A stale worker must not extend its lease after a payment or entitlement
    // mutation advances the desired revision. The newer generation stays due.
    assert.equal(await renewSubscriptionAccessScopeLease(prisma, first, {
      now: new Date(now.getTime() + 2_500),
      leaseTtlMs: 30_000
    }), false);
    const completedOldRevision = await completeSubscriptionAccessScope(
      prisma,
      first,
      new Date(now.getTime() + 3_000)
    );
    assert.equal(completedOldRevision, true);

    const pending = await prisma.subscriptionAccessScope.findUniqueOrThrow({
      where: { id: scope.id }
    });
    assert.equal(pending.desiredRevision, 3n);
    assert.equal(pending.appliedRevision, 2n);
    assert.equal(pending.leaseToken, null);
    assert.ok(pending.nextAttemptAt);
    assert.equal(pending.nextAttemptAt.getTime(), now.getTime() + 3_000);

    const second = await claimNextSubscriptionAccessScope(prisma, {
      now: new Date(now.getTime() + 4_000),
      leaseTtlMs: 30_000
    });
    assert.ok(second);
    assert.equal(second.revision, 3n);

    // Force lease expiry and let a successor claim it; the old response is fenced.
    await prisma.subscriptionAccessScope.update({
      where: { id: scope.id },
      data: { leaseExpiresAt: new Date(now.getTime() + 4_000) }
    });
    const successor = await claimNextSubscriptionAccessScope(prisma, {
      now: new Date(now.getTime() + 5_000),
      leaseTtlMs: 30_000
    });
    assert.ok(successor);
    assert.notEqual(successor.leaseToken, second.leaseToken);
    assert.equal(await completeSubscriptionAccessScope(
      prisma,
      second,
      new Date(now.getTime() + 6_000)
    ), false);

    // Failed current operations are retried at their backoff time; unsafe text is not stored.
    const retryAt = new Date(now.getTime() + 60_000);
    assert.equal(await failSubscriptionAccessScope(prisma, successor, {
      retryAt,
      errorCode: "Telegram raw error: token=secret",
      now: new Date(now.getTime() + 6_000)
    }), true);
    const failed = await prisma.subscriptionAccessScope.findUniqueOrThrow({
      where: { id: scope.id }
    });
    assert.equal(failed.lastErrorCode, "UNKNOWN");
    assert.equal(await claimNextSubscriptionAccessScope(prisma, {
      now: new Date(now.getTime() + 7_000)
    }), null);

    const retried = await claimNextSubscriptionAccessScope(prisma, {
      now: new Date(retryAt.getTime() + 1)
    });
    assert.ok(retried);
    assert.equal(retried.revision, 3n);
    assert.equal(await completeSubscriptionAccessScope(
      prisma,
      retried,
      new Date(retryAt.getTime() + 2)
    ), true);

    const settled = await prisma.subscriptionAccessScope.findUniqueOrThrow({
      where: { id: scope.id }
    });
    assert.equal(settled.desiredRevision, 3n);
    assert.equal(settled.appliedRevision, 3n);
    assert.equal(settled.leaseToken, null);
    assert.equal(settled.nextAttemptAt, null);
    assert.equal(settled.attempts, 0);

    // The active-entitlement worker must not claim a scope that has no current
    // unrevoked subscription grant. The generic claim path remains available
    // for the separate expiry/revocation worker.
    const filterRequestedAt = new Date();
    await prisma.$transaction((tx) =>
      requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id], filterRequestedAt)
    );
    assert.equal(await claimSubscriptionAccessScope(prisma, customer.id, chat.id, {
      now: new Date(filterRequestedAt.getTime() + 1),
      onlyActiveEntitlements: true
    }), null);
    const unrestricted = await claimSubscriptionAccessScope(prisma, customer.id, chat.id, {
      now: new Date(filterRequestedAt.getTime() + 1)
    });
    assert.ok(unrestricted);
    assert.equal(await completeSubscriptionAccessScope(
      prisma,
      unrestricted,
      new Date(filterRequestedAt.getTime() + 2)
    ), true);
  } finally {
    if (scopeId) await prisma.subscriptionAccessScope.deleteMany({ where: { id: scopeId } });
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } });
  }
});
