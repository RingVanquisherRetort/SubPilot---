import { prisma } from "@subpilot/database";
import type { Bot } from "grammy";
import {
  claimSubscriptionAccessScope,
  completeSubscriptionAccessScope,
  DEFAULT_SUBSCRIPTION_ACCESS_SCOPE_LEASE_TTL_MS,
  failSubscriptionAccessScope,
  isTelegramInviteAlreadyRevoked,
  lockSubscriptionAccessScope,
  renewSubscriptionAccessScopeLease,
  type SubscriptionAccessScopeLease
} from "@subpilot/payments";
import { recordSubscriptionAccessRevocationFailure } from "./project-bot-updates.js";

type Transaction = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">;
type LeaseOwnershipCheck = () => boolean;

export type SubscriptionAccessRemovalResult =
  | "REVOKED"
  | "PRESERVED_BY_OTHER_SUBSCRIPTION"
  | "SKIPPED"
  | "LEASE_BUSY"
  | "LEASE_LOST";

function isSubscriptionDueForRevocation(
  subscription: { status: string; endsAt: Date | null },
  now: Date
): boolean {
  return subscription.status === "EXPIRED" ||
    subscription.status === "CANCELLED" ||
    (subscription.status === "ACTIVE" && subscription.endsAt !== null && subscription.endsAt <= now);
}

/**
 * Revoke a single customer/chat entitlement without holding an interactive
 * transaction over Telegram calls. The durable scope lease fences the remote
 * operation against payment, manual-grant and delivery revisions.
 */
