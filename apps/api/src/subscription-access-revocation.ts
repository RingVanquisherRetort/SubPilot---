import { prisma } from "@subpilot/database";

/**
 * Access is shared across overlapping active subscriptions for the same project
 * customer and Telegram chat. Expiring one entitlement must not remove a member
 * while another current entitlement still covers this chat.
 */
export async function findOtherActiveSubscriptionAccessGrant(input: {
  subscriptionId: string;
  customerId: string;
  connectedChatId: string;
  now?: Date;
}): Promise<{ id: string } | null> {
  const now = input.now ?? new Date();
  return prisma.subscriptionAccessGrant.findFirst({
    where: {
      id: { not: input.subscriptionId },
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
}
