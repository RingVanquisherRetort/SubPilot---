import { queueBuyerRenewal, applyBuyerRenewal } from "./buyer-stars-renewal.js";
import { reconcileLateStarsCancellation } from "./late-stars-cancellation.js";
import { validatePreCheckout } from "./project-bot-updates.js";
import { hasActiveInviteEntrantGrant } from "./invite-entry-entitlement.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Bot } from "grammy";
import { prisma } from "@subpilot/database";
import {
  lockSubscriptionAccessScope,
  requestSubscriptionAccessReconciliation
} from "@subpilot/payments";
import { reconcileSubscriptionAccessRemoval } from "./subscription-access-removal.js";

type Fixture = {
  subscription: { id: string };
  customer: { id: string; telegramUserId: bigint };
  chat: { id: string; telegramChatId: bigint };
  grant: { id: string };
  project: { id: string };
  plan: { id: string };
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n +
    BigInt(Math.floor(Math.random() * 100_000));
  let ownerId: string | undefined;
  let workspaceId: string | undefined;
  try {
    const owner = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Revocation coordinator test" }
    });
    ownerId = owner.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Revocation coordinator " + suffix,
        slug: "revocation-coordinator-" + suffix,
        createdById: owner.id,
        members: { create: { userId: owner.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Revocation coordinator project",
        slug: "revocation-coordinator-" + suffix
      }
    });
    const plan = await prisma.creatorPlan.create({
      data: {
        projectId: project.id, title: "Revocation coordinator plan",
        price: "100", currency: "XTR", durationDays: 30
      }
    });
    // Membership operations require a safely representable Telegram user ID.
    const customer = await prisma.projectCustomer.create({
      data: {
        projectId: project.id,
        telegramUserId: BigInt(Date.now() % 1_000_000_000) + 100_000_000n
      }
    });
    const chat = await prisma.connectedChat.create({
      data: {
        projectId: project.id, telegramChatId: telegramBase + 2n,
        type: "CHANNEL", title: "Revocation coordinator chat"
      }
    });
    const now = new Date();
    const subscription = await prisma.subscription.create({
      data: {
        projectId: project.id, customerId: customer.id, planId: plan.id,
        status: "EXPIRED",
        startsAt: new Date(now.getTime() - 31 * 86_400_000),
        endsAt: new Date(now.getTime() - 60_000)
      }
    });
    const grant = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: subscription.id, connectedChatId: chat.id,
        inviteLink: "https://t.me/+old-revocation-" + suffix,
        expiresAt: new Date(now.getTime() + 60_000),
        joinedAt: new Date(now.getTime() - 120_000),
        revocationNextAttemptAt: new Date(now.getTime() - 1_000)
      }
    });
    await run({ subscription, customer, chat, grant, project, plan });
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } });
  }
}

test("removal releases the database transaction before Telegram and fences a concurrent renewal", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    const revokeStarted = deferred();
    const releaseRevoke = deferred();
    let membershipChecks = 0;
    let bans = 0;
    const bot = {
      api: {
        revokeChatInviteLink: async () => {
          revokeStarted.resolve();
          await releaseRevoke.promise;
          return true;
        },
        getChatMember: async () => { membershipChecks += 1; return { status: "member" }; },
        banChatMember: async () => { bans += 1; return true; },
        unbanChatMember: async () => true
      }
    } as unknown as Bot;

    const removal = reconcileSubscriptionAccessRemoval({
      bot, subscriptionId: subscription.id,
      customerId: customer.id, connectedChatId: chat.id,
      telegramUserId: customer.telegramUserId
    });
    try {
      await Promise.race([
        revokeStarted.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Telegram revoke not started")), 5_000))
      ]);

      const renew = prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
          subscription.id
        );
        await lockSubscriptionAccessScope(tx, customer.id, chat.id);
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            status: "ACTIVE",
            endsAt: new Date(Date.now() + 30 * 86_400_000)
          }
        });
        await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id]);
      });

      const completed = await Promise.race([
        renew.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4_000))
      ]);
      assert.equal(completed, true, "renewal must not wait for an in-flight Telegram call");
      releaseRevoke.resolve();

      const result = await removal;
      assert.equal(result, "LEASE_LOST");
      assert.equal(membershipChecks, 0);
      assert.equal(bans, 0);

      const currentGrant = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
        where: { id: grant.id }
      });
      const scope = await prisma.subscriptionAccessScope.findUniqueOrThrow({
        where: {
          customerId_connectedChatId: {
            customerId: customer.id, connectedChatId: chat.id
          }
        }
      });
      assert.equal(currentGrant.revokedAt, null);
      assert.ok(scope.desiredRevision > scope.appliedRevision);
    } finally {
      releaseRevoke.resolve();
      await removal.catch(() => undefined);
    }
  });
});

