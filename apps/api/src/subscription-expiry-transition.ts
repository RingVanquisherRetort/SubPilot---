import { prisma } from "@subpilot/database";

type Transaction = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">;

/**
 * Claims an expiry transition and runs its outbox writes in the same transaction.
 * Side effects run only when the conditional ACTIVE -> EXPIRED update wins.
 */
export async function claimSubscriptionExpiry(
  updateStatus: () => Promise<{ count: number }>,
  enqueueTransitionEffects: () => Promise<void>
): Promise<boolean> {
  const result = await updateStatus();
  if (result.count !== 1) return false;
  await enqueueTransitionEffects();
  return true;
}

export interface LockedSubscriptionExpiryResult<T> {
  shouldRevoke: boolean;
  result?: T;
}

/**
 * Serialize Telegram access removal against payments and renewal controls.
 *
 * A payment handler locks the same Subscription row before extending the term.
 * The worker must therefore re-read the entitlement after acquiring the lock and
 * keep the lock until Telegram revocation and the grant update have completed.
 * If a renewal committed first, the worker sees the new ACTIVE/future period and
 * must not revoke; if the worker won first, the payment handler runs afterwards
 * and can deliver the renewed access again.
 */
export async function withSubscriptionExpiryRowLock<T>(
  tx: Transaction,
  subscriptionId: string,
  now: Date,
  revokeAccess: (currentStatus: string) => Promise<T>
): Promise<LockedSubscriptionExpiryResult<T>> {
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
    subscriptionId
  );

  const current = await tx.subscription.findUnique({
    where: { id: subscriptionId },
    select: { status: true, endsAt: true }
  });
  const isDue = Boolean(
    current &&
    (
      current.status === "EXPIRED" ||
      current.status === "CANCELLED" ||
      (current.status === "ACTIVE" && current.endsAt !== null && current.endsAt <= now)
    )
  );

  if (!isDue) return { shouldRevoke: false };
  return { shouldRevoke: true, result: await revokeAccess(current!.status) };
}
