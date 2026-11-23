import { prisma } from "@subpilot/database";

type Cancel = (input: { user_id: number; telegram_payment_charge_id: string; is_canceled: true }) => Promise<boolean>;

/** This operation is monotonic: only a cancelled subscription and its original charge can be targeted. */
export async function reconcileLateStarsCancellation(id: string, botId: string, chargeId: string, cancel: Cancel): Promise<boolean> {
  const key = { id, status: "CANCELLED" as const, telegramStarInitialChargeId: chargeId };
  const subscription = await prisma.subscription.findFirst({
    where: key, select: { customer: { select: { telegramUserId: true } }, telegramStarSubscriptionState: true, lateStarsCancelDueAt: true }
  });
  if (!subscription) return false;
  if (!subscription.lateStarsCancelDueAt) return subscription.telegramStarSubscriptionState === "CANCELED";
  const userId = Number(subscription.customer.telegramUserId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const now = new Date();
  const next = new Date(now.getTime() + 5 * 60_000);
  const claim = await prisma.subscription.updateMany({
    where: { ...key, lateStarsCancelBotId: botId, lateStarsCancelDueAt: { lte: now } },
    data: { lateStarsCancelDueAt: next }
  });
  if (!claim.count) return false;
  try {
    if (!await cancel({ user_id: userId, telegram_payment_charge_id: chargeId, is_canceled: true })) return false;
  } catch {
    return false;
  }
  const saved = await prisma.subscription.updateMany({
    where: { ...key, lateStarsCancelBotId: botId, lateStarsCancelDueAt: next },
    data: { telegramStarSubscriptionState: "CANCELED", lateStarsCancelDueAt: null }
  });
  return saved.count === 1;
}
