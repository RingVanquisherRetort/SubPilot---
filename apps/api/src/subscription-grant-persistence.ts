export interface SubscriptionGrantChat {
  id: string;
  isActive: boolean;
}

/**
 * A paid entitlement must retain a grant row for every purchased destination,
 * even while a bot temporarily lacks permission there. The lifecycle worker
 * retries inactive destinations once the bot regains access.
 */
export function getSubscriptionGrantChatIds(
  chats: readonly SubscriptionGrantChat[]
): string[] {
  return [...new Set(chats.map((chat) => chat.id))];
}
