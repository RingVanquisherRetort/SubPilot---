import { queueBuyerRenewal, applyBuyerRenewal } from "./buyer-stars-renewal.js";
import { reconcileLateStarsCancellation } from "./late-stars-cancellation.js";
import { deliverSubscriptionAccess, handleProjectBotUpdate, recordSubscriptionAccessRevocationFailure, processRefundedStarsPayment, processSuccessfulStarsPayment, validatePreCheckout } from "./project-bot-updates.js";
import { hasActiveInviteEntrantGrant } from "./invite-entry-entitlement.js";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Bot } from "grammy";
import { prisma } from "@subpilot/database";
import {
  claimSubscriptionAccessScope,
  lockSubscriptionAccessScope,
  requestSubscriptionAccessReconciliation
} from "@subpilot/payments";
import { reconcileSubscriptionAccessRemoval as reconcileRemoval } from "./subscription-access-removal.js";
import { confirmPendingAccessModerationReview, inspectPendingAccessModerationReview, listPendingAccessModerationReviews } from "../../control-bot/src/access-moderation-review.js";
import { cancelStalePendingPayments } from "./subscription-lifecycle.js";

function reconcileSubscriptionAccessRemoval(input: Parameters<typeof reconcileRemoval>[0]) {
  return reconcileRemoval({ allowAutomaticMemberBan: true, ...input });
}

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

test("a renewal during an in-flight Telegram ban fences stale removal finalization", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    const banStarted = deferred();
    const releaseBan = deferred();
    let bans = 0;
    let unbans = 0;
    const bot = {
      api: {
        revokeChatInviteLink: async () => true,
        getChatMember: async () => ({ status: "member" }),
        banChatMember: async () => {
          bans += 1;
          banStarted.resolve();
          await releaseBan.promise;
          return true;
        },
        unbanChatMember: async () => { unbans += 1; return true; }
      }
    } as unknown as Bot;

    const removal = reconcileSubscriptionAccessRemoval({
      bot, subscriptionId: subscription.id,
      customerId: customer.id, connectedChatId: chat.id,
      telegramUserId: customer.telegramUserId
    });
    try {
      await Promise.race([
        banStarted.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Telegram ban was not reached")), 5_000))
      ]);
      const renewal = prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
          subscription.id
        );
        await lockSubscriptionAccessScope(tx, customer.id, chat.id);
        await tx.subscription.update({
          where: { id: subscription.id },
          data: { status: "ACTIVE", endsAt: new Date(Date.now() + 30 * 86_400_000) }
        });
        await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id]);
      });
      assert.equal(await Promise.race([
        renewal.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4_000))
      ]), true, "renewal must commit while the Telegram ban is in flight");
      releaseBan.resolve();
      assert.equal(await removal, "LEASE_LOST");
      assert.equal(bans, 1, "the already-started Telegram ban cannot be rolled back");
      assert.equal(unbans, 0, "never undo an ambiguous moderator ban automatically");
      const [saved, scope] = await Promise.all([
        prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
        prisma.subscriptionAccessScope.findUniqueOrThrow({
          where: {
            customerId_connectedChatId: {
              customerId: customer.id, connectedChatId: chat.id
            }
          }
        })
      ]);
      assert.equal(saved.revokedAt, null, "stale worker must not revoke renewed entitlement");
      assert.ok(scope.desiredRevision > scope.appliedRevision,
        "renewal leaves reconciliation due for the newer desired state");
    } finally {
      releaseBan.resolve();
      await removal.catch(() => undefined);
    }
  });
});

test("a delayed old invite revoke cannot erase a replacement grant URL", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    const revokeStarted = deferred();
    const releaseRevoke = deferred();
    const oldUrl = (await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    })).inviteLink;
    const replacementUrl = "https://t.me/+replacement-" + randomUUID();
    const revokedUrls: string[] = [];
    const bot = {
      api: {
        revokeChatInviteLink: async (_chatId: string, url: string) => {
          revokedUrls.push(url);
          revokeStarted.resolve();
          await releaseRevoke.promise;
          return true;
        },
        getChatMember: async () => { throw new Error("stale worker must not check membership"); },
        banChatMember: async () => { throw new Error("stale worker must not ban"); },
        unbanChatMember: async () => { throw new Error("stale worker must not unban"); }
      }
    } as unknown as Bot;
    const removal = reconcileSubscriptionAccessRemoval({
      bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId
    });
    try {
      await Promise.race([
        revokeStarted.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("old invite revoke was not reached")), 5_000))
      ]);
      await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
          subscription.id
        );
        await lockSubscriptionAccessScope(tx, customer.id, chat.id);
        await tx.subscription.update({
          where: { id: subscription.id },
          data: { status: "ACTIVE", endsAt: new Date(Date.now() + 30 * 86_400_000) }
        });
        await tx.subscriptionAccessGrant.update({
          where: { id: grant.id },
          data: {
            inviteLink: replacementUrl,
            expiresAt: new Date(Date.now() + 86_400_000),
            joinedAt: null
          }
        });
        await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id]);
      });
      releaseRevoke.resolve();
      assert.equal(await removal, "LEASE_LOST");
      assert.deepEqual(revokedUrls, [oldUrl], "Telegram only receives the captured old URL");
      const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
        where: { id: grant.id }
      });
      assert.equal(saved.inviteLink, replacementUrl);
      assert.equal(saved.revokedAt, null);
      assert.equal((await prisma.subscription.findUniqueOrThrow({
        where: { id: subscription.id }
      })).status, "ACTIVE");
    } finally {
      releaseRevoke.resolve();
      await removal.catch(() => undefined);
    }
  });
});

test("delayed moderator-exclusion invite cleanup cannot erase a newer manual grant", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    const oldUrl = (await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    })).inviteLink;
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "ACTIVE", endsAt: new Date(Date.now() + 30 * 86_400_000) }
    });
    await prisma.subscriptionAccessGrant.update({
      where: { id: grant.id },
      data: { revokedAt: new Date(), revocationReason: "ADMIN_EXCLUDED" }
    });
    const revokeStarted = deferred();
    const releaseRevoke = deferred();
    const replacementUrl = "https://t.me/+manual-regrant-" + randomUUID();
    const revokedUrls: string[] = [];
    const bot = {
      api: {
        revokeChatInviteLink: async (_chatId: string, url: string) => {
          revokedUrls.push(url);
          revokeStarted.resolve();
          await releaseRevoke.promise;
          return true;
        },
        getChatMember: async () => { throw new Error("moderator exclusion cleanup must not inspect membership"); },
        banChatMember: async () => { throw new Error("moderator exclusion cleanup must not ban"); },
        unbanChatMember: async () => { throw new Error("moderator exclusion cleanup must not unban"); }
      }
    } as unknown as Bot;
    const removal = reconcileSubscriptionAccessRemoval({
      bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId
    });
    try {
      await Promise.race([
        revokeStarted.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("moderator-exclusion cleanup did not start")), 5_000))
      ]);
      await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
          subscription.id
        );
        await lockSubscriptionAccessScope(tx, customer.id, chat.id);
        await tx.subscriptionAccessGrant.update({
          where: { id: grant.id },
          data: {
            revokedAt: null,
            revocationReason: null,
            inviteLink: replacementUrl,
            expiresAt: new Date(Date.now() + 86_400_000),
            joinedAt: null
          }
        });
        await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id]);
      });
      releaseRevoke.resolve();
      assert.equal(await removal, "LEASE_LOST");
      assert.deepEqual(revokedUrls, [oldUrl]);
      const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
        where: { id: grant.id }
      });
      assert.equal(saved.inviteLink, replacementUrl);
      assert.equal(saved.revokedAt, null);
      assert.equal(saved.revocationReason, null);
    } finally {
      releaseRevoke.resolve();
      await removal.catch(() => undefined);
    }
  });
});

