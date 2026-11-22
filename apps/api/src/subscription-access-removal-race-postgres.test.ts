import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Bot } from "grammy";

/**
 * The payment webhook must be able to commit a renewal while a Telegram
 * membership lookup is blocked. The old revocation must not ban the renewed
 * customer after the desired access revision changes.
 */
test("renewal fences an in-flight expiry removal without holding a DB transaction", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const { requestSubscriptionAccessReconciliation } = await import("@subpilot/payments");
  const { reconcileSubscriptionAccessRemoval } = await import("./subscription-access-removal.js");

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n +
    BigInt(Math.floor(Math.random() * 100_000));
  let userId: string | undefined;
  let workspaceId: string | undefined;
  let lookupStarted!: () => void;
  let resumeLookup!: () => void;
  const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
  const release = new Promise<void>((resolve) => { resumeLookup = resolve; });
  let bans = 0;
  let unbans = 0;

  try {
    const user = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Expiry renewal race test" }
    });
    userId = user.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Expiry renewal race " + suffix,
        slug: "expiry-race-" + suffix,
        createdById: user.id
      }
    });
    workspaceId = workspace.id;
    const project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: "Race project", slug: "race-" + suffix }
    });
    const plan = await prisma.creatorPlan.create({
      data: {
        projectId: project.id,
        title: "Race plan",
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
        title: "Race test chat"
      }
    });
    const now = new Date();
    const subscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        planId: plan.id,
        status: "EXPIRED",
        grantType: "PAID",
        startsAt: new Date(now.getTime() - 86_400_000),
        endsAt: new Date(now.getTime() - 1_000)
      }
    });
    const grant = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: subscription.id,
        connectedChatId: chat.id,
        inviteLink: "",
        expiresAt: new Date(0),
        joinedAt: new Date(now.getTime() - 60_000)
      }
    });

    const bot = {
      api: {
        getChatMember: async () => {
          lookupStarted();
          await release;
          return { status: "member" };
        },
        banChatMember: async () => { bans++; },
        unbanChatMember: async () => { unbans++; }
      }
    } as unknown as Bot;

    const removing = reconcileSubscriptionAccessRemoval({
      bot,
      subscriptionId: subscription.id,
      customerId: customer.id,
      connectedChatId: chat.id,
      telegramUserId: customer.telegramUserId,
      now
    });

    // A broken implementation may hang before reaching the Telegram call.
    await Promise.race([
      started,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("membership lookup did not start")), 10_000)
      )
    ]);
    try {
      // This is intentionally the payment/webhook-side atomic DB mutation.
      // It must not wait for the pending remote Telegram request.
      await Promise.race([
        prisma.$transaction(async (tx) => {
          await tx.subscription.update({
            where: { id: subscription.id },
            data: { status: "ACTIVE", endsAt: new Date(Date.now() + 86_400_000) }
          });
          await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id]);
        }, { maxWait: 2_000, timeout: 5_000 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("renewal blocked by Telegram I/O")), 5_000)
        )
      ]);
    } finally {
      resumeLookup();
    }

    assert.equal(await removing, "LEASE_LOST");
    assert.equal(bans, 0, "a renewed customer must not be banned by stale removal");
    assert.equal(unbans, 0);
    assert.equal((await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    })).revokedAt, null);
    const scope = await prisma.subscriptionAccessScope.findUniqueOrThrow({
      where: {
        customerId_connectedChatId: {
          customerId: customer.id,
          connectedChatId: chat.id
        }
      }
    });
    assert.ok(scope.desiredRevision > scope.appliedRevision,
      "the renewal must leave a newer reconciliation generation pending");
  } finally {
    resumeLookup?.();
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  }
});
