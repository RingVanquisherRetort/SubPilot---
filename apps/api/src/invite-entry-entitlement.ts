import { prisma } from "@subpilot/database";

export async function hasActiveInviteEntrantGrant(projectId: string, connectedChatId: string, telegramUserId: bigint): Promise<boolean> {
  const now = new Date();
  const grant = await prisma.subscriptionAccessGrant.findFirst({
    where: {
      connectedChatId,
      revokedAt: null,
      subscription: {
        projectId, customer: { telegramUserId }, status: "ACTIVE",
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }
        ]
      }
    },
    select: { id: true }
  });
  return grant !== null;
}
