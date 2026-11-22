type Transaction = {
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
};

/**
 * Serialize mutations of one buyer's Telegram access in one connected chat,
 * even when that buyer has several overlapping subscriptions.
 *
 * This is a transaction-scoped PostgreSQL advisory lock. Every transaction
 * that changes or reconciles membership/invite state for this customer/chat
 * must acquire the same key before making that change.
 */
export async function lockSubscriptionAccessScope(
  tx: Transaction,
  customerId: string,
  connectedChatId: string
): Promise<void> {
  const key = "subpilot:subscription-access:" + customerId + ":" + connectedChatId;
  await tx.$queryRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    key
  );
}

/**
 * Acquire multiple chat scopes in deterministic order to avoid deadlocks when
 * a single payment or administrative action touches more than one destination.
 */
export async function lockSubscriptionAccessScopes(
  tx: Transaction,
  customerId: string,
  connectedChatIds: readonly string[]
): Promise<void> {
  for (const connectedChatId of Array.from(new Set(connectedChatIds)).sort()) {
    await lockSubscriptionAccessScope(tx, customerId, connectedChatId);
  }
}