test("an overlapping active subscription preserves chat membership during another expiry", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant, plan, project }) => {
    const active = await prisma.subscription.create({
      data: {
        projectId: project.id, planId: plan.id, customerId: customer.id,
        status: "ACTIVE", startsAt: new Date(Date.now() - 5_000),
        endsAt: new Date(Date.now() + 30 * 86_400_000)
      }
    });
    const activeGrant = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: active.id, connectedChatId: chat.id,
        inviteLink: "", expiresAt: new Date(0), joinedAt: new Date()
      }
    });
    let removedMembers = 0;
    const bot = {
      api: {
        revokeChatInviteLink: async () => true,
        getChatMember: async () => { removedMembers += 1; return { status: "member" }; },
        banChatMember: async () => { removedMembers += 1; return true; },
        unbanChatMember: async () => { removedMembers += 1; return true; }
      }
    } as unknown as Bot;
    const result = await reconcileSubscriptionAccessRemoval({
      bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId
    });
    assert.equal(result, "PRESERVED_BY_OTHER_SUBSCRIPTION");
    assert.equal(removedMembers, 0);
    const [expiredGrant, remainingGrant] = await Promise.all([
      prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: activeGrant.id } })
    ]);
    assert.equal(expiredGrant.revocationReason, "SUBSCRIPTION_EXPIRED");
    assert.ok(expiredGrant.revokedAt);
    assert.equal(remainingGrant.revokedAt, null);
  });
});

test("admin-excluded cleanup revokes only the stale invite and retains sticky exclusion", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "ACTIVE", endsAt: new Date(Date.now() + 30 * 86_400_000) }
    });
    await prisma.subscriptionAccessGrant.update({
      where: { id: grant.id },
      data: { revokedAt: new Date(), revocationReason: "ADMIN_EXCLUDED" }
    });
    let revokedInvites = 0;
    const bot = {
      api: {
        revokeChatInviteLink: async () => { revokedInvites += 1; return true; },
        getChatMember: async () => { throw new Error("Should not query a banned member"); },
        banChatMember: async () => { throw new Error("Should not touch moderation ban"); },
        unbanChatMember: async () => { throw new Error("Should not unban"); }
      }
    } as unknown as Bot;
    const input = {
      bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId
    };
    assert.equal(await reconcileSubscriptionAccessRemoval(input), "INVITE_CLEANED");
    assert.equal(revokedInvites, 1);
    const updated = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    });
    assert.equal(updated.revocationReason, "ADMIN_EXCLUDED");
    assert.ok(updated.revokedAt);
    assert.equal(updated.inviteLink, "");
    assert.equal(await reconcileSubscriptionAccessRemoval(input), "SKIPPED");
    assert.equal(revokedInvites, 1);
  });
});

test("ambiguous ban after failed unban cannot silently clear a moderator exclusion", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    await prisma.subscriptionAccessGrant.update({
      where: { id: grant.id },
      data: {
        inviteLink: "", expiresAt: new Date(0),
        revocationLastError: "MEMBER_UNBAN_FAILED"
      }
    });
    let unbans = 0;
    const bot = {
      api: {
        getChatMember: async () => ({ status: "kicked" }),
        banChatMember: async () => { throw new Error("Already banned"); },
        unbanChatMember: async () => { unbans += 1; return true; }
      }
    } as unknown as Bot;
    const result = await reconcileSubscriptionAccessRemoval({
      bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId
    });
    assert.equal(result, "FAILED");
    assert.equal(unbans, 0);
    const current = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    });
    assert.equal(current.revokedAt, null);
    assert.equal(current.revocationLastError, "MEMBER_BAN_OWNERSHIP_UNCERTAIN");
  });
});

for (const status of ["left", "restricted", "administrator", "creator"] as const) {
  test("expiry preserves Telegram moderation for status " + status, {
    skip: !process.env.DATABASE_URL
  }, async () => {
    await withFixture(async ({ subscription, customer, chat, grant }) => {
      let mutations = 0;
      const bot = { api: {
        revokeChatInviteLink: async () => true,
        getChatMember: async () => ({ status, is_member: true }),
        banChatMember: async () => { mutations++; return true; },
        unbanChatMember: async () => { mutations++; return true; }
      } } as unknown as Bot;
      const result = await reconcileSubscriptionAccessRemoval({
        bot, subscriptionId: subscription.id, customerId: customer.id,
        connectedChatId: chat.id, telegramUserId: customer.telegramUserId
      });
      assert.equal(mutations, 0);
      assert.equal(result, status === "left" ? "REVOKED" : "FAILED");
      const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
      assert.equal(saved.revokedAt !== null, status === "left");
    });
  });
}

