import { prisma } from "@subpilot/database";
import type { Bot } from "grammy";
import {
  claimSubscriptionAccessScope,
  completeSubscriptionAccessScope,
  DEFAULT_SUBSCRIPTION_ACCESS_SCOPE_LEASE_TTL_MS,
  isTelegramInviteAlreadyRevoked,
  lockSubscriptionAccessScope,
  renewSubscriptionAccessScopeLease,
  requestSubscriptionAccessReconciliation,
  type SubscriptionAccessScopeLease
} from "@subpilot/payments";
import { recordSubscriptionAccessRevocationFailure } from "./project-bot-updates.js";

type LeaseOwnershipCheck = () => boolean;

export type SubscriptionAccessRemovalResult =
  | "REVOKED"
  | "INVITE_CLEANED"
  | "PRESERVED_BY_OTHER_SUBSCRIPTION"
  | "SKIPPED"
  | "FAILED"
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

function isAdminExcludedInviteDue(
  grant: {
    revokedAt: Date | null;
    revocationReason: string | null;
    inviteLink: string;
    revocationNextAttemptAt: Date;
  },
  now: Date
): boolean {
  return grant.revokedAt !== null &&
    grant.revocationReason === "ADMIN_EXCLUDED" &&
    Boolean(grant.inviteLink) &&
    grant.revocationNextAttemptAt <= now;
}