test("stale webhook revoke failure cannot consume a replacement invite retry budget", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, grant }) => {
    const oldUrl = (await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    })).inviteLink;
    const newUrl = "https://t.me/+fresh-grant-" + randomUUID();
    await prisma.subscriptionAccessGrant.update({
      where: { id: grant.id },
      data: {
        revokedAt: new Date(),
        revocationReason: "ADMIN_EXCLUDED",
        revocationAttempts: 0,
        revocationLastError: null,
        inviteLink: newUrl
      }
    });
    await recordSubscriptionAccessRevocationFailure(
      subscription.id, grant.id, "INVITE_REVOKE_FAILED",
      new Date(), undefined, oldUrl
    );
    const afterStaleFailure = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    });
    assert.equal(afterStaleFailure.inviteLink, newUrl);
    assert.equal(afterStaleFailure.revocationAttempts, 0);
    assert.equal(afterStaleFailure.revocationLastError, null);

    // A failure against the current URL must still be scheduled for retry.
    await recordSubscriptionAccessRevocationFailure(
      subscription.id, grant.id, "INVITE_REVOKE_FAILED",
      new Date(), undefined, newUrl
    );
    const afterCurrentFailure = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    });
    assert.equal(afterCurrentFailure.inviteLink, newUrl);
    assert.equal(afterCurrentFailure.revocationAttempts, 1);
    assert.equal(afterCurrentFailure.revocationLastError, "INVITE_REVOKE_FAILED");
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

test("unconfirmed removal parks for review instead of retrying or unbanning", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    let bans = 0;
    let unbans = 0;
    let revokedInvites = 0;
    const bot = { api: {
      revokeChatInviteLink: async () => { revokedInvites++; return true; },
      getChatMember: async () => ({ status: "member" }),
      banChatMember: async () => { bans++; return true; },
      unbanChatMember: async () => { unbans++; return true; }
    } } as unknown as Bot;
    const result = await reconcileSubscriptionAccessRemoval({
      bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId
    });
    assert.equal(result, "FAILED");
    assert.equal(revokedInvites, 1);
    assert.equal(bans, 1);
    assert.equal(unbans, 0);
    const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
    assert.equal(saved.revokedAt, null);
    assert.equal(saved.revocationLastError, "MEMBER_MODERATION_REVIEW_REQUIRED");
    assert.equal(saved.revocationNextAttemptAt.toISOString(), "2100-01-01T00:00:00.000Z");
    const notices = await prisma.ownerNotification.findMany({
      where: { projectId: saved.subscriptionId ? (await prisma.subscription.findUniqueOrThrow({
        where: { id: subscription.id }, select: { projectId: true }
      })).projectId : "" , eventType: "ACCESS_MODERATION_REVIEW" }
    });
    assert.ok(notices.length > 0, "review must be durably visible to a project owner");
    assert.ok(notices.every((notice) => notice.messageText.includes(customer.telegramUserId.toString())));
    assert.equal(await prisma.telegramRemovalIntent.count({
      where: { telegramChatId: chat.telegramChatId, telegramUserId: customer.telegramUserId }
    }), 0);
  });
});

test("authenticated Stars cancellation webhook persists recovery state and rejects an older update", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, project }) => {
    const projectBot = await prisma.projectBot.create({
      data: {
        projectId: project.id,
        telegramBotId: BigInt(Date.now()) + 900_000_000n,
        tokenEncrypted: "test-encrypted-bot-token",
        status: "ACTIVE",
        isPrimary: true
      }
    });
    const charge = "webhook-recovery-" + randomUUID();
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "ACTIVE",
        endsAt: new Date(Date.now() + 30 * 86_400_000),
        telegramStarInitialChargeId: charge,
        telegramStarSubscriptionState: "ACTIVE"
      }
    });
    const payment = await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        providerPaymentId: charge,
        idempotencyKey: "webhook-recovery:" + randomUUID(),
        amount: "100",
        currency: "XTR",
        status: "SUCCEEDED",
        paidAt: new Date(),
        metadata: {
          source: "project_bot",
          isRecurring: true,
          projectBotId: projectBot.id
        }
      }
    });

    const updateId = 700_000_000;
    const makeUpdate = (state: "active" | "canceled") => ({
      update_id: updateId,
      subscription: {
        user: { id: Number(customer.telegramUserId) },
        invoice_payload: payment.id,
        state
      }
    });
    const token = "123456789:test-token";
    await handleProjectBotUpdate(
      token, project.id, projectBot.id,
      makeUpdate("canceled") as never, updateId, 0
    );
    const afterCancel = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id }
    });
    assert.equal(afterCancel.telegramStarSubscriptionState, "CANCELED");
    assert.equal(afterCancel.telegramStarSubscriptionLastUpdateId, updateId);
    assert.equal(afterCancel.status, "ACTIVE", "buyer cancellation must not revoke the paid period");

    await handleProjectBotUpdate(
      token, project.id, projectBot.id,
      makeUpdate("active") as never, updateId - 1, 0
    );
    const afterStale = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id }
    });
    assert.equal(afterStale.telegramStarSubscriptionState, "CANCELED");
    assert.equal(afterStale.telegramStarSubscriptionLastUpdateId, updateId);
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

test("renewal after moderation review preserves the paid entitlement without banning", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    let bans = 0;
    const bot = { api: {
      revokeChatInviteLink: async () => true,
      getChatMember: async () => ({ status: "restricted", is_member: true }),
      banChatMember: async () => { bans++; return true; }
    } } as unknown as Bot;
    assert.equal(await reconcileSubscriptionAccessRemoval({
      bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId
    }), "FAILED");
    await prisma.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE', subscription.id);
      await lockSubscriptionAccessScope(tx, customer.id, chat.id);
      await tx.subscription.update({ where: { id: subscription.id }, data: {
        status: "ACTIVE", endsAt: new Date(Date.now() + 86_400_000)
      } });
      await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id]);
    });
    assert.equal(bans, 0);
    assert.equal((await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt, null);
  });
});

test("late buyer resume after administrative cancellation requeues the winning cancel", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, project, customer }) => {
    const where = { id: subscription.id };
    const charge = randomUUID();
    await prisma.subscription.update({ where, data: { status: "ACTIVE", endsAt: new Date(Date.now() + 86_400_000),
      telegramStarInitialChargeId: charge, telegramStarSubscriptionState: "CANCELED" } });
    const anchor = await prisma.payment.create({ data: { subscriptionId: subscription.id, projectId: project.id, customerId: customer.id,
      amount: "100", currency: "XTR", provider: "TELEGRAM_STARS", providerPaymentId: charge, status: "SUCCEEDED",
      metadata: {} } });
    const enqueue = (bot: string) => queueBuyerRenewal(subscription.id, project.id, customer.id, bot, false);
    assert.equal(await enqueue("original"), false);
    await prisma.payment.update({ where: { id: anchor.id }, data: { metadata: {
      source: "project_bot", projectBotId: "original", isRecurring: true
    } } });
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

test("a moderator ban surviving the timed removal blocks a paid member's return invite", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    const where = { botId: 64832n, telegramChatId: chat.telegramChatId, telegramUserId: customer.telegramUserId };
    await prisma.subscription.update({ where: { id: subscription.id }, data: { status: "ACTIVE", endsAt: new Date(Date.now() + 86_400_000) } });
    await prisma.telegramRemovalIntent.create({ data: { ...where, untilDate: Math.floor(Date.now() / 1000) - 1 } });
    const calls: string[] = [];
    const bot = { api: {
      getChatMember: async () => { calls.push("lookup"); return { status: "kicked", until_date: 0 }; },
      unbanChatMember: async () => { calls.push("unban"); return true; },
      createChatInviteLink: async () => { calls.push("invite"); return { invite_link: "unused" }; }
    } } as unknown as Bot;
    try {
      const result = await deliverSubscriptionAccess(bot, subscription.id, [String(chat.telegramChatId)]);
      assert.deepEqual(calls, ["lookup"]);
      assert.equal(result.links.length, 0);
      assert.equal(result.failed.length, 1);
      const row = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
      assert.equal(row.deliveryLastError, "SUBSCRIBER_ADMIN_BANNED");
    } finally {
      await prisma.telegramRemovalIntent.deleteMany({ where });
    }
  });
});


test("moderator exclusion is not overwritten by an expiry retry", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    await prisma.subscriptionAccessGrant.update({ where: { id: grant.id }, data: {
      revokedAt: new Date(), revocationReason: "ADMIN_EXCLUDED", joinedAt: null
    } });
    let bans = 0;
    let unbans = 0;
    const bot = { api: {
      revokeChatInviteLink: async () => true,
      getChatMember: async () => ({ status: "kicked" }),
      banChatMember: async () => { bans++; return true; },
      unbanChatMember: async () => { unbans++; return true; }
    } } as unknown as Bot;
    assert.equal(await reconcileSubscriptionAccessRemoval({
      bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId
    }), "INVITE_CLEANED");
    assert.equal(bans, 0);
    assert.equal(unbans, 0);
    const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
    assert.equal(saved.revocationReason, "ADMIN_EXCLUDED");
  });
});