test("an entrant using another buyer's invite is checked against their own active access", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant, project }) => {
    const allowed = () => hasActiveInviteEntrantGrant(project.id, chat.id, customer.telegramUserId);
    assert.equal(await allowed(), false);
    await prisma.subscription.update({ where: { id: subscription.id }, data: { status: "ACTIVE", endsAt: null } });
    assert.equal(await allowed(), true);
    assert.equal(await hasActiveInviteEntrantGrant(project.id, chat.id, customer.telegramUserId + 1n), false);
    await prisma.subscriptionAccessGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date(), revocationReason: "ADMIN_REVOKED" } });
    assert.equal(await allowed(), false);
  });
});

test("Stars pre-checkout rejects mixed legacy destinations and preserves existing grants", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, project, chat, grant }) => {
    const second = await prisma.connectedChat.create({
      data: { projectId: project.id, telegramChatId: chat.telegramChatId + 1n, type: "SUPERGROUP", isActive: true }
    });
    const payment = await prisma.payment.create({ data: {
      projectId: project.id, customerId: customer.id, subscriptionId: subscription.id,
      amount: "100", currency: "XTR", provider: "TELEGRAM_STARS", status: "PENDING",
      idempotencyKey: randomUUID(), metadata: { projectBotId: "source", chatIds: [String(chat.telegramChatId), String(second.telegramChatId)] }
    } });
    const query = { invoice_payload: payment.id, from: { id: Number(customer.telegramUserId) }, currency: "XTR", total_amount: 100 };
    assert.equal(await validatePreCheckout(query, project.id, "source"), true);
    await prisma.connectedChat.update({ where: { id: second.id }, data: { type: "GROUP" } });
    assert.equal(await validatePreCheckout(query, project.id, "source"), false);
    assert.equal((await prisma.subscriptionAccessGrant.findUniqueOrThrow({where: {id: grant.id}})).revokedAt, null);
  });
});

test("channel expiry persists its timed ban intent before contacting Telegram", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, customer, chat }) => {
    let calls = 0;
    const botId = 54321n;
    const bot = { token: "54321:test", api: {
      revokeChatInviteLink: async () => true,
      getChatMember: async () => ({ status: "member" }),
      banChatMember: async (_chat: string, _user: number, options: { until_date: number }) => {
        calls++;
        assert.ok(options.until_date > Date.now() / 1000 + 30);
        assert.ok(await prisma.telegramRemovalIntent.findUnique({ where: { botId_telegramChatId_telegramUserId_untilDate: {
          botId, telegramChatId: chat.telegramChatId, telegramUserId: customer.telegramUserId, untilDate: options.until_date
        } } }));
        return true;
      }
    } } as unknown as Bot;
    const input = { bot, subscriptionId: subscription.id, customerId: customer.id, connectedChatId: chat.id, telegramUserId: customer.telegramUserId };
    try {
      assert.equal(await reconcileSubscriptionAccessRemoval(input), "REVOKED");
      assert.equal(await reconcileSubscriptionAccessRemoval(input), "SKIPPED");
      assert.equal(calls, 1);
    } finally {
      await prisma.telegramRemovalIntent.deleteMany({ where: { botId, telegramChatId: chat.telegramChatId } });
    }
  });
});

test("late Stars cancellation survives an ambiguous Telegram reply without reopening a revoked subscription", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription }) => {
    const charge = randomUUID();
    await prisma.subscription.update({ where: { id: subscription.id }, data: {
      status: "CANCELLED", telegramStarInitialChargeId: charge, telegramStarSubscriptionState: "ACTIVE",
      lateStarsCancelBotId: "original", lateStarsCancelDueAt: new Date(0)
    } });
    let calls = 0;
    const run = () => reconcileLateStarsCancellation(subscription.id, "original", charge, async args => {
      calls++;
      assert.equal(args.is_canceled, true);
      if (calls === 1) throw new Error("response lost after remote success");
      return true;
    });
    assert.equal(await run(), false);
    assert.equal(await run(), false);
    await prisma.subscription.update({ where: { id: subscription.id }, data: { lateStarsCancelDueAt: new Date(0) } });
    assert.equal(await run(), true);
    assert.equal(await run(), true);
    assert.equal(calls, 2);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.lateStarsCancelDueAt, null);
  });
});