/**
 * Revoke a single customer/chat entitlement without holding an interactive
 * transaction over Telegram calls. The durable scope lease fences the remote
 * result in PostgreSQL. Telegram itself cannot enforce this lease.
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
    allowAutomaticMemberBan?: boolean;
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
        include: { connectedChat: { select: { telegramChatId: true, type: true } } }
      })
    ]);
    if (!subscription || !grant || subscription.customerId !== input.customerId) return null;
    const cleanupExcludedInvite = isAdminExcludedInviteDue(grant, requestedAt);
    if (!cleanupExcludedInvite && (
      grant.revokedAt !== null ||
      grant.revocationNextAttemptAt > requestedAt ||
      !isSubscriptionDueForRevocation(subscription, requestedAt)
    )) return null;

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
      cleanupExcludedInvite,
      subscriptionStatus: subscription.status,
      grantId: grant.id,
      inviteLink: grant.inviteLink,
      expiresAt: grant.expiresAt,
      joinedAt: grant.joinedAt,
      revocationLastError: grant.revocationLastError,
      chatType: grant.connectedChat.type,
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

  // The first snapshot was taken before the scope was claimed. Payments and
  // overlapping subscriptions may have changed in between. Re-read every
  // authorization input under the claimed revision before touching Telegram.
  const currentSnapshot = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
      input.subscriptionId
    );
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "SubscriptionAccessGrant" WHERE "id" = $1 FOR UPDATE',
      snapshot.grantId
    );
    await lockSubscriptionAccessScope(tx, input.customerId, input.connectedChatId);
    const [subscription, grant, scope] = await Promise.all([
      tx.subscription.findUnique({
        where: { id: input.subscriptionId },
        select: { customerId: true, status: true, endsAt: true }
      }),
      tx.subscriptionAccessGrant.findUnique({
        where: { id: snapshot.grantId },
        select: {
          connectedChatId: true,
          revokedAt: true,
          revocationReason: true,
          revocationNextAttemptAt: true,
          inviteLink: true,
          expiresAt: true,
          joinedAt: true,
          revocationLastError: true
        }
      }),
      tx.subscriptionAccessScope.findUnique({
        where: { id: lease.id },
        select: { desiredRevision: true, leaseToken: true, leaseExpiresAt: true }
      })
    ]);
    const checkedAt = new Date();
    if (!subscription || !grant || subscription.customerId !== input.customerId ||
      grant.connectedChatId !== input.connectedChatId || !scope ||
      scope.leaseToken !== lease.leaseToken ||
      scope.leaseExpiresAt === null || scope.leaseExpiresAt <= checkedAt ||
      scope.desiredRevision !== lease.revision
    ) return null;
    const cleanupExcludedInvite = isAdminExcludedInviteDue(grant, checkedAt);
    const naturalRevocationDue = grant.revokedAt === null &&
      grant.revocationNextAttemptAt <= checkedAt &&
      isSubscriptionDueForRevocation(subscription, checkedAt);
    if ((cleanupExcludedInvite !== snapshot.cleanupExcludedInvite) ||
      (!cleanupExcludedInvite && !naturalRevocationDue)) return null;
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
            { OR: [{ startsAt: null }, { startsAt: { lte: checkedAt } }] },
            { OR: [{ endsAt: null }, { endsAt: { gt: checkedAt } }] }
          ]
        }
      },
      select: { id: true }
    });
    return {
      ...snapshot,
      cleanupExcludedInvite,
      subscriptionStatus: subscription.status,
      inviteLink: grant.inviteLink,
      expiresAt: grant.expiresAt,
      joinedAt: grant.joinedAt,
      revocationLastError: grant.revocationLastError,
      hasOtherActiveGrant: Boolean(otherActiveGrant)
    };
  }, { maxWait: 10_000, timeout: 15_000 });
  if (!currentSnapshot) {
    // Completing the old generation leaves a newer revision immediately due.
    await completeSubscriptionAccessScope(prisma, lease).catch(() => false);
    return "SKIPPED";
  }

  let ownsScopeLease = true;
  let heartbeatRunning = false;
  const ownsLease = (): boolean => ownsScopeLease && isLifecycleLeaseOwned();
  const isCurrentRevision = async (): Promise<boolean> => {
    if (!ownsLease()) return false;
    const current = await prisma.subscriptionAccessScope.findUnique({
      where: { id: lease.id },
      select: { desiredRevision: true, leaseToken: true, leaseExpiresAt: true }
    });
    return ownsLease() &&
      current?.leaseToken === lease.leaseToken &&
      current.desiredRevision === lease.revision &&
      current.leaseExpiresAt !== null &&
      current.leaseExpiresAt > new Date();
  };
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
    await recordSubscriptionAccessRevocationFailure(input.subscriptionId, currentSnapshot.grantId, errorCode, new Date(), {
      lease, retryAt: errorCode === "MEMBER_MODERATION_REVIEW_REQUIRED" ||
        errorCode === "MEMBER_BAN_OWNERSHIP_UNCERTAIN" || errorCode === "LEGACY_GROUP_REMOVAL_REVIEW"
        ? new Date("2100-01-01T00:00:00.000Z") : retryAt
    });
  };

  try {
    let revocationReason: "ADMIN_REVOKED" | "SUBSCRIPTION_EXPIRED" | "ADMIN_EXCLUDED" =
      currentSnapshot.subscriptionStatus === "CANCELLED" ? "ADMIN_REVOKED" : "SUBSCRIPTION_EXPIRED";

    if (
      currentSnapshot.inviteLink &&
      (currentSnapshot.cleanupExcludedInvite || currentSnapshot.expiresAt > requestedAt) &&
      await isCurrentRevision()
    ) {
      try {
        await input.bot.api.revokeChatInviteLink(currentSnapshot.telegramChatId, currentSnapshot.inviteLink);
      } catch (error) {
        if (!isTelegramInviteAlreadyRevoked(error)) {
          await fail("INVITE_REVOKE_FAILED");
          return "FAILED";
        }
      }
      if (!ownsLease()) return "LEASE_LOST";
    }

    if (!currentSnapshot.cleanupExcludedInvite &&
      !currentSnapshot.hasOtherActiveGrant && currentSnapshot.joinedAt) {
      const telegramUserId = Number(input.telegramUserId);
      if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) {
        await fail("INVALID_TELEGRAM_USER_ID");
        return "FAILED";
      }
      if (!await isCurrentRevision()) return "LEASE_LOST";
      const member = await input.bot.api.getChatMember(
        currentSnapshot.telegramChatId,
        telegramUserId
      );
      // A ban observed after MEMBER_UNBAN_FAILED is ambiguous: a moderator
      // could have applied a new ban. Never automatically unban that state.
      if (!await isCurrentRevision()) return "LEASE_LOST";
      if (currentSnapshot.revocationLastError === "MEMBER_BAN_IN_PROGRESS" && member.status !== "left") {
        await fail("MEMBER_BAN_OWNERSHIP_UNCERTAIN");
        return "FAILED";
      }
      if (member.status === "kicked" &&
        (currentSnapshot.revocationLastError === "MEMBER_UNBAN_FAILED" ||
          currentSnapshot.revocationLastError === "MEMBER_BAN_OWNERSHIP_UNCERTAIN")) {
        // The user may still be banned by our previous failed cleanup, or by
        // a moderator who banned them afterwards. Never guess and unban.
        await fail("MEMBER_BAN_OWNERSHIP_UNCERTAIN");
        return "FAILED";
      }
      if (
        member.status === "kicked" ||
        (member.status === "restricted" && !member.is_member)
      ) {
        revocationReason = "ADMIN_EXCLUDED";
      } else if (member.status === "restricted" || member.status === "administrator" || member.status === "creator") {
        await fail("MEMBER_MODERATION_REVIEW_REQUIRED");
        return "FAILED";
      } else if (member.status === "member") {
        // Immediate revocation must remove a joined subscriber. A permanent
        // ban removes channel membership without a follow-up unban that could
        // undo a moderator's decision. Telegram has no conditional ban API:
        // a concurrent moderation action remains a documented race.
        if (currentSnapshot.chatType === "GROUP") {
          await fail("LEGACY_GROUP_REMOVAL_REVIEW");
          return "FAILED";
        }
        if (!input.allowAutomaticMemberBan) {
          await fail("MEMBER_MODERATION_REVIEW_REQUIRED");
          return "FAILED";
        }
        if (!await isCurrentRevision()) return "LEASE_LOST";
        // A successor must be able to distinguish an interrupted removal from
        // a previously observed moderator ban, even when Telegram lost the reply.
        const marked = await prisma.$transaction(async (tx) => {
          await tx.$queryRawUnsafe('SELECT "id" FROM "SubscriptionAccessGrant" WHERE "id" = $1 FOR UPDATE', currentSnapshot.grantId);
          const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            'SELECT "id" FROM "SubscriptionAccessScope" WHERE "id" = $1 AND "leaseToken" = $2 ' +
            'AND "desiredRevision" = $3 AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE',
            lease.id, lease.leaseToken, lease.revision
          );
          if (!rows.length) return false;
          const updated = await tx.subscriptionAccessGrant.updateMany({
            where: { id: currentSnapshot.grantId, revokedAt: null },
            data: { revocationLastError: "MEMBER_BAN_IN_PROGRESS" }
          });
          return updated.count === 1;
        });
        if (!marked || !await isCurrentRevision()) return "LEASE_LOST";
        try {
          await input.bot.api.banChatMember(currentSnapshot.telegramChatId, telegramUserId);
        } catch {
          // Telegram may have applied the ban even when the response was lost.
          // Never unban or blindly retry an ambiguous mutation.
          await fail("MEMBER_BAN_OWNERSHIP_UNCERTAIN");
          return "FAILED";
        }
        if (!await isCurrentRevision()) return "LEASE_LOST";
        try {
          const afterBan = await input.bot.api.getChatMember(
            currentSnapshot.telegramChatId, telegramUserId
          );
          if (afterBan.status !== "kicked") {
            await fail("MEMBER_MODERATION_REVIEW_REQUIRED");
            return "FAILED";
          }
        } catch {
          await fail("MEMBER_BAN_OWNERSHIP_UNCERTAIN");
          return "FAILED";
        }
      }
    }

    if (!ownsLease()) return "LEASE_LOST";
    const finalized = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
        input.subscriptionId
      );
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "SubscriptionAccessGrant" WHERE "id" = $1 FOR UPDATE',
        currentSnapshot.grantId
      );
      await lockSubscriptionAccessScope(tx, input.customerId, input.connectedChatId);
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "SubscriptionAccessScope" WHERE "id" = $1 FOR UPDATE',
        lease.id
      );

      const now = new Date();
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
          where: { id: currentSnapshot.grantId },
          select: { inviteLink: true, revokedAt: true, revocationReason: true }
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

      const stillExcluded = Boolean(grant &&
        grant.revokedAt !== null &&
        grant.revocationReason === "ADMIN_EXCLUDED" &&
        grant.inviteLink === currentSnapshot.inviteLink);
      const stillNatural = Boolean(subscription && grant &&
        subscription.customerId === input.customerId &&
        grant.revokedAt === null &&
        grant.inviteLink === currentSnapshot.inviteLink &&
        isSubscriptionDueForRevocation(subscription, now));
      if (!subscription || subscription.customerId !== input.customerId ||
        (currentSnapshot.cleanupExcludedInvite ? !stillExcluded : !stillNatural)) {
        await completeSubscriptionAccessScope(tx, lease, now);
        return { state: "STALE" as const, preserved: false };
      }

      if (currentSnapshot.cleanupExcludedInvite) {
        const cleaned = await tx.subscriptionAccessGrant.updateMany({
          where: {
            id: currentSnapshot.grantId,
            revokedAt: { not: null },
            revocationReason: "ADMIN_EXCLUDED",
            inviteLink: currentSnapshot.inviteLink
          },
          data: {
            inviteLink: "",
            expiresAt: new Date(0),
            revocationAttempts: 0,
            revocationNextAttemptAt: now,
            revocationLastError: null
          }
        });
        if (cleaned.count !== 1) return { state: "STALE" as const, preserved: false };
        const otherCurrentEntitlement = await tx.subscriptionAccessGrant.findFirst({
          where: {
            id: { not: currentSnapshot.grantId },
            connectedChatId: input.connectedChatId,
            revokedAt: null,
            subscription: {
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
        if (otherCurrentEntitlement) {
          await requestSubscriptionAccessReconciliation(
            tx, input.customerId, [input.connectedChatId], now
          );
        }
        const completed = await completeSubscriptionAccessScope(tx, lease, now);
        if (!completed) throw new Error("ACCESS_SCOPE_LEASE_LOST_DURING_FINALIZATION");
        return { state: "CLEANED" as const, preserved: false };
      }

      const otherActiveGrant = await tx.subscriptionAccessGrant.findFirst({
        where: {
          id: { not: currentSnapshot.grantId },
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

      const revoked = await tx.subscriptionAccessGrant.updateMany({
        where: {
          id: currentSnapshot.grantId,
          inviteLink: currentSnapshot.inviteLink,
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
      if (otherActiveGrant) {
        await requestSubscriptionAccessReconciliation(
          tx, input.customerId, [input.connectedChatId], now
        );
      }

      const completed = await completeSubscriptionAccessScope(tx, lease, now);
      if (!completed) throw new Error("ACCESS_SCOPE_LEASE_LOST_DURING_FINALIZATION");
      return {
        state: "REVOKED" as const,
        preserved: Boolean(otherActiveGrant)
      };
    }, { maxWait: 10_000, timeout: 15_000 });

    if (finalized.state === "STALE") return "LEASE_LOST";
    if (finalized.state === "CLEANED") return "INVITE_CLEANED";
    return finalized.preserved ? "PRESERVED_BY_OTHER_SUBSCRIPTION" : "REVOKED";
  } catch (error) {
    await fail("ACCESS_REVOCATION_FAILED").catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
