import type { Bot } from "grammy";
import { prisma } from "@subpilot/database";

/**
 * Read-only, tenant-scoped moderation work queue. Reading a case never
 * mutates Telegram membership or acknowledges a removal.
 *
 * Acknowledgement must be implemented separately with a fresh Telegram
 * membership check and a conditional, audited database transition.
 */
export async function listPendingAccessModerationReviews(
  projectId: string,
  actorUserId: string,
  limit = 50
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true, workspace: { select: { createdById: true } } }
  });
  if (!project) return null;
  const authorized = project.workspace.createdById === actorUserId ||
    Boolean(await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: project.workspaceId, userId: actorUserId } },
      select: { id: true }
    }));
  if (!authorized) return null;

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
  | { state: "REVIEW_REQUIRED"; membership: string; telegramChatId: string; telegramUserId: string }
> {
  const authorizedQueue = await listPendingAccessModerationReviews(projectId, actorUserId, 100);
  if (authorizedQueue === null) return { state: "UNAUTHORIZED" };
  const row = authorizedQueue.find((item) => item.grantId === grantId);
  if (!row) {
    const renewed = await prisma.subscriptionAccessGrant.findFirst({
      where: { id: grantId, subscription: { projectId } },
      select: {
        revokedAt: true,
        revocationLastError: true,
        subscription: { select: { status: true, endsAt: true } }
      }
    });
    if (renewed?.revokedAt === null && renewed.revocationLastError &&
      ["MEMBER_MODERATION_REVIEW_REQUIRED", "MEMBER_BAN_OWNERSHIP_UNCERTAIN", "LEGACY_GROUP_REMOVAL_REVIEW"].includes(renewed.revocationLastError) &&
      renewed.subscription.status === "ACTIVE" &&
      (renewed.subscription.endsAt === null || renewed.subscription.endsAt > new Date())) {
      return { state: "ENTITLEMENT_ACTIVE" };
    }
    return { state: "NO_LONGER_PENDING" };
  }
  const userId = Number(row.telegramUserId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return { state: "TELEGRAM_CHECK_FAILED" };
  try {
    const member = await bot.api.getChatMember(row.telegramChatId, userId);
    return {
      state: "REVIEW_REQUIRED",
      membership: member.status,
      telegramChatId: row.telegramChatId,
      telegramUserId: row.telegramUserId
    };
  } catch {
    return { state: "TELEGRAM_CHECK_FAILED" };
  }
}