test("a stale Stars worker cannot clear a successor claim while its Telegram request is in flight", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, project, customer }) => {
    const where = { id: subscription.id };
    const charge = "stars-successor-" + randomUUID();
    await prisma.subscription.update({ where, data: {
      status: "ACTIVE",
      endsAt: new Date(Date.now() + 86_400_000),
      telegramStarInitialChargeId: charge,
      telegramStarSubscriptionState: "ACTIVE"
    } });
    await prisma.payment.create({ data: {
      subscriptionId: subscription.id,
      projectId: project.id,
      customerId: customer.id,
      amount: "100",
      currency: "XTR",
      provider: "TELEGRAM_STARS",
      providerPaymentId: charge,
      status: "SUCCEEDED",
      metadata: { source: "project_bot", projectBotId: "original", isRecurring: true }
    } });
    assert.equal(await queueBuyerRenewal(subscription.id, project.id, customer.id, "original", true), true);

    const firstStarted = deferred();
    const finishFirst = deferred();
    const first = applyBuyerRenewal(subscription.id, "original", async args => {
      assert.equal(args.is_canceled, true);
      firstStarted.resolve();
      await finishFirst.promise;
      return true;
    });
    await firstStarted.promise;

    // Telegram confirms the cancellation update while the original API response
    // is still delayed. A buyer resume becomes the newer desired operation.
    await prisma.subscription.update({ where, data: {
      telegramStarSubscriptionState: "CANCELED",
      buyerStarsCanceled: false,
      buyerStarsClaim: null,
      buyerStarsDueAt: new Date(0)
    } });

    const secondStarted = deferred();
    const finishSecond = deferred();
    const second = applyBuyerRenewal(subscription.id, "original", async args => {
      assert.equal(args.is_canceled, false);
      secondStarted.resolve();
      await finishSecond.promise;
      return true;
    });
    await secondStarted.promise;

    const successorClaim = (await prisma.subscription.findUniqueOrThrow({ where })).buyerStarsClaim;
    assert.ok(successorClaim);

    finishFirst.resolve();
    assert.equal(await first, false);
    const whileSuccessorRuns = await prisma.subscription.findUniqueOrThrow({ where });
    assert.equal(whileSuccessorRuns.buyerStarsClaim, successorClaim);
    assert.ok(whileSuccessorRuns.buyerStarsDueAt && whileSuccessorRuns.buyerStarsDueAt > new Date());

    finishSecond.resolve();
    assert.equal(await second, true);
    const settled = await prisma.subscription.findUniqueOrThrow({ where });
    assert.equal(settled.telegramStarSubscriptionState, "ACTIVE");
    assert.equal(settled.buyerStarsCanceled, false);
    assert.equal(settled.buyerStarsClaim, null);
    assert.equal(settled.buyerStarsDueAt, null);
  });
});


test("authenticated Stars cancellation webhook wakes a pending admin revoke for worker finalization", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, project, customer }) => {
    const charge = "admin-webhook-" + randomUUID();
    const projectRow = await prisma.project.findUniqueOrThrow({
      where: { id: project.id }, select: { workspaceId: true }
    });
    const payment = await prisma.payment.create({ data: {
      subscriptionId: subscription.id,
      projectId: project.id,
      customerId: customer.id,
      amount: "100",
      currency: "XTR",
      provider: "TELEGRAM_STARS",
      providerPaymentId: charge,
      status: "SUCCEEDED",
      metadata: { source: "project_bot", projectBotId: "source-bot", isRecurring: true }
    } });
    await prisma.subscription.update({ where: { id: subscription.id }, data: {
      status: "ACTIVE",
      endsAt: new Date(Date.now() + 86_400_000),
      telegramStarInitialChargeId: charge,
      telegramStarSubscriptionState: "ACTIVE",
      adminStarsCancelPending: true,
      adminStarsCancelBotId: "source-bot",
      adminStarsCancelClaim: "stale-worker-claim",
      adminStarsCancelDueAt: new Date(Date.now() + 300_000),
      adminStarsCancelActorUserId: "audit-actor",
      adminStarsCancelWorkspaceId: projectRow.workspaceId
    } });

    await handleProjectBotUpdate("unused-test-token", project.id, "source-bot", {
      update_id: 987654,
      subscription: {
        user: { id: Number(customer.telegramUserId) },
        invoice_payload: payment.id,
        state: "canceled"
      }
    } as never, 987654, 0);

    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(updated.telegramStarSubscriptionState, "CANCELED");
    assert.equal(updated.telegramStarSubscriptionLastUpdateId, 987654);
    assert.equal(updated.adminStarsCancelPending, true);
    assert.equal(updated.adminStarsCancelClaim, null);
    assert.ok(updated.adminStarsCancelDueAt && updated.adminStarsCancelDueAt <= new Date());

    const { reconcileAdminStarsCancellation } = await import("@subpilot/payments");
    let repeatedTelegramCalls = 0;
    assert.equal(await reconcileAdminStarsCancellation(
      subscription.id,
      "source-bot",
      async () => { repeatedTelegramCalls += 1; return false; }
    ), true);
    assert.equal(repeatedTelegramCalls, 0);
    const finalized = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(finalized.status, "CANCELLED");
    assert.equal(finalized.adminStarsCancelPending, false);
    assert.equal(finalized.telegramStarSubscriptionState, "CANCELED");
  });
});


test("a recurring Stars payment arriving during admin cancellation is recorded but cannot restore access", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, project, customer, chat, plan, grant }) => {
    const initialCharge = "admin-pending-initial-" + randomUUID();
    const renewalCharge = "admin-pending-renewal-" + randomUUID();
    const endsAt = new Date(Date.now() + 7 * 86_400_000);
    const projectRow = await prisma.project.findUniqueOrThrow({
      where: { id: project.id }, select: { workspaceId: true }
    });
    await prisma.subscription.update({ where: { id: subscription.id }, data: {
      status: "ACTIVE",
      endsAt,
      telegramStarInitialChargeId: initialCharge,
      telegramStarSubscriptionState: "ACTIVE",
      adminStarsCancelPending: true,
      adminStarsCancelBotId: "source-bot",
      adminStarsCancelDueAt: new Date(0),
      adminStarsCancelClaim: null,
      adminStarsCancelActorUserId: "test-actor",
      adminStarsCancelWorkspaceId: projectRow.workspaceId
    } });
    const anchor = await prisma.payment.create({ data: {
      subscriptionId: subscription.id,
      projectId: project.id,
      customerId: customer.id,
      amount: "100",
      currency: "XTR",
      provider: "TELEGRAM_STARS",
      providerPaymentId: initialCharge,
      status: "SUCCEEDED",
      paidAt: new Date(Date.now() - 30 * 86_400_000),
      metadata: {
        source: "project_bot",
        productType: "TELEGRAM_CHANNEL_ACCESS",
        checkoutSurface: "TELEGRAM_BOT",
        projectBotId: "source-bot",
        planId: plan.id,
        planTitle: "Recurring plan",
        durationDays: 30,
        isRecurring: true,
        chatIds: [chat.telegramChatId.toString()]
      }
    } });

    const { reconcileAdminStarsCancellation } = await import("@subpilot/payments");
    const cancellationStarted = deferred();
    const finishCancellation = deferred();
    const adminCancellation = reconcileAdminStarsCancellation(
      subscription.id,
      "source-bot",
      async args => {
        assert.equal(args.telegram_payment_charge_id, initialCharge);
        cancellationStarted.resolve();
        await finishCancellation.promise;
        return true;
      }
    );
    await cancellationStarted.promise;

    const replies: string[] = [];
    const fakeBot = { api: { raw: {
      editUserStarSubscription: async () => true
    } } } as unknown as Bot;
    const fakeContext = {
      from: { id: Number(customer.telegramUserId) },
      message: { successful_payment: {
        invoice_payload: anchor.id,
        telegram_payment_charge_id: renewalCharge,
        provider_payment_charge_id: "provider-" + renewalCharge,
        currency: "XTR",
        total_amount: 100,
        is_recurring: true
      } },
      reply: async (message: string) => { replies.push(message); return {} as never; }
    } as never;

    await processSuccessfulStarsPayment(fakeBot, project.id, "source-bot", fakeContext);

    const [savedSubscription, savedRenewal, event, savedGrant] = await Promise.all([
      prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      prisma.payment.findFirst({ where: {
        provider: "TELEGRAM_STARS", providerPaymentId: renewalCharge
      } }),
      prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { dedupeKey: "telegram-stars:" + renewalCharge } }),
      prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } })
    ]);
    assert.equal(savedRenewal?.status, "SUCCEEDED");
    assert.equal(savedSubscription.status, "ACTIVE");
    assert.equal(savedSubscription.endsAt?.toISOString(), endsAt.toISOString());
    assert.equal(savedSubscription.adminStarsCancelPending, true);
    assert.equal(savedSubscription.telegramStarSubscriptionState, "ACTIVE");
    assert.equal(savedGrant.revokedAt, null);
    assert.equal((event.payload as Record<string, unknown>).accessSuppressedByAdminRevocation, true);
    assert.equal(replies.length, 1);
    assert.match(replies[0] ?? "", /срок доступа не продлён/);

    // The payment webhook completed while Telegram cancellation was still in
    // flight. The durable admin intent must win when the remote response returns.
    finishCancellation.resolve();
    assert.equal(await adminCancellation, true);
    const afterCancellation = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id }
    });
    assert.equal(afterCancellation.status, "CANCELLED");
    assert.equal(afterCancellation.adminStarsCancelPending, false);
    assert.equal(afterCancellation.telegramStarSubscriptionState, "CANCELED");
    const adminRevokeScope = await prisma.subscriptionAccessScope.findUniqueOrThrow({
      where: { customerId_connectedChatId: {
        customerId: customer.id, connectedChatId: chat.id
      } }
    });
    assert.equal(adminRevokeScope.desiredRevision, 1n);

    // Telegram may retry the same successful-payment update. It remains a
    // single ledger event and cannot reopen the now-cancelled subscription.
    await processSuccessfulStarsPayment(fakeBot, project.id, "source-bot", fakeContext);
    assert.equal(await prisma.payment.count({
      where: { provider: "TELEGRAM_STARS", providerPaymentId: renewalCharge }
    }), 1);
    assert.equal(await prisma.paymentWebhookEvent.count({
      where: { dedupeKey: "telegram-stars:" + renewalCharge }
    }), 1);
    const afterReplay = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id }
    });
    assert.equal(afterReplay.status, "CANCELLED");
  });
});


