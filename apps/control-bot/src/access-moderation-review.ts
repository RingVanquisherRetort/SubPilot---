import type { Bot } from "grammy";
import { prisma } from "@subpilot/database";
import { lockSubscriptionAccessScope, requestSubscriptionAccessReconciliation } from "@subpilot/payments";
import { getAccessibleProject } from "./project-access-service.js";
import { ADMIN_ROLES } from "./workspace-permissions.js";

/**
 * Read-only, tenant-scoped moderation work queue. Reading a case never
 * mutates Telegram membership or acknowledges a removal.
 */
export async function listPendingAccessModerationReviews(
  projectId: string,
  actorUserId: string,
  limit = 50,
  offset = 0
) {
  if (!await getAccessibleProject(projectId, actorUserId, ADMIN_ROLES)) return null;

  const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 50;
  const grants = await prisma.subscriptionAccessGrant.findMany({
    where: {
      revokedAt: null,
      revocationLastError: {
        in: [
          "MEMBER_MODERATION_REVIEW_REQUIRED",
          "MEMBER_BAN_OWNERSHIP_UNCERTAIN",
          "LEGACY_GROUP_REMOVAL_REVIEW"
        ]
      },
      subscription: {
        projectId,
        OR: [
          { status: "EXPIRED" },
          { status: "CANCELLED" },
          { status: "ACTIVE", endsAt: { lte: new Date() } }
        ]
      }
    },
    select: {
      id: true,
      subscriptionId: true,
      revocationLastError: true,
      revocationAttempts: true,
      updatedAt: true,
      connectedChat: { select: { id: true, telegramChatId: true, title: true } },
      subscription: {
        select: {
          status: true,
          endsAt: true,
          customer: { select: { telegramUserId: true } }
        }
      }
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    skip: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    take: safeLimit
  });

  return grants.map((grant) => ({
    grantId: grant.id,
    subscriptionId: grant.subscriptionId,
    reason: grant.revocationLastError,
    attempts: grant.revocationAttempts,
    pendingSince: grant.updatedAt,
    chatId: grant.connectedChat.id,
    telegramChatId: grant.connectedChat.telegramChatId.toString(),
    chatTitle: grant.connectedChat.title,
    telegramUserId: grant.subscription.customer.telegramUserId.toString(),
    subscriptionStatus: grant.subscription.status,
    subscriptionEndsAt: grant.subscription.endsAt
  }));
}

/**
 * Live, read-only preflight for an operator. This is NOT a resolution:
 * the membership observation can become stale immediately after Telegram
 * responds, so it must never be used alone to mark access revoked.
 */
export async function inspectPendingAccessModerationReview(
  projectId: string,
  actorUserId: string,
  grantId: string,
  bot: Pick<Bot, "api">
): Promise<
  | { state: "UNAUTHORIZED" | "NO_LONGER_PENDING" | "ENTITLEMENT_ACTIVE" }
  | { state: "TELEGRAM_CHECK_FAILED" }
  | { state: "REVIEW_REQUIRED"; membership: string; telegramChatId: string; telegramUserId: string; grantUpdatedAt: Date; revision: bigint | null }
> {
  if (!await getAccessibleProject(projectId, actorUserId, ADMIN_ROLES)) return { state: "UNAUTHORIZED" };
  const row = await prisma.subscriptionAccessGrant.findFirst({
    where: {
      id: grantId, revokedAt: null, subscription: { projectId },
      revocationLastError: { in: ["MEMBER_MODERATION_REVIEW_REQUIRED", "MEMBER_BAN_OWNERSHIP_UNCERTAIN", "LEGACY_GROUP_REMOVAL_REVIEW"] }
    },
    select: {
      updatedAt: true, connectedChatId: true,
      connectedChat: { select: { telegramChatId: true } },
      subscription: { select: {
        status: true, endsAt: true, customerId: true, customer: { select: { telegramUserId: true } }
      } }
    }
  });
  if (!row) return { state: "NO_LONGER_PENDING" };
  const sub = row.subscription;
  if (sub.status === "ACTIVE" && (!sub.endsAt || sub.endsAt > new Date())) return { state: "ENTITLEMENT_ACTIVE" };
  if (!["CANCELLED", "EXPIRED", "ACTIVE"].includes(sub.status)) return { state: "NO_LONGER_PENDING" };
  const scope = await prisma.subscriptionAccessScope.findUnique({
    where: { customerId_connectedChatId: { customerId: sub.customerId, connectedChatId: row.connectedChatId } },
    select: { desiredRevision: true }
  });
  const telegramChatId = row.connectedChat.telegramChatId.toString();
  const telegramUserId = sub.customer.telegramUserId.toString();
  const userId = Number(telegramUserId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return { state: "TELEGRAM_CHECK_FAILED" };
  try {
    const member = await bot.api.getChatMember(telegramChatId, userId);
    return {
      state: "REVIEW_REQUIRED",
      membership: member.status,
      telegramChatId, telegramUserId,
      grantUpdatedAt: row.updatedAt, revision: scope?.desiredRevision ?? null
    };
  } catch {
    return { state: "TELEGRAM_CHECK_FAILED" };
  }
}


/**
 * Confirm only a Telegram-observed absence. This never removes, bans or
 * unbans a member. A still-valid invite requires separate cleanup and
 * cannot be treated as a completed access revocation.
 */
export async function confirmPendingAccessModerationReview(
  projectId: string,
  actorUserId: string,
  grantId: string,
  bot: Pick<Bot, "api">
): Promise<"CONFIRMED" | "UNAUTHORIZED" | "NO_LONGER_PENDING" |
  "ENTITLEMENT_ACTIVE" | "MEMBER_STILL_PRESENT" | "INVITE_CLEANUP_REQUIRED" |
  "TELEGRAM_CHECK_FAILED" | "RECONCILIATION_IN_PROGRESS" | "CASE_CHANGED"> {
  const preflight = await inspectPendingAccessModerationReview(
    projectId, actorUserId, grantId, bot
  );
  if (preflight.state !== "REVIEW_REQUIRED") return preflight.state;

  return prisma.$transaction(async (tx) => {
    const anchor = await tx.subscriptionAccessGrant.findUnique({
      where: { id: grantId },
      select: { subscriptionId: true }
    });
    if (!anchor) return "NO_LONGER_PENDING" as const;
    // Match the subscription -> grant lock order used by the removal worker.
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
      anchor.subscriptionId
    );
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "SubscriptionAccessGrant" WHERE "id" = $1 FOR UPDATE', grantId
    );
    const grant = await tx.subscriptionAccessGrant.findUnique({
      where: { id: grantId },
      include: {
        connectedChat: { select: { telegramChatId: true } },
        subscription: { select: {
          id: true, projectId: true, customerId: true, status: true,
          endsAt: true, customer: { select: { telegramUserId: true } }
        } }
      }
    });
    if (!grant || grant.subscription.projectId !== projectId ||
      grant.revokedAt !== null ||
      !["MEMBER_MODERATION_REVIEW_REQUIRED", "MEMBER_BAN_OWNERSHIP_UNCERTAIN", "LEGACY_GROUP_REMOVAL_REVIEW"].includes(grant.revocationLastError ?? "")) {
      return "NO_LONGER_PENDING" as const;
    }
    await lockSubscriptionAccessScope(tx, grant.subscription.customerId, grant.connectedChatId);
    const project = await getAccessibleProject(projectId, actorUserId, ADMIN_ROLES, tx);
    if (!project) return "UNAUTHORIZED" as const;
    const now = new Date();
    const scope = await tx.subscriptionAccessScope.findUnique({
      where: {
        customerId_connectedChatId: {
          customerId: grant.subscription.customerId,
          connectedChatId: grant.connectedChatId
        }
      },
      select: { leaseToken: true, leaseExpiresAt: true, desiredRevision: true }
    });
    // A worker with an in-flight Telegram operation must not be bypassed by
    // a manual acknowledgement. Let it finish or expire, then re-inspect.
    if (scope?.leaseToken && scope.leaseExpiresAt && scope.leaseExpiresAt > now) {
      return "RECONCILIATION_IN_PROGRESS" as const;
    }
    if ((scope?.desiredRevision ?? null) !== preflight.revision ||
        grant.updatedAt.getTime() !== preflight.grantUpdatedAt.getTime()) return "CASE_CHANGED" as const;
    if (grant.connectedChat.telegramChatId.toString() !== preflight.telegramChatId ||
      grant.subscription.customer.telegramUserId.toString() !== preflight.telegramUserId) {
      return "NO_LONGER_PENDING" as const;
    }
    const subscription = await tx.subscription.findUnique({
      where: { id: grant.subscriptionId },
      select: { status: true, endsAt: true }
    });
    if (!subscription || (subscription.status === "ACTIVE" &&
      (subscription.endsAt === null || subscription.endsAt > now))) {
      return "ENTITLEMENT_ACTIVE" as const;
    }
    if (!["EXPIRED", "CANCELLED", "ACTIVE"].includes(subscription.status)) return "NO_LONGER_PENDING" as const;
    const otherActive = await tx.subscriptionAccessGrant.findFirst({
      where: {
        id: { not: grantId },
        connectedChatId: grant.connectedChatId,
        revokedAt: null,
        subscription: {
          customerId: grant.subscription.customerId,
          status: "ACTIVE",
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
            { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }
          ]
        }
      },
      select: { id: true }
    });
    if (otherActive) return "ENTITLEMENT_ACTIVE" as const;
    if (!["left", "kicked"].includes(preflight.membership)) return "MEMBER_STILL_PRESENT" as const;
    if (grant.inviteLink && grant.expiresAt > now) return "INVITE_CLEANUP_REQUIRED" as const;

    // A preflight observation cannot be made atomic with Telegram moderation.
    // The operator confirms a previously observed absence, not permanent
    // exclusion; concurrent rejoining remains a documented residual risk.
    const updated = await tx.subscriptionAccessGrant.updateMany({
      where: {
        id: grantId, revokedAt: null,
        revocationLastError: grant.revocationLastError
      },
      data: {
        revokedAt: now,
        revocationReason: preflight.membership === "kicked" ? "ADMIN_EXCLUDED" :
          subscription.status === "CANCELLED" ? "ADMIN_REVOKED" : "SUBSCRIPTION_EXPIRED",
        inviteLink: "",
        expiresAt: new Date(0),
        revocationAttempts: 0,
        revocationNextAttemptAt: now,
        revocationLastError: null
      }
    });
    if (updated.count !== 1) return "NO_LONGER_PENDING" as const;
    await requestSubscriptionAccessReconciliation(
      tx, grant.subscription.customerId, [grant.connectedChatId], now
    );
    await tx.auditLog.create({
      data: {
        projectId, workspaceId: project.workspaceId, actorUserId,
        action: "ACCESS_MODERATION_REVIEW_CONFIRMED",
        resourceType: "SubscriptionAccessGrant", resourceId: grantId,
        metadata: {
          telegramMembershipObserved: preflight.membership,
          telegramChatId: preflight.telegramChatId,
          telegramUserId: preflight.telegramUserId,
          confirmedAt: now.toISOString()
        }
      }
    });
    return "CONFIRMED" as const;
  }, { maxWait: 10_000, timeout: 20_000 });
}
