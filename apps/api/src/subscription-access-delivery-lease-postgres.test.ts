import { compensateInvite, retryInviteCompensation } from "./invite-compensation.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Bot } from "grammy";
import { prisma } from "@subpilot/database";
import {
  claimSubscriptionAccessScope,
  lockSubscriptionAccessScope,
  requestSubscriptionAccessReconciliation
} from "@subpilot/payments";
import { deliverSubscriptionAccess } from "./project-bot-updates.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T extends void ? undefined : T) => void;
} {
  let resolve!: (value: T extends void ? undefined : T) => void;
  const promise = new Promise<T>((done) => { resolve = done as typeof resolve; });
  return { promise, resolve };
}

async function withDeliveryFixture(run: (fixture: {
  suffix: string;
  subscription: { id: string };
  customer: { id: string };
  chat: { id: string; telegramChatId: bigint };
}) => Promise<void>): Promise<void> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let actorId: string | undefined;
  let workspaceId: string | undefined;
  try {
    const actor = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Access delivery lease test" }
    });
    actorId = actor.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Access delivery lease " + suffix,
        slug: "access-delivery-lease-" + suffix,
        createdById: actor.id,
        members: { create: { userId: actor.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Access delivery lease project",
        slug: "access-delivery-" + suffix
      }
    });
    const plan = await prisma.creatorPlan.create({
      data: {
        projectId: project.id,
        title: "Access delivery lease plan",
        price: "250",
        currency: "XTR",
        durationDays: 30
      }
    });
    const customer = await prisma.projectCustomer.create({
      data: {
        projectId: project.id,
        telegramUserId: BigInt(Date.now() % 1_000_000_000) + 100_000_000n
      }
    });
    const chat = await prisma.connectedChat.create({
      data: {
        projectId: project.id,
        telegramChatId: telegramBase + 2n,
        type: "CHANNEL",
        title: "Access delivery lease chat"
      }
    });
    const subscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });
    await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: subscription.id,
        connectedChatId: chat.id,
        inviteLink: "",
        expiresAt: new Date(0)
      }
    });

    await run({ suffix, subscription, customer, chat });
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
  }
}

test("subscription invite delivery releases its database transaction before Telegram and compensates a superseded invite", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withDeliveryFixture(async ({ suffix, subscription, customer, chat }) => {
    const createStarted = deferred<void>();
    const releaseCreate = deferred<void>();
    let revokeCalls = 0;
    let delivery: Promise<{ links: string[]; alreadyJoined: string[]; failed: string[]; blocked: string[] }> | undefined;

    try {
      const fakeBot = { token: "12345:test",
        api: {
          getChatMember: async () => { throw new Error("USER_NOT_PARTICIPANT"); },
          createChatInviteLink: async () => {
            createStarted.resolve(undefined);
            await releaseCreate.promise;
            return { invite_link: "https://t.me/+superseded-invite-" + suffix };
          },
          revokeChatInviteLink: async () => {
            revokeCalls += 1;
            return true;
          }
        }
      } as unknown as Bot;

      await prisma.$transaction((tx) =>
        requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id])
      );
      const preclaimedLease = await claimSubscriptionAccessScope(
        prisma,
        customer.id,
        chat.id
      );
      assert.ok(preclaimedLease, "background worker should claim the dirty customer/chat scope");

      delivery = deliverSubscriptionAccess(
        fakeBot,
        subscription.id,
        [chat.telegramChatId.toString()],
        () => true,
        preclaimedLease
      );

      await Promise.race([
        createStarted.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Telegram invite creation was not reached")), 5_000))
      ]);

      // This entitlement mutation must commit while the Telegram request remains
      // blocked. If delivery held an interactive transaction, this transaction
      // would be waiting on the subscription row lock.
      let mutationCommitted = false;
      const mutation = prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
          subscription.id
        );
        await lockSubscriptionAccessScope(tx, customer.id, chat.id);
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            endsAt: new Date()
          }
        });
        await requestSubscriptionAccessReconciliation(
          tx,
          customer.id,
          [chat.id],
          new Date()
        );
      }).then(() => { mutationCommitted = true; });

      const committedInTime = await Promise.race([
        mutation.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000))
      ]);
      assert.equal(committedInTime, true, "subscription mutation should not wait for Telegram");

      releaseCreate.resolve(undefined);
      const result = await delivery;
      assert.deepEqual(result.links, []);
      assert.deepEqual(result.alreadyJoined, []);
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.blocked, ["Access delivery lease chat"]);
      assert.equal(revokeCalls, 1, "stale invite must be revoked after the entitlement changes");

      const [currentSubscription, currentGrant, scope] = await Promise.all([
        prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
        prisma.subscriptionAccessGrant.findUniqueOrThrow({
          where: {
            subscriptionId_connectedChatId: {
              subscriptionId: subscription.id,
              connectedChatId: chat.id
            }
          }
        }),
        prisma.subscriptionAccessScope.findUniqueOrThrow({
          where: {
            customerId_connectedChatId: {
              customerId: customer.id,
              connectedChatId: chat.id
            }
          }
        })
      ]);
      assert.equal(mutationCommitted, true);
      assert.equal(currentSubscription.status, "CANCELLED");
      assert.equal(currentGrant.inviteLink, "");
      assert.ok(scope.desiredRevision > scope.appliedRevision, "newer revocation revision must remain queued");
    } finally {
      releaseCreate.resolve(undefined);
      if (delivery) await delivery.catch(() => undefined);
    }
  });
});

