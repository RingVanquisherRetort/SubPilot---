import { randomUUID } from "node:crypto";
import { prisma } from "@subpilot/database";
import { lockSubscriptionAccessScopes } from "./subscription-access-scope-lock.js";
import { requestSubscriptionAccessReconciliation } from "./subscription-access-scope-lease.js";

type Cancel = (input: {
  user_id: number;
  telegram_payment_charge_id: string;
  is_canceled: true;
}) => Promise<boolean>;

const INTENT_LEASE_MS = 5 * 60_000;

/**
 * Resume an authorized administrative Stars cancellation.
 *
 * The intent is committed before Telegram I/O. A failed/ambiguous remote result
 * remains due after the lease and can be retried by the lifecycle worker.
 */
export async function reconcileAdminStarsCancellation(
  subscriptionId: string,
  botId: string,
  cancel: Cancel
): Promise<boolean> {
  const now = new Date();
  const nextAttemptAt = new Date(now.getTime() + INTENT_LEASE_MS);
  const claim = randomUUID();

  const snapshot = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
      subscriptionId
    );
    const current = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        status: true,
        telegramStarInitialChargeId: true,
        telegramStarSubscriptionState: true,
        adminStarsCancelPending: true,
        adminStarsCancelDueAt: true,
        adminStarsCancelBotId: true,
        adminStarsCancelAttempts: true,
        adminStarsCancelActorUserId: true,
        adminStarsCancelWorkspaceId: true,
        project: { select: { id: true } },
        customer: { select: { id: true, telegramUserId: true } }
      }
    });
    if (
      !current ||
      !["ACTIVE", "EXPIRED", "CANCELLED"].includes(current.status) ||
      !current.adminStarsCancelPending ||
      current.adminStarsCancelBotId !== botId ||
      !current.telegramStarInitialChargeId ||
      !current.adminStarsCancelDueAt ||
      current.adminStarsCancelDueAt > now
    ) return null;

    const claimed = await tx.subscription.updateMany({
      where: {
        id: subscriptionId,
        status: { in: ["ACTIVE", "EXPIRED", "CANCELLED"] },
        adminStarsCancelPending: true,
        adminStarsCancelBotId: botId,
        telegramStarInitialChargeId: current.telegramStarInitialChargeId,
        adminStarsCancelDueAt: { lte: now }
      },
      data: { adminStarsCancelClaim: claim, adminStarsCancelDueAt: nextAttemptAt }
    });
    if (claimed.count !== 1) return null;

    return {
      chargeId: current.telegramStarInitialChargeId,
      telegramUserId: current.customer.telegramUserId,
      customerId: current.customer.id,
      projectId: current.project.id,
      attempts: current.adminStarsCancelAttempts,
      actorUserId: current.adminStarsCancelActorUserId,
      workspaceId: current.adminStarsCancelWorkspaceId,
      alreadyCanceled: current.telegramStarSubscriptionState === "CANCELED"
    };
  });

  if (!snapshot) return false;

  const userId = Number(snapshot.telegramUserId);
  let confirmed = snapshot.alreadyCanceled;
  if (!confirmed && Number.isSafeInteger(userId) && userId > 0) {
    try {
      confirmed = await cancel({
        user_id: userId,
        telegram_payment_charge_id: snapshot.chargeId,
        is_canceled: true
      });
    } catch {
      // The request may have succeeded remotely. The durable intent remains due
      // after the claim lease and a retry repeats the idempotent desired state.
    }
  }
  if (!confirmed) {
    const attempts = snapshot.attempts + 1;
    const exhausted = attempts >= 10;
    const retryDelay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 6));
    await prisma.$transaction(async (tx) => {
      const failed = await tx.subscription.updateMany({
        where: {
          id: subscriptionId,
          status: { in: ["ACTIVE", "EXPIRED", "CANCELLED"] },
          adminStarsCancelPending: true,
          adminStarsCancelClaim: claim,
          telegramStarInitialChargeId: snapshot.chargeId
        },
        data: {
          adminStarsCancelAttempts: attempts,
          adminStarsCancelLastError: "TELEGRAM_CANCEL_UNCONFIRMED",
          adminStarsCancelClaim: null,
          adminStarsCancelDueAt: exhausted ? null : new Date(Date.now() + retryDelay)
        }
      });
      if (failed.count === 1 && exhausted && snapshot.workspaceId) {
        const actor = snapshot.actorUserId
          ? await tx.user.findUnique({ where: { id: snapshot.actorUserId }, select: { id: true } })
          : null;
        await tx.auditLog.create({
          data: {
            workspaceId: snapshot.workspaceId,
            projectId: snapshot.projectId,
            actorUserId: actor?.id ?? null,
            action: "SUBSCRIPTION_ACCESS_REVOKE_RETRY_EXHAUSTED",
            resourceType: "Subscription",
            resourceId: subscriptionId,
            metadata: {
              recurringRenewalCancelled: false,
              attempts,
              errorCode: "TELEGRAM_CANCEL_UNCONFIRMED"
            }
          }
        });
      }
    });
    return false;
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
      subscriptionId
    );
    const current = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        projectId: true,
        status: true,
        telegramStarInitialChargeId: true,
        buyerStarsChargeId: true,
        adminStarsCancelPending: true,
        adminStarsCancelClaim: true,
        adminStarsCancelActorUserId: true,
        adminStarsCancelWorkspaceId: true,
        customer: { select: { id: true } },
        project: { select: { workspaceId: true } },
        accessGrants: { select: { connectedChatId: true } }
      }
    });
    if (!current) return false;
    if (current.status === "CANCELLED" && !current.adminStarsCancelPending) return true;
    if (
      !["ACTIVE", "EXPIRED", "CANCELLED"].includes(current.status) ||
      !current.adminStarsCancelPending ||
      current.adminStarsCancelClaim !== claim ||
      current.telegramStarInitialChargeId !== snapshot.chargeId
    ) return false;
    if (!current.adminStarsCancelWorkspaceId ||
        current.project.workspaceId !== current.adminStarsCancelWorkspaceId) return false;

    const connectedChatIds = current.accessGrants.map((grant) => grant.connectedChatId);
    await lockSubscriptionAccessScopes(tx, current.customer.id, connectedChatIds);
    const finalizedAt = new Date();
    const updated = await tx.subscription.updateMany({
      where: {
        id: subscriptionId,
        status: current.status,
        adminStarsCancelPending: true,
        adminStarsCancelClaim: claim,
        telegramStarInitialChargeId: snapshot.chargeId
      },
      data: {
        ...(current.status === "ACTIVE"
          ? { status: "CANCELLED", endsAt: finalizedAt, cancelledAt: finalizedAt }
          : {}),
        telegramStarSubscriptionState: "CANCELED",
        adminAccessRevokedAt: finalizedAt,
        adminStarsCancelPending: false,
        adminStarsCancelDueAt: null,
        adminStarsCancelBotId: null,
        adminStarsCancelClaim: null,
        adminStarsCancelActorUserId: null,
        adminStarsCancelWorkspaceId: null,
        adminStarsCancelAttempts: 0,
        adminStarsCancelLastError: null,
        ...(current.buyerStarsChargeId === snapshot.chargeId
          ? { buyerStarsCanceled: true, buyerStarsDueAt: finalizedAt, buyerStarsClaim: null }
          : {})
      }
    });
    if (updated.count !== 1) return false;

    await requestSubscriptionAccessReconciliation(
      tx,
      current.customer.id,
      connectedChatIds,
      finalizedAt
    );
    const actor = current.adminStarsCancelActorUserId
      ? await tx.user.findUnique({
          where: { id: current.adminStarsCancelActorUserId },
          select: { id: true }
        })
      : null;
    await tx.auditLog.create({
      data: {
        workspaceId: current.adminStarsCancelWorkspaceId,
        projectId: current.projectId,
        actorUserId: actor?.id ?? null,
        action: "SUBSCRIPTION_ACCESS_REVOKE_CONFIRMED",
        resourceType: "Subscription",
        resourceId: subscriptionId,
        metadata: {
          recurringRenewalCancelled: true,
          telegramPaymentChargeId: snapshot.chargeId,
          confirmedAt: finalizedAt.toISOString()
        }
      }
    });
    return true;
  }, { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 15_000 });
}
