import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { prisma } from "@subpilot/database";
import { isStarsAccessSuppressedByAdminRevocation } from "./telegram-star-payment-kind.js";
import { processSuccessfulStarsPayment } from "./project-bot-updates.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("PostgreSQL receipt recheck observes a committed admin revoke under the subscription row lock", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(1_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  let actorId: string | undefined;
  let workspaceId: string | undefined;
  const firstLocked = deferred();
  const releaseFirst = deferred();
  let first: Promise<void> | undefined;
  try {
    const actor = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Stars admin receipt race" }
    });
    actorId = actor.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Stars admin race " + suffix,
        slug: "stars-admin-race-" + suffix,
        createdById: actor.id,
        members: { create: { userId: actor.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;
    const project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: "Stars admin race", slug: "stars-admin-race-project-" + suffix }
    });
    const plan = await prisma.creatorPlan.create({
      data: { projectId: project.id, title: "Stars race plan", price: "250", currency: "XTR", durationDays: 30 }
    });
    const customer = await prisma.projectCustomer.create({
      data: { projectId: project.id, telegramUserId: telegramBase + 1n }
    });
    const originalEndsAt = new Date("2026-12-01T00:00:00.000Z");
    const subscription = await prisma.subscription.create({
      data: {
        projectId: project.id, customerId: customer.id, planId: plan.id,
        status: "ACTIVE", startsAt: new Date("2026-11-01T00:00:00.000Z"),
        endsAt: originalEndsAt
      }
    });

    first = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
        subscription.id
      );
      firstLocked.resolve();
      await releaseFirst.promise;
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          adminStarsCancelPending: true,
          adminStarsCancelDueAt: new Date("2026-11-23T00:00:00.000Z"),
          adminStarsCancelBotId: "admin-test-bot"
        }
      });
    });

    await firstLocked.promise;
    let receiptReadCompleted = false;
    const receipt = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
        subscription.id
      );
      receiptReadCompleted = true;
      const current = await tx.subscription.findUniqueOrThrow({
        where: { id: subscription.id }
      });
      assert.equal(isStarsAccessSuppressedByAdminRevocation(current), true);
      // Model the guarded entitlement mutation only: this is not an end-to-end
      // invocation of processSuccessfulStarsPayment or a Telegram API call.
      if (!isStarsAccessSuppressedByAdminRevocation(current)) {
        await tx.subscription.update({
          where: { id: subscription.id },
          data: { endsAt: new Date("2027-01-01T00:00:00.000Z") }
        });
      }
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(receiptReadCompleted, false, "receipt must wait for the admin transaction");
    } finally {
      releaseFirst.resolve();
    }
    await Promise.all([first, receipt]);
    const saved = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id }
    });
    assert.equal(saved.status, "ACTIVE");
    assert.equal(saved.adminStarsCancelPending, true);
    assert.equal(saved.endsAt?.toISOString(), originalEndsAt.toISOString());

    // Exercise the real Stars receipt handler twice after the revoke intent.
    // The first delivery must record the charge without extending access; the
    // duplicate must not create another payment or grant.
    const projectBotId = "stars-admin-race-bot-" + suffix;
    const chargeId = "stars-admin-race-renewal-" + suffix;
    const anchorPayment = await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        providerPaymentId: "stars-admin-race-initial-" + suffix,
        amount: "250",
        currency: "XTR",
        status: "SUCCEEDED",
        paidAt: new Date("2026-11-01T00:00:00.000Z"),
        metadata: { isRecurring: true, durationDays: 30, projectBotId }
      }
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { telegramStarInitialChargeId: anchorPayment.providerPaymentId }
    });
    const replies: string[] = [];
    const ctx = {
      from: { id: Number(customer.telegramUserId) },
      message: {
        successful_payment: {
          invoice_payload: anchorPayment.id,
          telegram_payment_charge_id: chargeId,
          provider_payment_charge_id: "provider-" + suffix,
          currency: "XTR",
          total_amount: 250,
          is_recurring: true
        }
      },
      reply: async (message: string) => { replies.push(message); }
    } as unknown as Parameters<typeof processSuccessfulStarsPayment>[3];
    const bot = {} as Parameters<typeof processSuccessfulStarsPayment>[0];
    await processSuccessfulStarsPayment(bot, project.id, projectBotId, ctx);
    await processSuccessfulStarsPayment(bot, project.id, projectBotId, ctx);
    const renewalRows = await prisma.payment.findMany({
      where: { subscriptionId: subscription.id, providerPaymentId: chargeId }
    });
    assert.equal(renewalRows.length, 1, "duplicate receipt must not create a second charge");
    assert.equal(renewalRows[0]?.status, "SUCCEEDED");
    const eventRows = await prisma.paymentWebhookEvent.count({
      where: { dedupeKey: "telegram-stars:" + chargeId }
    });
    assert.equal(eventRows, 1, "duplicate receipt must not create a second webhook event");
    const finalSubscription = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id }
    });
    assert.equal(finalSubscription.adminStarsCancelPending, true);
    assert.equal(finalSubscription.endsAt?.toISOString(), originalEndsAt.toISOString());
    assert.equal(await prisma.subscriptionAccessGrant.count({
      where: { subscriptionId: subscription.id }
    }), 0);
    assert.equal(replies.length, 2);
    assert.ok(replies.every((reply) => reply.includes("не продлён")));

    // Race the actual receipt handler with a second admin intent transaction.
    // Start with an unrevoked subscription, hold the row lock, then commit
    // the admin intent while the receipt is waiting for that same lock.
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        adminStarsCancelPending: false,
        adminStarsCancelDueAt: null,
        adminStarsCancelBotId: null
      }
    });
    const racingChargeId = "stars-admin-race-inflight-" + suffix;
    const racingCtx = {
      ...ctx,
      message: {
        successful_payment: {
          ...((ctx as unknown as { message: { successful_payment: Record<string, unknown> } }).message.successful_payment),
          telegram_payment_charge_id: racingChargeId
        }
      }
    } as Parameters<typeof processSuccessfulStarsPayment>[3];
    const adminLocked = deferred();
    const releaseAdmin = deferred();
    const admin = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
        subscription.id
      );
      adminLocked.resolve();
      await releaseAdmin.promise;
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          adminStarsCancelPending: true,
          adminStarsCancelDueAt: new Date("2026-11-23T00:00:00.000Z"),
          adminStarsCancelBotId: "admin-test-bot"
        }
      });
    });
    try {
      await adminLocked.promise;
      const racingReceipt = processSuccessfulStarsPayment(bot, project.id, projectBotId, racingCtx);
      let receiptSettled = false;
      void racingReceipt.then(
        () => { receiptSettled = true; },
        () => { receiptSettled = true; }
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(receiptSettled, false, "receipt cannot finish while admin owns subscription row lock");
      } finally {
        releaseAdmin.resolve();
      }
      await Promise.all([admin, racingReceipt]);
    } finally {
      releaseAdmin.resolve();
      await admin.catch(() => undefined);
    }
    const racedSubscription = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id }
    });
    assert.equal(racedSubscription.adminStarsCancelPending, true);
    assert.equal(racedSubscription.endsAt?.toISOString(), originalEndsAt.toISOString());
    assert.equal(await prisma.payment.count({
      where: { subscriptionId: subscription.id, providerPaymentId: racingChargeId }
    }), 1);
    assert.equal(await prisma.paymentWebhookEvent.count({
      where: { dedupeKey: "telegram-stars:" + racingChargeId }
    }), 1);
    assert.equal(await prisma.subscriptionAccessGrant.count({
      where: { subscriptionId: subscription.id }
    }), 0);

    // Telegram can retry the same receipt after both transactions commit.
    // The duplicate must not grant access or duplicate ledger/notification rows.
    await processSuccessfulStarsPayment(bot, project.id, projectBotId, racingCtx);
    assert.equal(await prisma.payment.count({
      where: { subscriptionId: subscription.id, providerPaymentId: racingChargeId }
    }), 1);
    assert.equal(await prisma.paymentWebhookEvent.count({
      where: { dedupeKey: "telegram-stars:" + racingChargeId }
    }), 1);
    assert.equal(await prisma.subscriptionAccessGrant.count({
      where: { subscriptionId: subscription.id }
    }), 0);
    const postReplay = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id }
    });
    assert.equal(postReplay.adminStarsCancelPending, true);
    assert.equal(postReplay.endsAt?.toISOString(), originalEndsAt.toISOString());
    assert.equal(await prisma.ownerNotification.count({
      where: {
        projectId: project.id,
        eventType: "renewal_after_admin_revocation_review"
      }
    }), 2, "each distinct late charge should alert the owner once, even on replay");

  } finally {
    releaseFirst.resolve();
    if (first) await first.catch(() => undefined);
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
  }
});