test("delivery withholds an invite when lifecycle ownership ends during persistence", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withDeliveryFixture(async ({ subscription, chat }) => {
    let inviteCreated = false;
    let lifecycleOwned = true;
    const bot = {
      api: {
        getChatMember: async () => ({ status: "left" }),
        createChatInviteLink: async () => {
          inviteCreated = true;
          return { invite_link: "https://t.me/+lease-loss-test" };
        },
        revokeChatInviteLink: async () => true
      }
    } as unknown as Bot;

    const result = await deliverSubscriptionAccess(bot, subscription.id, [chat.telegramChatId.toString()], () => {
      // The worker owns the lease when Telegram returns. Ownership ends during
      // the following asynchronous database operation, before results are sent.
      if (inviteCreated) queueMicrotask(() => { lifecycleOwned = false; });
      return lifecycleOwned;
    });
    assert.equal(inviteCreated, true);
    assert.deepEqual(result, { links: [], alreadyJoined: [], failed: ["Access delivery lease chat"], blocked: [] });
  });
});

test("delivery withholds an invite for a restricted non-member", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withDeliveryFixture(async ({ subscription, chat }) => {
    let createCalls = 0;
    const bot = {
      api: {
        getChatMember: async () => ({ status: "restricted", is_member: false }),
        createChatInviteLink: async () => {
          createCalls += 1;
          return { invite_link: "https://t.me/+restricted-test" };
        }
      }
    } as unknown as Bot;

    const result = await deliverSubscriptionAccess(bot, subscription.id, [chat.telegramChatId.toString()]);
    assert.deepEqual(result.links, []);
    assert.deepEqual(result.failed, ["Access delivery lease chat"]);
    assert.equal(createCalls, 0);
    const grant = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { subscriptionId_connectedChatId: { subscriptionId: subscription.id, connectedChatId: chat.id } }
    });
    assert.equal(grant.deliveryLastError, "SUBSCRIBER_ADMIN_BANNED");
  });
});

test("invite delivery treats a transport failure as unknown membership, not as permission to invite", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withDeliveryFixture(async ({ subscription, chat }) => {
    let invitations = 0;
    const bot = {
      api: {
        getChatMember: async () => { throw new Error("ETIMEDOUT"); },
        createChatInviteLink: async () => {
          invitations += 1;
          return { invite_link: "https://t.me/+unsafe-invite" };
        }
      }
    } as unknown as Bot;

    const result = await deliverSubscriptionAccess(
      bot, subscription.id, [chat.telegramChatId.toString()]
    );
    assert.equal(invitations, 0);
    assert.deepEqual(result.links, []);
    assert.deepEqual(result.failed, ["Access delivery lease chat"]);
    const grant = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: {
        subscriptionId_connectedChatId: {
          subscriptionId: subscription.id,
          connectedChatId: chat.id
        }
      }
    });
    assert.equal(grant.deliveryLastError, "MEMBERSHIP_LOOKUP_FAILED");
  });
});


