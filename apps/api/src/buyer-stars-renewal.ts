import { randomUUID } from "node:crypto";
import { prisma } from "@subpilot/database";

type Edit = (args: { user_id: number; telegram_payment_charge_id: string; is_canceled: boolean }) => Promise<boolean>;

export async function queueBuyerRenewal(id: string, projectId: string, customerId: string, botId: string, canceled: boolean) {
  const now = new Date();
  const key = { id, projectId, customerId, status: "ACTIVE" as const,
    telegramStarSubscriptionState: canceled ? "ACTIVE" as const : "CANCELED" as const,
    OR: [{ endsAt: null }, { endsAt: { gt: now } }] };
  const row = await prisma.subscription.findFirst({ where: key, select: { telegramStarInitialChargeId: true } });
  const charge = row?.telegramStarInitialChargeId;
  if (!charge) return false;
  const payment = await prisma.payment.findFirst({
    where: { projectId, customerId, subscriptionId: id, provider: "TELEGRAM_STARS",
      providerPaymentId: charge, status: { in: ["SUCCEEDED", "REFUNDING", "REFUNDED"] } }, select: { metadata: true }
  });
  const metadata = payment?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      metadata.projectBotId !== botId || metadata.source !== "project_bot" || metadata.isRecurring !== true) return false;
  const saved = await prisma.subscription.updateMany({
    where: { ...key, telegramStarInitialChargeId: charge, buyerStarsDueAt: null },
    data: { buyerStarsBotId: botId, buyerStarsChargeId: charge, buyerStarsCanceled: canceled,
      buyerStarsClaim: null, buyerStarsDueAt: now }
  });
  return saved.count === 1;
}

export async function applyBuyerRenewal(id: string, botId: string, edit: Edit) {
  const now = new Date();
  const due = { id, buyerStarsBotId: botId, buyerStarsDueAt: { lte: now } };
  const row = await prisma.subscription.findFirst({ where: due, select: {
    status: true, endsAt: true, buyerStarsCanceled: true, buyerStarsChargeId: true,
    telegramStarInitialChargeId: true, customer: { select: { telegramUserId: true } }
  } });
  if (!row || row.buyerStarsCanceled === null || !row.buyerStarsChargeId) return false;
  const charge = row.buyerStarsChargeId;
  const active = row.status === "ACTIVE" && (!row.endsAt || row.endsAt > now);
  const canceled = row.buyerStarsCanceled || !active || row.telegramStarInitialChargeId !== charge;
  const claim = randomUUID();
  const intent = { id, buyerStarsBotId: botId, buyerStarsChargeId: charge, buyerStarsCanceled: row.buyerStarsCanceled };
  const saved = await prisma.subscription.updateMany({
    where: { ...due, ...intent, status: row.status, endsAt: row.endsAt, telegramStarInitialChargeId: row.telegramStarInitialChargeId },
    data: { buyerStarsClaim: claim, buyerStarsDueAt: new Date(now.getTime() + 300_000) }
  });
  if (!saved.count) return false;
  const userId = Number(row.customer.telegramUserId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  let confirmed = false;
  try { confirmed = await edit({ user_id: userId, telegram_payment_charge_id: charge, is_canceled: canceled }); }
  catch { /* The remote outcome is unknown. The durable claim becomes retryable. */ }
  const owned = { ...intent, buyerStarsClaim: claim };
  if (confirmed) {
    const committed = await prisma.subscription.updateMany({
      where: { ...owned, status: row.status, telegramStarInitialChargeId: row.telegramStarInitialChargeId,
        ...(!canceled ? { OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] } : {}) },
      data: { buyerStarsDueAt: null, buyerStarsClaim: null,
        ...(row.telegramStarInitialChargeId === charge ? { telegramStarSubscriptionState: canceled ? "CANCELED" : "ACTIVE" } : {}) }
    });
    if (committed.count) return true;
  }
  // A superseded request may have reached Telegram after its successor completed.
  // Never clear a successor's live claim. If the successor already finished,
  // claim is null and we enqueue one more pass to repair a possibly late remote
  // response from this stale request. If it is still in flight, let it finish.
  await prisma.subscription.updateMany({
    where: { id, buyerStarsBotId: botId, buyerStarsChargeId: charge, buyerStarsClaim: null },
    data: { buyerStarsDueAt: new Date() }
  });
  return false;
}