test("the authenticated Stars refund handler reconciles the charge once and ignores duplicate delivery", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, project, customer, chat }) => {
    const charge = "refund-handler-" + randomUUID();
    const startsAt = new Date(Date.now() - 30 * 86_400_000);
    const endsAt = new Date(Date.now() + 30 * 86_400_000);
    await prisma.subscription.update({ where: { id: subscription.id }, data: {
      status: "ACTIVE", startsAt, endsAt
    } });
    const payment = await prisma.payment.create({ data: {
      subscriptionId: subscription.id,
      projectId: project.id,
      customerId: customer.id,
      amount: "100",
      currency: "XTR",
      provider: "TELEGRAM_STARS",
      providerPaymentId: charge,
      status: "SUCCEEDED",
      paidAt: startsAt,
      metadata: {
        source: "project_bot",
        projectBotId: "source-bot",
        durationDays: 30,
        isRecurring: false
      }
    } });
    const context = {
      chat: { type: "private", id: Number(customer.telegramUserId) },
      message: { refunded_payment: {
        invoice_payload: payment.id,
        telegram_payment_charge_id: charge,
        currency: "XTR",
        total_amount: 100
      } }
    } as never;

    await processRefundedStarsPayment("source-bot", context);
    const refunded = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const expired = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    const scope = await prisma.subscriptionAccessScope.findUniqueOrThrow({
      where: { customerId_connectedChatId: { customerId: customer.id, connectedChatId: chat.id } }
    });
    assert.equal(refunded.status, "REFUNDED");
    assert.equal(expired.status, "EXPIRED");
    assert.ok(expired.endsAt);
    assert.equal(scope.desiredRevision, 1n);

    await processRefundedStarsPayment("source-bot", context);
    const duplicate = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    const duplicateScope = await prisma.subscriptionAccessScope.findUniqueOrThrow({
      where: { customerId_connectedChatId: { customerId: customer.id, connectedChatId: chat.id } }
    });
    assert.equal(duplicate.status, "EXPIRED");
    assert.equal(duplicateScope.desiredRevision, 1n);
  });
});


test("a pending admin Stars cancellation blocks buyer resume and keeps the remote desired state canceled", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, project, customer }) => {
    const charge = "admin-blocks-resume-" + randomUUID();
    await prisma.subscription.update({ where: { id: subscription.id }, data: {
      status: "ACTIVE",
      endsAt: new Date(Date.now() + 86_400_000),
      telegramStarInitialChargeId: charge,
      telegramStarSubscriptionState: "CANCELED",
      buyerStarsBotId: "source-bot",
      buyerStarsChargeId: charge,
      buyerStarsCanceled: false,
      buyerStarsDueAt: new Date(0),
      adminStarsCancelPending: true,
      adminStarsCancelBotId: "source-bot",
      adminStarsCancelDueAt: new Date(Date.now() + 300_000)
    } });
    await prisma.payment.create({ data: {
      subscriptionId: subscription.id,
      projectId: project.id,
      customerId: customer.id,
      amount: "100",
      currency: "XTR",
      provider: "TELEGRAM_STARS",
      providerPaymentId: charge,
      status: "SUCCEEDED",
      metadata: { source: "project_bot", projectBotId: "source-bot", isRecurring: true }
    } });

    assert.equal(await queueBuyerRenewal(subscription.id, project.id, customer.id, "source-bot", false), false);
    let requestedCanceledState: boolean | undefined;
    assert.equal(await applyBuyerRenewal(subscription.id, "source-bot", async args => {
      requestedCanceledState = args.is_canceled;
      return true;
    }), true);
    assert.equal(requestedCanceledState, true);
    const saved = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(saved.telegramStarSubscriptionState, "CANCELED");
    assert.equal(saved.adminStarsCancelPending, true);
    assert.equal(saved.buyerStarsDueAt, null);
  });
});


test("a late successful Stars payment reactivates an invoice-timed-out subscription, not an admin-revoked one", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, project, customer, chat, plan }) => {
    await prisma.subscriptionAccessGrant.deleteMany({
      where: { subscriptionId: subscription.id }
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(Date.now() - 60_000),
        adminAccessRevokedAt: null
      }
    });
    const payment = await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        amount: "100",
        currency: "XTR",
        status: "CANCELLED",
        metadata: {
          source: "project_bot",
          productType: "TELEGRAM_CHANNEL_ACCESS",
          checkoutSurface: "TELEGRAM_BOT",
          projectBotId: "source-bot",
          planId: plan.id,
          planTitle: "Revocation coordinator plan",
          durationDays: 30,
          isRecurring: false,
          chatIds: [chat.telegramChatId.toString()],
          invoiceDispatchStartedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString()
        }
      }
    });
    const fakeBot = {
      api: {
        getChatMember: async () => ({ status: "member" })
      }
    } as unknown as Bot;
    const fakeContext = {
      from: { id: Number(customer.telegramUserId) },
      message: {
        successful_payment: {
          invoice_payload: payment.id,
          telegram_payment_charge_id: "late-timeout-charge-" + randomUUID(),
          currency: "XTR",
          total_amount: 100
        }
      },
      reply: async () => ({} as never)
    } as never;

    await processSuccessfulStarsPayment(fakeBot, project.id, "source-bot", fakeContext);

    const [savedSubscription, savedPayment, event, savedGrant] = await Promise.all([
      prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
      prisma.paymentWebhookEvent.findFirst({
        where: { dedupeKey: { startsWith: "telegram-stars:late-timeout-charge-" } }
      }),
      prisma.subscriptionAccessGrant.findFirst({ where: { subscriptionId: subscription.id } })
    ]);
    assert.equal(savedPayment.status, "SUCCEEDED");
    assert.equal(savedSubscription.status, "ACTIVE");
    assert.equal(savedSubscription.adminAccessRevokedAt, null);
    assert.ok(savedSubscription.endsAt && savedSubscription.endsAt > new Date());
    assert.equal((event?.payload as Record<string, unknown> | undefined)?.accessSuppressedByAdminRevocation, false);
    assert.ok(savedGrant);
  });
});