test("a lost invite-create response never exposes an unpersisted URL and leaves no false compensation", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withDeliveryFixture(async ({ subscription, chat }) => {
    let telegramAcceptedCreate = false;
    let revokeCalls = 0;
    const bot = {
      token: "12345:test",
      api: {
        getChatMember: async () => ({ status: "left" }),
        createChatInviteLink: async () => {
          // Telegram accepted the operation, but the response carrying the URL
          // was lost. The application cannot compensate an identifier it never saw.
          telegramAcceptedCreate = true;
          throw new Error("ETIMEDOUT after remote acceptance");
        },
        revokeChatInviteLink: async () => {
          revokeCalls += 1;
          return true;
        }
      }
    } as unknown as Bot;

    const result = await deliverSubscriptionAccess(
      bot, subscription.id, [String(chat.telegramChatId)]
    );
    assert.equal(telegramAcceptedCreate, true);
    assert.deepEqual(result.links, []);
    assert.deepEqual(result.alreadyJoined, []);
    assert.deepEqual(result.failed, ["Access delivery lease chat"]);
    assert.equal(revokeCalls, 0, "there is no invite URL available to the compensation path");

    const grant = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: {
        subscriptionId_connectedChatId: {
          subscriptionId: subscription.id,
          connectedChatId: chat.id
        }
      }
    });
    assert.equal(grant.inviteLink, "");
    assert.equal(grant.deliveryLastError, "INVITE_CREATION_FAILED");
    assert.equal(await prisma.inviteCompensation.count({
      where: { projectId: "unreachable-project-id" }
    }), 0);
  });
});

test("a superseded membership lookup failure leaves the newer entitlement retry budget intact", {
  skip: !process.env.DATABASE_URL
}, async () => {
  await withDeliveryFixture(async ({ subscription, customer, chat }) => {
    const bot = { api: {
      getChatMember: async () => {
        await prisma.$transaction(async (tx) => {
          await lockSubscriptionAccessScope(tx, customer.id, chat.id);
          await requestSubscriptionAccessReconciliation(tx, customer.id, [chat.id]);
        });
        throw new Error("transport failure");
      }
    } } as unknown as Bot;
    await deliverSubscriptionAccess(bot, subscription.id, [chat.telegramChatId.toString()]);
    const grant = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { subscriptionId_connectedChatId: { subscriptionId: subscription.id, connectedChatId: chat.id } }
    });
    assert.equal(grant.deliveryAttempts, 0);
    assert.equal(grant.deliveryLastError, null);
    const scope = await prisma.subscriptionAccessScope.findUniqueOrThrow({
      where: { customerId_connectedChatId: { customerId: customer.id, connectedChatId: chat.id } }
    });
    assert.ok(scope.desiredRevision > scope.appliedRevision);
    assert.equal(scope.leaseToken, null);
  });
});

test("a failed compensation can be resumed using only the persisted stale link", { skip: !process.env.DATABASE_URL }, async () => {
  const url = "https://t.me/+" + randomUUID();
  let calls = 0;
  const bot = { token: "12345:test", api: { revokeChatInviteLink: async (_id: string, link: string) => {
    assert.equal(link, url);
    if (++calls === 1) throw new Error("temporary timeout");
    return true;
  } } } as unknown as Bot;
  try {
    await compensateInvite(bot, "fixture", -100n, url, new Date(Date.now() + 3600000));
    const job = await prisma.inviteCompensation.update({ where: { inviteLink: url }, data: { nextAttemptAt: new Date(0) } });
    await retryInviteCompensation(job.inviteLink, job.telegramChatId, bot);
    assert.equal(calls, 2);
    assert.equal(await prisma.inviteCompensation.count({ where: { inviteLink: url } }), 0);
  } finally { await prisma.inviteCompensation.deleteMany({ where: { inviteLink: url } }); }
});
