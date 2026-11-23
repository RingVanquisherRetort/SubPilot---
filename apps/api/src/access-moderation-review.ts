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