test("a late payment cannot reopen a subscription with an explicit admin revocation marker", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, project, customer, chat, plan }) => {
    const revokedAt = new Date(Date.now() - 60_000);
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "CANCELLED",
        cancelledAt: revokedAt,
        adminAccessRevokedAt: revokedAt
      }
    });
    const payment = await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        amount: "100",
        currency: "XTR",
        status: "CANCELLED",
        metadata: {
          source: "project_bot",
          productType: "TELEGRAM_CHANNEL_ACCESS",
          checkoutSurface: "TELEGRAM_BOT",
          projectBotId: "source-bot",
          planId: plan.id,
          planTitle: "Revocation coordinator plan",
          durationDays: 30,
          isRecurring: false,
          chatIds: [chat.telegramChatId.toString()],
          invoiceDispatchStartedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString()
        }
      }
    });
    const fakeContext = {
      from: { id: Number(customer.telegramUserId) },
      message: {
        successful_payment: {
          invoice_payload: payment.id,
          telegram_payment_charge_id: "admin-revoked-late-charge-" + randomUUID(),
          currency: "XTR",
          total_amount: 100
        }
      },
      reply: async () => ({} as never)
    } as never;

    await processSuccessfulStarsPayment({ api: {} } as unknown as Bot, project.id, "source-bot", fakeContext);

    const [savedSubscription, savedPayment, event] = await Promise.all([
      prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
      prisma.paymentWebhookEvent.findFirst({
        where: { dedupeKey: { startsWith: "telegram-stars:admin-revoked-late-charge-" } }
      })
    ]);
    assert.equal(savedPayment.status, "SUCCEEDED");
    assert.equal(savedSubscription.status, "CANCELLED");
    assert.equal(savedSubscription.adminAccessRevokedAt?.toISOString(), revokedAt.toISOString());
    assert.equal((event?.payload as Record<string, unknown> | undefined)?.accessSuppressedByAdminRevocation, true);
  });
});


test("stale invoice cleanup keeps dispatched Telegram invoices payable and cancels only never-dispatched payments", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, project, customer }) => {
    const createdAt = new Date(Date.now() - 25 * 60 * 60_000);
    const dispatched = await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        amount: "100",
        currency: "XTR",
        status: "PENDING",
        createdAt,
        metadata: {
          source: "project_bot",
          projectBotId: "source-bot",
          invoiceDispatchStartedAt: createdAt.toISOString()
        }
      }
    });
    const notDispatched = await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        amount: "100",
        currency: "XTR",
        status: "PENDING",
        createdAt,
        metadata: { source: "project_bot", projectBotId: "source-bot" }
      }
    });

    await cancelStalePendingPayments(new Date(), () => true);

    const [savedDispatched, savedNotDispatched] = await Promise.all([
      prisma.payment.findUniqueOrThrow({ where: { id: dispatched.id } }),
      prisma.payment.findUniqueOrThrow({ where: { id: notDispatched.id } })
    ]);
    assert.equal(savedDispatched.status, "PENDING");
    assert.equal(savedNotDispatched.status, "CANCELLED");
  });
});


test("a first recurring Stars charge anchors and activates the subscription exactly once", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, project, customer, chat, plan }) => {
    const charge = "first-recurring-" + randomUUID();
    const expiration = Math.floor((Date.now() + 30 * 86_400_000) / 1000);
    await prisma.creatorPlan.update({
      where: { id: plan.id },
      data: { isRecurring: true, durationDays: 30 }
    });
    await prisma.subscriptionAccessGrant.deleteMany({ where: { subscriptionId: subscription.id } });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "PENDING",
        startsAt: null,
        endsAt: null,
        cancelledAt: null,
        telegramStarInitialChargeId: null,
        telegramStarSubscriptionState: null,
        adminAccessRevokedAt: null
      }
    });
    const payment = await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        amount: "100",
        currency: "XTR",
        status: "PENDING",
        metadata: {
          source: "project_bot",
          productType: "TELEGRAM_CHANNEL_ACCESS",
          checkoutSurface: "TELEGRAM_BOT",
          projectBotId: "source-bot",
          planId: plan.id,
          planTitle: "Revocation coordinator plan",
          durationDays: 30,
          isRecurring: true,
          chatIds: [chat.telegramChatId.toString()]
        }
      }
    });
    const fakeBot = {
      api: { getChatMember: async () => ({ status: "member" }) }
    } as unknown as Bot;
    const fakeContext = {
      from: { id: Number(customer.telegramUserId) },
      message: {
        successful_payment: {
          invoice_payload: payment.id,
          telegram_payment_charge_id: charge,
          provider_payment_charge_id: "provider-" + charge,
          currency: "XTR",
          total_amount: 100,
          subscription_expiration_date: expiration,
          is_recurring: true,
          is_first_recurring: true
        }
      },
      reply: async () => ({} as never)
    } as never;

    await processSuccessfulStarsPayment(fakeBot, project.id, "source-bot", fakeContext);
    const first = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(first.status, "ACTIVE");
    assert.equal(first.telegramStarInitialChargeId, charge);
    assert.equal(first.telegramStarSubscriptionState, "ACTIVE");
    assert.equal(first.endsAt?.getTime(), expiration * 1000);

    await processSuccessfulStarsPayment(fakeBot, project.id, "source-bot", fakeContext);
    const [savedPayment, savedSubscription, eventCount, chargeCount, grantCount] = await Promise.all([
      prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
      prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      prisma.paymentWebhookEvent.count({ where: { dedupeKey: "telegram-stars:" + charge } }),
      prisma.payment.count({ where: { provider: "TELEGRAM_STARS", providerPaymentId: charge } }),
      prisma.subscriptionAccessGrant.count({ where: { subscriptionId: subscription.id } })
    ]);
    assert.equal(savedPayment.status, "SUCCEEDED");
    assert.equal(savedSubscription.endsAt?.getTime(), expiration * 1000);
    assert.equal(eventCount, 1);
    assert.equal(chargeCount, 1);
    assert.equal(grantCount, 1);
  });
});


test("a recurring Stars renewal creates one charge ledger row and extends from the Telegram expiration", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, project, customer, chat, plan }) => {
    const initialCharge = "renewal-anchor-" + randomUUID();
    const renewalCharge = "renewal-charge-" + randomUUID();
    const now = Date.now();
    const currentEnd = new Date(now + 10 * 86_400_000);
    const renewedEndSeconds = Math.floor((now + 40 * 86_400_000) / 1000);
    await prisma.creatorPlan.update({
      where: { id: plan.id },
      data: { isRecurring: true, durationDays: 30 }
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "ACTIVE",
        startsAt: new Date(now - 30 * 86_400_000),
        endsAt: currentEnd,
        telegramStarInitialChargeId: initialCharge,
        telegramStarSubscriptionState: "ACTIVE",
        adminAccessRevokedAt: null
      }
    });
    const anchor = await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        providerPaymentId: initialCharge,
        amount: "100",
        currency: "XTR",
        status: "SUCCEEDED",
        paidAt: new Date(now - 30 * 86_400_000),
        metadata: {
          source: "project_bot",
          productType: "TELEGRAM_CHANNEL_ACCESS",
          checkoutSurface: "TELEGRAM_BOT",
          projectBotId: "source-bot",
          planId: plan.id,
          planTitle: "Revocation coordinator plan",
          durationDays: 30,
          isRecurring: true,
          chatIds: [chat.telegramChatId.toString()]
        }
      }
    });
    const fakeBot = {
      api: {
        getChatMember: async () => ({ status: "member" }),
        revokeChatInviteLink: async () => true
      }
    } as unknown as Bot;
    const fakeContext = {
      from: { id: Number(customer.telegramUserId) },
      message: {
        successful_payment: {
          invoice_payload: anchor.id,
          telegram_payment_charge_id: renewalCharge,
          provider_payment_charge_id: "provider-" + renewalCharge,
          currency: "XTR",
          total_amount: 100,
          subscription_expiration_date: renewedEndSeconds,
          is_recurring: true
        }
      },
      reply: async () => ({} as never)
    } as never;

    await processSuccessfulStarsPayment(fakeBot, project.id, "source-bot", fakeContext);
    const first = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    assert.equal(first.endsAt?.getTime(), renewedEndSeconds * 1000);
    assert.equal(first.telegramStarInitialChargeId, initialCharge);

    await processSuccessfulStarsPayment(fakeBot, project.id, "source-bot", fakeContext);
    const [saved, savedSubscription, eventCount] = await Promise.all([
      prisma.payment.findFirstOrThrow({
        where: { subscriptionId: subscription.id, providerPaymentId: renewalCharge }
      }),
      prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      prisma.paymentWebhookEvent.count({ where: { dedupeKey: "telegram-stars:" + renewalCharge } })
    ]);
    const metadata = saved.metadata as Record<string, unknown>;
    assert.equal(saved.status, "SUCCEEDED");
    assert.equal(metadata.originalPaymentId, anchor.id);
    assert.equal(metadata.isRenewal, true);
    assert.equal(savedSubscription.endsAt?.getTime(), renewedEndSeconds * 1000);
    assert.equal(eventCount, 1);
  });
});