export async function reconcileSubscriptionAccessRemoval(
  input: {
    bot: Bot;
    subscriptionId: string;
    customerId: string;
    connectedChatId: string;
    telegramUserId: bigint;
    now?: Date;
    isLifecycleLeaseOwned?: LeaseOwnershipCheck;
  }
): Promise<SubscriptionAccessRemovalResult> {
  const isLifecycleLeaseOwned = input.isLifecycleLeaseOwned ?? (() => true);
  const requestedAt = input.now ?? new Date();

  const snapshot = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
      input.subscriptionId
    );
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "SubscriptionAccessGrant" WHERE "subscriptionId" = $1 AND "connectedChatId" = $2 FOR UPDATE',
      input.subscriptionId,
      input.connectedChatId
    );
    const [subscription, grant] = await Promise.all([
      tx.subscription.findUnique({
        where: { id: input.subscriptionId },
        select: { id: true, customerId: true, status: true, endsAt: true }
      }),
      tx.subscriptionAccessGrant.findUnique({
        where: {
          subscriptionId_connectedChatId: {
            subscriptionId: input.subscriptionId,
            connectedChatId: input.connectedChatId
          }
        },
        include: { connectedChat: { select: { telegramChatId: true } } }
      })
    ]);
    if (
      !subscription ||
      !grant ||
      subscription.customerId !== input.customerId ||
      grant.revokedAt !== null ||
      !isSubscriptionDueForRevocation(subscription, requestedAt)
    ) return null;

    await lockSubscriptionAccessScope(tx, input.customerId, input.connectedChatId);

    const otherActiveGrant = await tx.subscriptionAccessGrant.findFirst({
      where: {
        id: { not: grant.id },
        connectedChatId: input.connectedChatId,
        revokedAt: null,
        subscription: {
          id: { not: input.subscriptionId },
          customerId: input.customerId,
          status: "ACTIVE",
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: requestedAt } }] },
            { OR: [{ endsAt: null }, { endsAt: { gt: requestedAt } }] }
          ]
        }
      },
      select: { id: true }
    });

    // Expiry transitions from older deployments may have no dirty scope row yet.
    // Create one only when there is no outstanding revision; do not starve a live
    // owner by incrementing its desired revision on every retry pass.
    const currentScope = await tx.subscriptionAccessScope.findUnique({
      where: {
        customerId_connectedChatId: {
          customerId: input.customerId,
          connectedChatId: input.connectedChatId
        }
      },
      select: { desiredRevision: true, appliedRevision: true }
    });
    if (!currentScope || currentScope.desiredRevision <= currentScope.appliedRevision) {
      await tx.subscriptionAccessScope.upsert({
        where: {
          customerId_connectedChatId: {
            customerId: input.customerId,
            connectedChatId: input.connectedChatId
          }
        },
        create: {
          customerId: input.customerId,
          connectedChatId: input.connectedChatId,
          desiredRevision: 1n,
          nextAttemptAt: requestedAt
        },
        update: {
          desiredRevision: { increment: 1n },
          nextAttemptAt: requestedAt
        }
      });
    }

    return {
      subscriptionStatus: subscription.status,
      grantId: grant.id,
      inviteLink: grant.inviteLink,
      expiresAt: grant.expiresAt,
      joinedAt: grant.joinedAt,
      telegramChatId: grant.connectedChat.telegramChatId.toString(),
      hasOtherActiveGrant: Boolean(otherActiveGrant)
    };
  }, { maxWait: 10_000, timeout: 15_000 });

  if (!snapshot) return "SKIPPED";
  if (!isLifecycleLeaseOwned()) return "LEASE_LOST";

  const lease = await claimSubscriptionAccessScope(
    prisma,
    input.customerId,
    input.connectedChatId,
    { leaseTtlMs: DEFAULT_SUBSCRIPTION_ACCESS_SCOPE_LEASE_TTL_MS }
  );
  if (!lease) return "LEASE_BUSY";

  let ownsScopeLease = true;
  let heartbeatRunning = false;
  const ownsLease = (): boolean => ownsScopeLease && isLifecycleLeaseOwned();
  const heartbeat = setInterval(() => {
    if (!ownsScopeLease || heartbeatRunning) return;
    heartbeatRunning = true;
    void renewSubscriptionAccessScopeLease(prisma, lease, {
      leaseTtlMs: DEFAULT_SUBSCRIPTION_ACCESS_SCOPE_LEASE_TTL_MS
    }).then((renewed) => {
      if (!renewed) ownsScopeLease = false;
    }).catch(() => {
      ownsScopeLease = false;
    }).finally(() => {
      heartbeatRunning = false;
    });
  }, Math.max(1_000, Math.floor(DEFAULT_SUBSCRIPTION_ACCESS_SCOPE_LEASE_TTL_MS / 3)));
  heartbeat.unref?.();

  const retryAt = new Date(Date.now() + Math.min(
    60 * 60 * 1000,
    60_000 * (2 ** Math.min(Math.max(lease.attempts - 1, 0), 6))
  ));
  const fail = async (errorCode: string): Promise<void> => {
    if (!ownsLease()) return;
    await recordSubscriptionAccessRevocationFailure(input.subscriptionId, snapshot.grantId, errorCode);
    await failSubscriptionAccessScope(prisma, lease, {
      retryAt,
      errorCode: "ACCESS_SCOPE_" + errorCode
    });
  };

  try {
    let revocationReason: "ADMIN_REVOKED" | "SUBSCRIPTION_EXPIRED" | "ADMIN_EXCLUDED" =
      snapshot.subscriptionStatus === "CANCELLED" ? "ADMIN_REVOKED" : "SUBSCRIPTION_EXPIRED";

    if (
      snapshot.inviteLink &&
      snapshot.expiresAt > requestedAt &&
      ownsLease()
    ) {
      try {
        await input.bot.api.revokeChatInviteLink(input.connectedChatId ? snapshot.telegramChatId : snapshot.telegramChatId, snapshot.inviteLink);
      } catch (error) {
        if (!isTelegramInviteAlreadyRevoked(error)) {
          await fail("INVITE_REVOKE_FAILED");
          return "SKIPPED";
        }
      }
      if (!ownsLease()) return "LEASE_LOST";
    }

    if (!snapshot.hasOtherActiveGrant && snapshot.joinedAt) {
      if (!ownsLease()) return "LEASE_LOST";
      const member = await input.bot.api.getChatMember(
        snapshot.telegramChatId,
        Number(input.telegramUserId)
      );
      if (
        member.status === "kicked" ||
        (member.status === "restricted" && !member.is_member)
      ) {
        // Preserve an existing moderator ban as an explicit access denial.
        revocationReason = "ADMIN_EXCLUDED";
      } else {
        await input.bot.api.banChatMember(snapshot.telegramChatId, Number(input.telegramUserId));
        if (!ownsLease()) return "LEASE_LOST";
        await input.bot.api.unbanChatMember(
          snapshot.telegramChatId,
          Number(input.telegramUserId),
          { only_if_banned: true }
        );
        if (!ownsLease()) return "LEASE_LOST";
      }
    }

    if (!ownsLease()) return "LEASE_LOST";
    const now = new Date();
    const finalized = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
        input.subscriptionId
      );
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "SubscriptionAccessGrant" WHERE "id" = $1 FOR UPDATE',
        snapshot.grantId
      );
      await lockSubscriptionAccessScope(tx, input.customerId, input.connectedChatId);
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "SubscriptionAccessScope" WHERE "id" = $1 FOR UPDATE',
        lease.id
      );

      const [scope, subscription, grant] = await Promise.all([
        tx.subscriptionAccessScope.findUnique({
          where: { id: lease.id },
          select: { desiredRevision: true, leaseToken: true, leaseExpiresAt: true }
        }),
        tx.subscription.findUnique({
          where: { id: input.subscriptionId },
          select: { status: true, endsAt: true, customerId: true }
        }),
        tx.subscriptionAccessGrant.findUnique({
          where: { id: snapshot.grantId },
          select: { inviteLink: true, revokedAt: true }
        })
      ]);

      if (
        !scope ||
        scope.leaseToken !== lease.leaseToken ||
        scope.leaseExpiresAt === null ||
        scope.leaseExpiresAt <= now
      ) return { state: "STALE" as const, preserved: false };

      if (scope.desiredRevision !== lease.revision) {
        await completeSubscriptionAccessScope(tx, lease, now);
        return { state: "STALE" as const, preserved: false };
      }

      if (
        !subscription ||
        subscription.customerId !== input.customerId ||
        !isSubscriptionDueForRevocation(subscription, now) ||
        !grant ||
        grant.revokedAt !== null ||
        grant.inviteLink !== snapshot.inviteLink
      ) {
        await completeSubscriptionAccessScope(tx, lease, now);
        return { state: "STALE" as const, preserved: false };
      }

      const otherActiveGrant = await tx.subscriptionAccessGrant.findFirst({
        where: {
          id: { not: snapshot.grantId },
          connectedChatId: input.connectedChatId,
          revokedAt: null,
          subscription: {
            id: { not: input.subscriptionId },
            customerId: input.customerId,
            status: "ACTIVE",
            AND: [
              { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
              { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }
            ]
          }
        },
        select: { id: true }
      });

      const completed = await completeSubscriptionAccessScope(tx, lease, now);
      if (!completed) return { state: "STALE" as const, preserved: false };

      const revoked = await tx.subscriptionAccessGrant.updateMany({
        where: {
          id: snapshot.grantId,
          inviteLink: snapshot.inviteLink,
          revokedAt: null
        },
        data: {
          revokedAt: now,
          revocationReason,
          inviteLink: "",
          expiresAt: new Date(0),
          revocationAttempts: 0,
          revocationNextAttemptAt: now,
          revocationLastError: null
        }
      });
      if (revoked.count !== 1) return { state: "STALE" as const, preserved: false };
      return {
        state: "REVOKED" as const,
        preserved: Boolean(otherActiveGrant)
      };
    }, { maxWait: 10_000, timeout: 15_000 });

    if (finalized.state === "STALE") return "LEASE_LOST";
    return finalized.preserved ? "PRESERVED_BY_OTHER_SUBSCRIPTION" : "REVOKED";
  } catch (error) {
    await fail("ACCESS_REVOCATION_FAILED").catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
