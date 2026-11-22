import { prisma } from "@subpilot/database";
import { recalculateSubscriptionPeriod } from "@subpilot/payments";

type Transaction = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">;

export interface TelegramStarsRefundReconciliationInput {
  paymentId: string;
  providerPaymentId: string;
  subscriptionId: string | null;
  refundedAt: Date;
  telegramUserId: bigint;
  amount: string;
  currency: string;
}

export interface TelegramStarsRefundReconciliationResult {
  paymentUpdated: boolean;
  subscriptionStatus: string | null;
  subscriptionEndsAt: Date | null;
}

/**
 * Persist a validated Telegram Stars refund and rebuild its paid entitlement.
 *
 * The caller must validate the provider receipt before invoking this function.
 * The subscription row is locked here so refund reconciliation serializes with
 * successful payments, expiry transitions, and other subscription mutations.
 */
export async function reconcileTelegramStarsRefundUsing(
  tx: Transaction,
  input: TelegramStarsRefundReconciliationInput
): Promise<TelegramStarsRefundReconciliationResult> {
  if (input.subscriptionId) {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
      input.subscriptionId
    );
  }

  const updated = await tx.payment.updateMany({
    where: {
      id: input.paymentId,
      provider: "TELEGRAM_STARS",
      providerPaymentId: input.providerPaymentId,
      status: { in: ["SUCCEEDED", "REFUNDING"] }
    },
    data: { status: "REFUNDED", refundedAt: input.refundedAt, refundLastError: null }
  });

  const refundEventKey = "telegram-stars-refund:" + input.providerPaymentId;
  await tx.paymentWebhookEvent.upsert({
    where: { dedupeKey: refundEventKey },
    create: {
      connectionId: null,
      dedupeKey: refundEventKey,
      providerEventId: input.providerPaymentId,
      eventType: "telegram.stars.payment.refunded",
      payload: {
        paymentId: input.paymentId,
        telegramUserId: input.telegramUserId.toString(),
        telegramPaymentChargeId: input.providerPaymentId,
        amount: input.amount,
        currency: input.currency,
        source: "telegram_refunded_payment_update"
      },
      processedAt: input.refundedAt
    },
    update: { processedAt: input.refundedAt }
  });

  if (updated.count !== 1 || !input.subscriptionId) {
    return { paymentUpdated: updated.count === 1, subscriptionStatus: null, subscriptionEndsAt: null };
  }

  const subscription = await tx.subscription.findUnique({
    where: { id: input.subscriptionId },
    select: { status: true, startsAt: true, endsAt: true }
  });
  if (!subscription) {
    return { paymentUpdated: true, subscriptionStatus: null, subscriptionEndsAt: null };
  }

  // Refund reconciliation may recompute the paid period, but it must never
  // undo an explicit administrative cancellation of the entitlement.
  if (subscription.status === "CANCELLED") {
    return {
      paymentUpdated: true,
      subscriptionStatus: subscription.status,
      subscriptionEndsAt: subscription.endsAt
    };
  }

  const remainingPayments = await tx.payment.findMany({
    where: {
      subscriptionId: input.subscriptionId,
      status: { in: ["SUCCEEDED", "REFUNDING"] }
    },
    orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
    select: { paidAt: true, metadata: true }
  });

  if (remainingPayments.length === 0) {
    await tx.subscription.update({
      where: { id: input.subscriptionId },
      data: { status: "EXPIRED", endsAt: input.refundedAt, cancelledAt: null }
    });
    return {
      paymentUpdated: true,
      subscriptionStatus: "EXPIRED",
      subscriptionEndsAt: input.refundedAt
    };
  }

  const recalculated = recalculateSubscriptionPeriod(remainingPayments, {
    startsAt: subscription.startsAt,
    endsAt: subscription.endsAt
  });
  if (!recalculated.exact) {
    const shouldExpire = subscription.status === "EXPIRED" ||
      (subscription.endsAt !== null && subscription.endsAt <= input.refundedAt);
    if (shouldExpire && subscription.status !== "EXPIRED") {
      await tx.subscription.update({
        where: { id: input.subscriptionId },
        data: { status: "EXPIRED" }
      });
    }
    return {
      paymentUpdated: true,
      subscriptionStatus: shouldExpire ? "EXPIRED" : subscription.status,
      subscriptionEndsAt: subscription.endsAt
    };
  }

  const isExpired = recalculated.endsAt !== null && recalculated.endsAt <= input.refundedAt;
  await tx.subscription.update({
    where: { id: input.subscriptionId },
    data: {
      status: isExpired ? "EXPIRED" : "ACTIVE",
      startsAt: recalculated.startsAt,
      endsAt: recalculated.endsAt,
      cancelledAt: null
    }
  });

  return {
    paymentUpdated: true,
    subscriptionStatus: isExpired ? "EXPIRED" : "ACTIVE",
    subscriptionEndsAt: recalculated.endsAt
  };
}