test("moderation review queue is durable, project-scoped and denies unauthorized readers", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant, project }) => {
    await prisma.subscriptionAccessGrant.update({
      where: { id: grant.id },
      data: {
        revocationLastError: "MEMBER_MODERATION_REVIEW_REQUIRED",
        revocationNextAttemptAt: new Date("2100-01-01T00:00:00.000Z")
      }
    });
    const owner = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { workspace: { select: { createdById: true } } }
    });
    assert.equal(await listPendingAccessModerationReviews(project.id, "unauthorized"), null);
    const rows = await listPendingAccessModerationReviews(project.id, owner.workspace.createdById);
    assert.ok(rows);
    const row = rows.find((item) => item.grantId === grant.id);
    assert.ok(row);
    assert.equal(row.telegramChatId, chat.telegramChatId.toString());
    assert.equal(row.telegramUserId, customer.telegramUserId.toString());
    assert.equal(row.subscriptionId, subscription.id);
    assert.equal(row.reason, "MEMBER_MODERATION_REVIEW_REQUIRED");
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "ACTIVE", endsAt: new Date(Date.now() + 86_400_000) }
    });
    const afterRenewal = await listPendingAccessModerationReviews(
      project.id, owner.workspace.createdById
    );
    assert.ok(afterRenewal);
    assert.equal(afterRenewal.some((item) => item.grantId === grant.id), false,
      "a newly active paid entitlement must not be shown as a pending expiry review");
    assert.equal((await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    })).revokedAt, null, "reading the queue must not acknowledge membership removal");
  });
});


test("moderation preflight is read-only and never unbans a Telegram member", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ grant, project }) => {
    await prisma.subscriptionAccessGrant.update({
      where: { id: grant.id },
      data: { revocationLastError: "MEMBER_MODERATION_REVIEW_REQUIRED" }
    });
    const owner = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { workspace: { select: { createdById: true } } }
    });
    let lookups = 0;
    let unbans = 0;
    const bot = {
      api: {
        getChatMember: async () => { lookups += 1; return { status: "kicked" }; },
        unbanChatMember: async () => { unbans += 1; return true; }
      }
    } as unknown as Bot;
    assert.deepEqual(await inspectPendingAccessModerationReview(
      project.id, "unauthorized", grant.id, bot
    ), { state: "UNAUTHORIZED" });
    assert.equal(lookups, 0);
    const result = await inspectPendingAccessModerationReview(
      project.id, owner.workspace.createdById, grant.id, bot
    );
    assert.equal(result.state, "REVIEW_REQUIRED");
    if (result.state === "REVIEW_REQUIRED") assert.equal(result.membership, "kicked");
    assert.equal(lookups, 1);
    assert.equal(unbans, 0);
    assert.equal((await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    })).revokedAt, null);
  });
});


test("moderation resolution confirms absence once and writes an audit log", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ grant, project, subscription }) => {
    await prisma.subscriptionAccessGrant.update({
      where: { id: grant.id },
      data: {
        revocationLastError: "MEMBER_MODERATION_REVIEW_REQUIRED",
        expiresAt: new Date(Date.now() - 60_000)
      }
    });
    const owner = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { workspace: { select: { createdById: true } } }
    });
    let bans = 0;
    const bot = {
      api: {
        getChatMember: async () => ({ status: "left" }),
        banChatMember: async () => { bans += 1; return true; }
      }
    } as unknown as Bot;
    const actor = owner.workspace.createdById;
    assert.equal(await confirmPendingAccessModerationReview(project.id, "stranger", grant.id, bot), "UNAUTHORIZED");
    assert.equal(await confirmPendingAccessModerationReview(project.id, actor, grant.id, bot), "CONFIRMED");
    assert.equal(await confirmPendingAccessModerationReview(project.id, actor, grant.id, bot), "NO_LONGER_PENDING");
    const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
    assert.ok(saved.revokedAt);
    assert.equal(saved.revocationReason, "SUBSCRIPTION_EXPIRED");
    assert.equal(bans, 0);
    const audits = await prisma.auditLog.findMany({
      where: { projectId: project.id, resourceId: grant.id, action: "ACCESS_MODERATION_REVIEW_CONFIRMED" }
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.actorUserId, actor);
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status, "EXPIRED");
  });
});

test("moderation resolution refuses to close a case while the member is present or invite is valid", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ grant, project }) => {
    await prisma.subscriptionAccessGrant.update({
      where: { id: grant.id },
      data: { revocationLastError: "MEMBER_MODERATION_REVIEW_REQUIRED" }
    });
    const owner = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { workspace: { select: { createdById: true } } }
    });
    const actor = owner.workspace.createdById;
    const presentBot = { api: { getChatMember: async () => ({ status: "member" }) } } as unknown as Bot;
    const absentBot = { api: { getChatMember: async () => ({ status: "left" }) } } as unknown as Bot;
    assert.equal(await confirmPendingAccessModerationReview(project.id, actor, grant.id, presentBot), "MEMBER_STILL_PRESENT");
    assert.equal(await confirmPendingAccessModerationReview(project.id, actor, grant.id, absentBot), "INVITE_CLEANUP_REQUIRED");
    assert.equal((await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    })).revokedAt, null);
  });
});


test("manual moderation confirmation waits for an active access scope worker", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ grant, project, subscription }) => {
    await prisma.subscriptionAccessGrant.update({
      where: { id: grant.id },
      data: {
        revocationLastError: "MEMBER_MODERATION_REVIEW_REQUIRED",
        expiresAt: new Date(Date.now() - 60_000)
      }
    });
    const owner = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { workspace: { select: { createdById: true } } }
    });
    const scopedGrant = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id },
      select: { connectedChatId: true }
    });
    const persistedSubscription = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id },
      select: { customerId: true }
    });
    await prisma.subscriptionAccessScope.upsert({
      where: {
        customerId_connectedChatId: {
          customerId: persistedSubscription.customerId,
          connectedChatId: scopedGrant.connectedChatId
        }
      },
      create: {
        customerId: persistedSubscription.customerId,
        connectedChatId: scopedGrant.connectedChatId,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000)
      },
      update: {
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000)
      }
    });
    const bot = { api: { getChatMember: async () => ({ status: "left" }) } } as unknown as Bot;
    assert.equal(await confirmPendingAccessModerationReview(
      project.id, owner.workspace.createdById, grant.id, bot
    ), "RECONCILIATION_IN_PROGRESS");
    assert.equal((await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    })).revokedAt, null);
  });
});

test("administrative cancellation removes a joined channel subscriber and verifies absence before finalizing", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    await prisma.subscription.update({ where: { id: subscription.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const calls: string[] = [];
    let kicked = false;
    const bot = { api: {
      revokeChatInviteLink: async () => true,
      getChatMember: async () => { calls.push("lookup"); return { status: kicked ? "kicked" : "member" }; },
      banChatMember: async (...args: unknown[]) => {
        assert.deepEqual(args, [String(chat.telegramChatId), Number(customer.telegramUserId)]);
        calls.push("ban");
        kicked = true;
        return true;
      }
    } } as unknown as Bot;
    const input = { bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId };
    assert.equal(await reconcileSubscriptionAccessRemoval(input), "REVOKED");
    assert.equal(await reconcileSubscriptionAccessRemoval(input), "SKIPPED");
    assert.deepEqual(calls, ["lookup", "ban", "lookup"]);
    const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
    assert.ok(saved.revokedAt);
    assert.equal(saved.revocationReason, "ADMIN_REVOKED");
  });
});