test("renewal during an in-flight Telegram ban keeps the grant active and queues repair", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    const botId = 64832n;
    let bans = 0;
    const bot = { token: "64832:test", api: {
      revokeChatInviteLink: async () => true,
      getChatMember: async () => ({ status: "member" }),
      banChatMember: async () => {
        bans++;
        await prisma.$transaction(async tx => {
          await tx.$queryRawUnsafe('SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE', subscription.id);
          await lockSubscriptionAccessScope(tx, customer.id, chat.id);
          await tx.subscription.update({ where: { id: subscription.id }, data: { status: "ACTIVE", endsAt: new Date(Date.now() + 86_400_000) } });
          await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id]);
        });
        return true;
      }
    } } as unknown as Bot;
    try {
      const result = await reconcileSubscriptionAccessRemoval({ bot, subscriptionId: subscription.id,
        customerId: customer.id, connectedChatId: chat.id, telegramUserId: customer.telegramUserId });
      assert.equal(bans, 1);
      assert.equal(result, "LEASE_LOST");
      const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
      assert.equal(saved.revokedAt, null);
      const scope = await prisma.subscriptionAccessScope.findUniqueOrThrow({
        where: { customerId_connectedChatId: { customerId: customer.id, connectedChatId: chat.id } }
      });
      assert.ok(scope.desiredRevision > scope.appliedRevision);
    } finally {
      await prisma.telegramRemovalIntent.deleteMany({ where: { botId, telegramChatId: chat.telegramChatId } });
    }
  });
});

test("late buyer resume after administrative cancellation requeues the winning cancel", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, project, customer }) => {
    const where = { id: subscription.id };
    const charge = randomUUID();
    await prisma.subscription.update({ where, data: { status: "ACTIVE", endsAt: new Date(Date.now() + 86_400_000),
      telegramStarInitialChargeId: charge, telegramStarSubscriptionState: "CANCELED" } });
    await prisma.payment.create({ data: { subscriptionId: subscription.id, projectId: project.id, customerId: customer.id,
      amount: "100", currency: "XTR", provider: "TELEGRAM_STARS", providerPaymentId: charge, status: "SUCCEEDED",
      metadata: { source: "project_bot", projectBotId: "original", isRecurring: true } } });
    const enqueue = (bot: string) => queueBuyerRenewal(subscription.id, project.id, customer.id, bot, false);
    assert.equal(await enqueue("other"), false);
    assert.equal(await enqueue("original"), true);
    assert.equal(await enqueue("original"), false);
    const calls: boolean[] = [];
    const cancel = () => applyBuyerRenewal(subscription.id, "original", async args => {
      calls.push(args.is_canceled);
      return true;
    });
    const result = await applyBuyerRenewal(subscription.id, "original", async args => {
      await prisma.subscription.update({ where, data: { status: "CANCELLED", buyerStarsCanceled: true,
        buyerStarsClaim: null, buyerStarsDueAt: new Date(0) } });
      assert.equal(await cancel(), true);
      calls.push(args.is_canceled);
      return true;
    });
    assert.equal(result, false);
    assert.equal(await cancel(), true);
    assert.deepEqual(calls, [true, false, true]);
    const saved = await prisma.subscription.findUniqueOrThrow({ where });
    assert.equal(saved.status, "CANCELLED");
    assert.equal(saved.telegramStarSubscriptionState, "CANCELED");
    assert.equal(saved.buyerStarsDueAt, null);
  });
});

test("ambiguous buyer cancellation retries against the original charge and preserves the paid term", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription }) => {
    const where = { id: subscription.id };
    const endsAt = new Date(Date.now() + 86_400_000);
    const charge = randomUUID();
    await prisma.subscription.update({ where, data: { status: "ACTIVE", endsAt, telegramStarInitialChargeId: charge,
      telegramStarSubscriptionState: "ACTIVE", buyerStarsChargeId: charge, buyerStarsBotId: "source",
      buyerStarsDueAt: new Date(0), buyerStarsCanceled: true } });
    let calls = 0;
    const apply = () => applyBuyerRenewal(subscription.id, "source", async args => {
      calls++;
      assert.equal(args.telegram_payment_charge_id, charge);
      assert.equal(args.is_canceled, true);
      if (calls === 1) throw new Error("response lost");
      return true;
    });
    assert.equal(await apply(), false);
    assert.equal(await apply(), false);
    await prisma.subscription.update({ where, data: { buyerStarsDueAt: new Date(0) } });
    assert.equal(await apply(), true);
    const saved = await prisma.subscription.findUniqueOrThrow({ where });
    assert.equal(saved.status, "ACTIVE");
    assert.deepEqual(saved.endsAt, endsAt);
    assert.equal(saved.telegramStarSubscriptionState, "CANCELED");
    assert.equal(calls, 2);
  });
});
