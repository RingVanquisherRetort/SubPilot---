import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { prisma } from "@subpilot/database";
import { reconcileTelegramStarsRefundUsing } from "./telegram-stars-refund-reconciliation.js";
import { withSubscriptionExpiryRowLock } from "./subscription-expiry-transition.js";

test("PostgreSQL Telegram Stars refunds recalculate paid access and expose fully-refunded subscriptions to expiry", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let actorId: string | undefined;
  let workspaceId: string | undefined;

  try {
    const actor = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Stars refund reconciliation test" }
    });
    actorId = actor.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Stars refund " + suffix,
        slug: "stars-refund-" + suffix,
        createdById: actor.id,
        members: { create: { userId: actor.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;

    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Stars refund project",
        slug: "stars-refund-project-" + suffix
      }
    });
    const plan = await prisma.creatorPlan.create({
      data: {
        projectId: project.id,
        title: "Stars refund plan",
        price: "250",
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
        title: "Stars refund chat"
      }
    });

    const firstPaidAt = new Date("2026-10-01T00:00:00.000Z");
    const retainedPaidAt = new Date("2026-11-01T00:00:00.000Z");
    const firstRefundAt = new Date("2026-11-15T12:00:00.000Z");
    const finalRefundAt = new Date("2026-11-16T12:00:00.000Z");
    const subscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: firstPaidAt,
        endsAt: new Date("2026-12-01T00:00:00.000Z")
      }
    });
    const grant = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: subscription.id,
        connectedChatId: chat.id,
        inviteLink: "",
        expiresAt: new Date(0),
        joinedAt: retainedPaidAt
      }
    });

    const firstPayment = await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        providerPaymentId: "stars-refund-first-" + suffix,
        amount: "250",
        currency: "XTR",
        status: "SUCCEEDED",
        paidAt: firstPaidAt,
        metadata: { durationDays: 30, isRecurring: false }
      }
    });
    const retainedPayment = await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        providerPaymentId: "stars-refund-retained-" + suffix,
        amount: "250",
        currency: "XTR",
        status: "SUCCEEDED",
        paidAt: retainedPaidAt,
        metadata: { durationDays: 30, isRecurring: false }
      }
    });

    const firstRefundResult = await prisma.$transaction((tx) =>
      reconcileTelegramStarsRefundUsing(tx, {
        paymentId: firstPayment.id,
        providerPaymentId: firstPayment.providerPaymentId!,
        subscriptionId: subscription.id,
        refundedAt: firstRefundAt,
        telegramUserId: customer.telegramUserId,
        amount: firstPayment.amount.toString(),
        currency: firstPayment.currency
      })
    );
    assert.equal(firstRefundResult.paymentUpdated, true);
    assert.equal(firstRefundResult.subscriptionStatus, "ACTIVE");
    assert.equal(firstRefundResult.subscriptionEndsAt?.toISOString(), "2026-12-01T00:00:00.000Z");

    const [refundedFirstPayment, activeSubscription, activeGrant, firstRefundEvent] = await Promise.all([
      prisma.payment.findUniqueOrThrow({ where: { id: firstPayment.id } }),
      prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
      prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      prisma.paymentWebhookEvent.findUniqueOrThrow({
        where: { dedupeKey: "telegram-stars-refund:" + firstPayment.providerPaymentId }
      })
    ]);
    assert.equal(refundedFirstPayment.status, "REFUNDED");
    assert.equal(activeSubscription.status, "ACTIVE");
    assert.equal(activeSubscription.startsAt?.toISOString(), retainedPaidAt.toISOString());
    assert.equal(activeSubscription.endsAt?.toISOString(), "2026-12-01T00:00:00.000Z");
    assert.equal(activeGrant.revokedAt, null);
    assert.equal(firstRefundEvent.eventType, "telegram.stars.payment.refunded");

    // Refunding the final paid period expires the entitlement. The still-open
    // access grant becomes due for the lifecycle worker, rather than being
    // silently left attached to an ACTIVE subscription.
    const finalRefundResult = await prisma.$transaction((tx) =>
      reconcileTelegramStarsRefundUsing(tx, {
        paymentId: retainedPayment.id,
        providerPaymentId: retainedPayment.providerPaymentId!,
        subscriptionId: subscription.id,
        refundedAt: finalRefundAt,
        telegramUserId: customer.telegramUserId,
        amount: retainedPayment.amount.toString(),
        currency: retainedPayment.currency
      })
    );
    assert.equal(finalRefundResult.paymentUpdated, true);
    assert.equal(finalRefundResult.subscriptionStatus, "EXPIRED");
    assert.equal(finalRefundResult.subscriptionEndsAt?.toISOString(), finalRefundAt.toISOString());

    const dueSubscriptions = await prisma.subscription.findMany({
      where: {
        status: { in: ["EXPIRED", "CANCELLED"] },
        accessGrants: {
          some: { revokedAt: null, revocationNextAttemptAt: { lte: finalRefundAt } }
        }
      },
      select: { id: true }
    });
    assert.ok(dueSubscriptions.some((item) => item.id === subscription.id));

    const expiryTransition = await prisma.$transaction((tx) =>
      withSubscriptionExpiryRowLock(tx, subscription.id, finalRefundAt, async (currentStatus) => {
        const changed = await tx.subscriptionAccessGrant.updateMany({
          where: { id: grant.id, revokedAt: null },
          data: {
            revokedAt: finalRefundAt,
            revocationReason: currentStatus === "CANCELLED" ? "ADMIN_REVOKED" : "SUBSCRIPTION_EXPIRED"
          }
        });
        return changed.count;
      })
    );
    assert.equal(expiryTransition.shouldRevoke, true);
    assert.equal(expiryTransition.result, 1);

    // A duplicate refund event is idempotent and cannot recalculate the period again.
    const duplicateResult = await prisma.$transaction((tx) =>
      reconcileTelegramStarsRefundUsing(tx, {
        paymentId: retainedPayment.id,
        providerPaymentId: retainedPayment.providerPaymentId!,
        subscriptionId: subscription.id,
        refundedAt: new Date(finalRefundAt.getTime() + 60_000),
        telegramUserId: customer.telegramUserId,
        amount: retainedPayment.amount.toString(),
        currency: retainedPayment.currency
      })
    );
    assert.equal(duplicateResult.paymentUpdated, false);
    const finalSubscription = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id }
    });
    assert.equal(finalSubscription.status, "EXPIRED");
    assert.equal(finalSubscription.endsAt?.toISOString(), finalRefundAt.toISOString());
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
  }
});