test("unconfirmed Telegram ban remains under review without a second ban attempt", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "CANCELLED", cancelledAt: new Date() }
    });
    let bans = 0;
    const bot = { api: {
      revokeChatInviteLink: async () => true,
      getChatMember: async () => ({ status: "member" }),
      banChatMember: async () => { bans++; return true; },
      unbanChatMember: async () => { throw new Error("Must never unban"); }
    } } as unknown as Bot;
    const input = {
      bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId
    };
    assert.equal(await reconcileSubscriptionAccessRemoval(input), "FAILED");
    const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
    assert.equal(saved.revokedAt, null);
    assert.equal(saved.revocationLastError, "MEMBER_MODERATION_REVIEW_REQUIRED");
    assert.equal(bans, 1);
    // An ambiguous result must not generate a second mutation on retry.
    assert.equal(await reconcileSubscriptionAccessRemoval(input), "SKIPPED");
    assert.equal(bans, 1);
  });
});

test("moderation committed during an in-flight ban survives a late Telegram error", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, customer, chat, grant, project }) => {
    const bot = { api: {
      revokeChatInviteLink: async () => true,
      getChatMember: async () => ({ status: "member" }),
      banChatMember: async () => {
        await prisma.$transaction(async (tx) => {
          await lockSubscriptionAccessScope(tx, customer.id, chat.id);
          await tx.subscriptionAccessGrant.update({ where: { id: grant.id }, data: {
            revokedAt: new Date(), revocationReason: "ADMIN_EXCLUDED", revocationLastError: null
          } });
          await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id]);
        });
        throw new Error("telegram response lost");
      }
    } } as unknown as Bot;
    await reconcileSubscriptionAccessRemoval({
      bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId
    });
    const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
    assert.equal(saved.revocationReason, "ADMIN_EXCLUDED");
    assert.equal(saved.revocationLastError, null);
    assert.equal(saved.revocationAttempts, 0);
    assert.equal(await prisma.ownerNotification.count({ where: { projectId: project.id, eventType: "ACCESS_MODERATION_REVIEW" } }), 0);
  });
});

test("successor observes an applied ban after worker loss before finalization", { skip: !process.env.DATABASE_URL }, async () => {
  await withFixture(async ({ subscription, customer, chat, grant }) => {
    let owned = true;
    let bans = 0;
    let observations = 0;
    const bot = { api: {
      revokeChatInviteLink: async () => true,
      getChatMember: async () => { observations++; return { status: bans ? "kicked" : "member" }; },
      banChatMember: async () => { bans++; owned = false; return true; }
    } } as unknown as Bot;
    const input = { bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId };
    assert.equal(await reconcileSubscriptionAccessRemoval({ ...input, isLifecycleLeaseOwned: () => owned }), "LEASE_LOST");
    const where = { id: grant.id };
    const interrupted = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where });
    assert.equal(interrupted.revokedAt, null);
    assert.equal(interrupted.revocationLastError, "MEMBER_BAN_IN_PROGRESS");
    await prisma.subscriptionAccessScope.update({
      where: { customerId_connectedChatId: { customerId: customer.id, connectedChatId: chat.id } },
      data: { leaseExpiresAt: new Date(0) }
    });
    assert.equal(await reconcileSubscriptionAccessRemoval(input), "FAILED");
    const parked = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where });
    assert.equal(parked.revocationLastError, "MEMBER_BAN_OWNERSHIP_UNCERTAIN");
    assert.equal(parked.revokedAt, null);
    assert.equal(observations, 2);
    assert.equal(bans, 1);
  });
});

test("a fresh process reconciles a confirmed Telegram ban after SIGKILL and natural lease expiry", {
  skip: !process.env.DATABASE_URL, timeout: 120_000
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant, project }) => {
    let banned = false;
    let pauseVerification = true;
    const verification = deferred();
    const calls: string[] = [];
    const server = createServer((req, res) => {
      const method = req.url?.split("/").pop() ?? "";
      calls.push(method);
      if (method === "getChatMember" && banned && pauseVerification) {
        verification.resolve();
        return; // First process has received the successful ban reply.
      }
      if (method === "banChatMember") banned = true;
      const result = method === "getChatMember" ? { status: banned ? "kicked" : "member" } : true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const args = [String(address.port), subscription.id, customer.id, chat.id, String(customer.telegramUserId)];
    const start = () => fork(new URL("./test-fixtures/removal-process.ts", import.meta.url), args, {
      execArgv: ["--import", "tsx"]
    });
    const child = start();
    const exited = once(child, "exit");
    try {
      await Promise.race([verification.promise, exited.then(() => { throw new Error("Worker exited before verification"); }),
        delay(20_000, undefined, { ref: false }).then(() => { throw new Error("Ban verification timed out"); })]);
      child.kill("SIGKILL");
      assert.deepEqual(await exited, [null, "SIGKILL"]);
      pauseVerification = false;
      const where = { id: grant.id };
      const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where });
      assert.equal(saved.revokedAt, null);
      assert.equal(saved.revocationLastError, "MEMBER_BAN_IN_PROGRESS");
      const scope = await prisma.subscriptionAccessScope.findUniqueOrThrow({
        where: { customerId_connectedChatId: { customerId: customer.id, connectedChatId: chat.id } }
      });
      assert.ok(scope.leaseExpiresAt);
      // Allow for database/runner clock skew and lease expiry visibility on CI.
      await delay(Math.max(0, scope.leaseExpiresAt.getTime() - Date.now()) + 1_500);
      // A replacement may race with the database lease deadline. Retry only
      // LEASE_BUSY in a fresh process; no Telegram mutation should occur then.
      let recoveredResult: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        const successor = start();
        try {
          let result: unknown;
          successor.on("message", value => { result = value; });
          assert.deepEqual(await once(successor, "exit"), [0, null]);
          recoveredResult = result;
        } finally {
          if (successor.exitCode === null && successor.signalCode === null) successor.kill("SIGKILL");
        }
        if (recoveredResult !== "LEASE_BUSY") break;
        await delay(2_000);
      }
      assert.equal(recoveredResult, "FAILED"); // Deliberate escalation to the owner.
      const recovered = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where });
      assert.equal(recovered.revocationLastError, "MEMBER_BAN_OWNERSHIP_UNCERTAIN");
      assert.equal(recovered.revokedAt, null);
      assert.equal(await prisma.ownerNotification.count({
        where: { projectId: project.id, eventType: "ACCESS_MODERATION_REVIEW" }
      }), 1);
      assert.deepEqual(calls.filter(call => call !== "revokeChatInviteLink"),
        ["getChatMember", "banChatMember", "getChatMember", "getChatMember"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

test("default removal revokes the invite and escalates joined membership without a Telegram ban", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant, project }) => {
    const calls: string[] = [];
    const bot = { api: {
      revokeChatInviteLink: async () => { calls.push("revoke invite"); return true; },
      getChatMember: async () => { calls.push("check membership"); return { status: "member" }; },
      banChatMember: async () => { calls.push("ban"); return true; },
      unbanChatMember: async () => { calls.push("unban"); return true; }
    } } as unknown as Bot;
    const input = { bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId };
    assert.equal(await reconcileRemoval(input), "FAILED");
    assert.equal(await reconcileRemoval(input), "SKIPPED");
    assert.deepEqual(calls, ["revoke invite", "check membership"]);
    const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
    assert.equal(saved.revokedAt, null);
    assert.equal(saved.revocationLastError, "MEMBER_MODERATION_REVIEW_REQUIRED");
    assert.ok(saved.revocationNextAttemptAt > new Date());
    assert.equal(await prisma.ownerNotification.count({
      where: { projectId: project.id, eventType: "ACCESS_MODERATION_REVIEW" }
    }), 1);
  });
});

for (const event of ["moderator exclusion", "foreign entrant", "stale invite entrant"] as const) {
  test("chat_member preserves a concurrent regrant after a delayed invite failure: " + event, {
    skip: !process.env.DATABASE_URL
  }, async () => {
    await withFixture(async ({ subscription, customer, chat, grant, project }) => {
      const telegramChatId = -(1_000_000_000_000 + Number(customer.telegramUserId));
      await prisma.connectedChat.update({ where: { id: chat.id }, data: { telegramChatId } });
      const bot = await prisma.projectBot.create({ data: {
        projectId: project.id, telegramBotId: chat.telegramChatId, tokenEncrypted: "unused-test-token"
      } });
      const isExclusion = event === "moderator exclusion";
      const userId = Number(customer.telegramUserId) + (event === "foreign entrant" ? 1 : 0);
      const user = { id: userId, is_bot: false, first_name: "Test user" };
      const moderator = { id: userId + 2, is_bot: false, first_name: "Moderator" };
      const oldUrl = (await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } })).inviteLink;
      const replacementUrl = "https://t.me/+handler-regrant-" + randomUUID();
      if (!isExclusion) {
        await prisma.subscriptionAccessGrant.update({ where: { id: grant.id }, data: {
          revokedAt: new Date(), revocationReason: "ADMIN_EXCLUDED", joinedAt: null
        } });
      }
      const methods: string[] = [];
      const botApi = new Bot("42:test");
      botApi.api.config.use(async (_previous, method, payload) => {
        if (method === "getMe") return {
          ok: true, result: { id: 42, is_bot: true, first_name: "Bot", username: "test_bot" }
        } as never;
        methods.push(method);
        if (method === "getChatMember") return { ok: true, result: { status: "member", user } } as never;
        assert.equal(method, "revokeChatInviteLink");
        assert.equal((payload as { invite_link: string }).invite_link, oldUrl);
        // Commit the regrant while the handler is awaiting the old URL's revoke.
        await prisma.$transaction(async (tx) => {
          await tx.subscription.update({ where: { id: subscription.id }, data: {
            status: "ACTIVE", endsAt: new Date(Date.now() + 86_400_000)
          } });
          await tx.subscriptionAccessGrant.update({ where: { id: grant.id }, data: {
            inviteLink: replacementUrl, expiresAt: new Date(Date.now() + 60_000), joinedAt: null,
            revokedAt: null, revocationReason: null, revocationAttempts: 0, revocationLastError: null
          } });
          await lockSubscriptionAccessScope(tx, customer.id, chat.id);
          await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id]);
        });
        return { ok: false, error_code: 500, description: "Simulated delayed revoke failure" };
      });
      await handleProjectBotUpdate("42:test", project.id, bot.id, {
        update_id: 321, chat_member: {
          date: Math.floor(Date.now() / 1000),
          chat: { id: telegramChatId, type: "channel", title: "Test channel" },
          from: isExclusion ? moderator : user,
          old_chat_member: { user, status: isExclusion ? "member" : "left" },
          new_chat_member: isExclusion ? { user, status: "kicked", until_date: 0 } : { user, status: "member" },
          invite_link: { invite_link: oldUrl, creator: moderator, creates_join_request: false,
            is_primary: false, is_revoked: false }
        }
      }, 321, 0, botApi);
      const saved = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
      assert.equal(saved.inviteLink, replacementUrl);
      assert.equal(saved.revokedAt, null);
      assert.equal(saved.joinedAt, null);
      assert.equal(saved.revocationAttempts, 0);
      assert.equal(saved.revocationLastError, null);
      assert.deepEqual(methods, event === "foreign entrant" ? ["revokeChatInviteLink", "getChatMember"] : ["revokeChatInviteLink"]);
    });
  });
}

test("default review preserves membership until an authorized operator observes absence", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ subscription, customer, chat, grant, project }) => {
    const { workspaceId, workspace } = await prisma.project.findUniqueOrThrow({
      where: { id: project.id }, select: { workspaceId: true, workspace: { select: { createdById: true } } }
    });
    const actor = workspace.createdById;
    let status = "member";
    let lookups = 0;
    const bot = { api: {
      revokeChatInviteLink: async () => true,
      getChatMember: async () => { lookups++; return { status }; }
    } } as unknown as Bot;
    const verify = () => confirmPendingAccessModerationReview(project.id, actor, grant.id, bot);
    assert.equal(await reconcileRemoval({ bot, subscriptionId: subscription.id, customerId: customer.id,
      connectedChatId: chat.id, telegramUserId: customer.telegramUserId }), "FAILED");
    const parked = await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
    assert.equal(parked.inviteLink, "");
    assert.equal(parked.revokedAt, null);
    assert.equal(lookups, 1);
    const memberKey = { workspaceId_userId: { workspaceId, userId: actor } };
    for (const role of ["MANAGER", "VIEWER"] as const) {
      await prisma.workspaceMember.update({ where: memberKey, data: { role } });
      assert.equal(await listPendingAccessModerationReviews(project.id, actor), null);
      assert.equal(await verify(), "UNAUTHORIZED");
    }
    assert.equal(lookups, 1);
    await prisma.workspaceMember.update({ where: memberKey, data: { role: "ADMIN" } });
    assert.equal(await verify(), "MEMBER_STILL_PRESENT");
    status = "left";
    assert.equal(await verify(), "CONFIRMED");
    assert.equal(await verify(), "NO_LONGER_PENDING");
    assert.deepEqual(await listPendingAccessModerationReviews(project.id, actor), []);
    assert.equal(await prisma.auditLog.count({ where: { projectId: project.id, resourceId: grant.id,
      action: "ACCESS_MODERATION_REVIEW_CONFIRMED", actorUserId: actor } }), 1);
  });
});

test("a delayed manual membership check cannot close a new scope revision", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withFixture(async ({ customer, chat, grant, project }) => {
    const owner = await prisma.project.findUniqueOrThrow({
      where: { id: project.id }, select: { workspace: { select: { createdById: true } } }
    });
    await prisma.subscriptionAccessGrant.update({ where: { id: grant.id },
      data: { inviteLink: "", revocationLastError: "MEMBER_MODERATION_REVIEW_REQUIRED" } });
    const bot = { api: { getChatMember: async () => {
      await prisma.$transaction(async (tx) => {
        await lockSubscriptionAccessScope(tx, customer.id, chat.id);
        await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id]);
      });
      return { status: "left" };
    } } } as unknown as Bot;
    assert.equal(await confirmPendingAccessModerationReview(project.id, owner.workspace.createdById, grant.id, bot), "CASE_CHANGED");
    assert.equal((await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt, null);
    assert.equal(await prisma.auditLog.count({ where: { projectId: project.id, action: "ACCESS_MODERATION_REVIEW_CONFIRMED" } }), 0);
  });
});

test("control bot exposes parked cases through the project menu and handles a disconnected project bot", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { createControlBot } = await import("../../control-bot/src/bot.js");
  await withFixture(async ({ customer, grant, project }) => {
    const { workspaceId } = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const actor = await prisma.user.create({ data: { telegramId: customer.telegramUserId } });
    try {
      await prisma.workspaceMember.create({ data: { workspaceId, userId: actor.id, role: "ADMIN" } });
      await prisma.subscriptionAccessGrant.update({ where: { id: grant.id },
        data: { revocationLastError: "MEMBER_MODERATION_REVIEW_REQUIRED" } });
      const bot = createControlBot("42:offline");
      bot.botInfo = { id: 42, is_bot: true, first_name: "Control", username: "test_bot" } as typeof bot.botInfo;
      const replies: string[] = [];
      bot.api.config.use(async (_prev, method, payload) => {
        if (method !== "answerCallbackQuery") replies.push(JSON.stringify(payload));
        return { ok: true, result: true } as never;
      });
      const from = { id: Number(actor.telegramId), is_bot: false, first_name: "Operator" };
      let updateId = 0;
      const press = async (data: string) => {
        replies.length = 0;
        await bot.handleUpdate({ update_id: ++updateId, callback_query: {
          id: String(updateId), from, chat_instance: "test", data, message: {
            message_id: 1, date: 1, chat: { id: from.id, type: "private", first_name: from.first_name },
            from: bot.botInfo, text: "Menu"
          }
        } });
        assert.equal(replies.length, 1);
        return replies[0]!;
      };
      assert.ok((await press("ui:subaccess:" + project.id)).includes("review:0:" + project.id));
      assert.ok((await press("review:0:" + project.id)).includes("verify:" + grant.id));
      assert.match(await press("verify:" + grant.id), /Подключите бота проекта/);
      await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: actor.id } },
        data: { role: "VIEWER" } });
      assert.match(await press("verify:" + grant.id), /недоступна/);
      assert.equal((await prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt, null);
    } finally {
      await prisma.user.delete({ where: { id: actor.id } });
    }
  });
});
