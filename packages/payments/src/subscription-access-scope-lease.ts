import { randomUUID } from "node:crypto";

type ReconciliationTransaction = {
  subscriptionAccessScope: {
    upsert(input: {
      where: { customerId_connectedChatId: { customerId: string; connectedChatId: string } };
      create: { customerId: string; connectedChatId: string; desiredRevision: bigint; nextAttemptAt: Date };
      update: { desiredRevision: { increment: bigint }; nextAttemptAt: Date };
    }): Promise<unknown>;
  };
};

type ScopeLeaseExecutor = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

type ScopeLeaseRow = {
  id: string;
  customerId: string;
  connectedChatId: string;
  desiredRevision: bigint | string;
  appliedRevision: bigint | string;
  leaseToken: string;
  leaseExpiresAt: Date;
  attempts: number;
};

export interface SubscriptionAccessScopeLease {
  id: string;
  customerId: string;
  connectedChatId: string;
  revision: bigint;
  leaseToken: string;
  leaseExpiresAt: Date;
  attempts: number;
}

export const DEFAULT_SUBSCRIPTION_ACCESS_SCOPE_LEASE_TTL_MS = 60_000;

function asLease(row: ScopeLeaseRow): SubscriptionAccessScopeLease {
  return {
    id: row.id,
    customerId: row.customerId,
    connectedChatId: row.connectedChatId,
    revision: BigInt(row.desiredRevision),
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
    attempts: row.attempts
  };
}

/**
 * Increment the desired-state generation inside the same transaction as the
 * entitlement mutation. Multiple mutations coalesce into the newest revision.
 */
export async function requestSubscriptionAccessReconciliation(
  tx: ReconciliationTransaction,
  customerId: string,
  connectedChatIds: readonly string[],
  now = new Date()
): Promise<void> {
  const uniqueChatIds = [...new Set(connectedChatIds)].sort();
  for (const connectedChatId of uniqueChatIds) {
    await tx.subscriptionAccessScope.upsert({
      where: { customerId_connectedChatId: { customerId, connectedChatId } },
      create: {
        customerId,
        connectedChatId,
        desiredRevision: 1n,
        nextAttemptAt: now
      },
      update: {
        desiredRevision: { increment: 1n },
        nextAttemptAt: now
      }
    });
  }
}

/**
 * Atomically claim one dirty customer/chat scope. SKIP LOCKED allows multiple
 * workers to claim different scopes without waiting on one another.
 */
export async function claimNextSubscriptionAccessScope(
  db: ScopeLeaseExecutor,
  options: { now?: Date; leaseTtlMs?: number } = {}
): Promise<SubscriptionAccessScopeLease | null> {
  const now = options.now ?? new Date();
  const ttlMs = options.leaseTtlMs ?? DEFAULT_SUBSCRIPTION_ACCESS_SCOPE_LEASE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("Subscription access scope lease TTL must be a positive number.");
  }
  const leaseExpiresAt = new Date(now.getTime() + ttlMs);
  const leaseToken = randomUUID();
  const rows = await db.$queryRawUnsafe<ScopeLeaseRow[]>(
    'WITH candidate AS ( ' +
    '  SELECT "id" FROM "SubscriptionAccessScope" ' +
    '  WHERE "desiredRevision" > "appliedRevision" ' +
    '    AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= $1) ' +
    '    AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= $1) ' +
    '  ORDER BY COALESCE("nextAttemptAt", "createdAt"), "createdAt", "id" ' +
    '  FOR UPDATE SKIP LOCKED ' +
    '  LIMIT 1 ' +
    ') ' +
    'UPDATE "SubscriptionAccessScope" AS scope ' +
    'SET "leaseToken" = $2, "leaseExpiresAt" = $3, ' +
    '    "attempts" = scope."attempts" + 1, "updatedAt" = $1 ' +
    'FROM candidate ' +
    'WHERE scope."id" = candidate."id" ' +
    'RETURNING scope."id", scope."customerId", scope."connectedChatId", ' +
    '          scope."desiredRevision", scope."appliedRevision", scope."leaseToken", ' +
    '          scope."leaseExpiresAt", scope."attempts"',
    now,
    leaseToken,
    leaseExpiresAt
  );
  return rows.length === 1 ? asLease(rows[0]!) : null;
}

/** Extend a lease only while its token is current and its previous TTL remains valid. */
export async function renewSubscriptionAccessScopeLease(
  db: ScopeLeaseExecutor,
  lease: Pick<SubscriptionAccessScopeLease, "id" | "leaseToken">,
  options: { now?: Date; leaseTtlMs?: number } = {}
): Promise<boolean> {
  const now = options.now ?? new Date();
  const ttlMs = options.leaseTtlMs ?? DEFAULT_SUBSCRIPTION_ACCESS_SCOPE_LEASE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("Subscription access scope lease TTL must be a positive number.");
  }
  const expiresAt = new Date(now.getTime() + ttlMs);
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    'UPDATE "SubscriptionAccessScope" ' +
    'SET "leaseExpiresAt" = $3, "updatedAt" = $2 ' +
    'WHERE "id" = $1 AND "leaseToken" = $4 AND "leaseExpiresAt" > $2 ' +
    'RETURNING "id"',
    lease.id,
    now,
    expiresAt,
    lease.leaseToken
  );
  return rows.length === 1;
}

/**
 * Finalize only the exact revision and live lease that performed the external
 * operation. If a newer revision arrived during the call, leave it immediately
 * due for another reconciliation instead of treating the scope as settled.
 */
export async function completeSubscriptionAccessScope(
  db: ScopeLeaseExecutor,
  lease: Pick<SubscriptionAccessScopeLease, "id" | "leaseToken" | "revision">,
  now = new Date()
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    'UPDATE "SubscriptionAccessScope" ' +
    'SET "appliedRevision" = GREATEST("appliedRevision", $3::bigint), ' +
    '    "leaseToken" = NULL, "leaseExpiresAt" = NULL, ' +
    '    "nextAttemptAt" = CASE WHEN "desiredRevision" > $3::bigint THEN $4 ELSE NULL END, ' +
    '    "attempts" = CASE WHEN "desiredRevision" > $3::bigint THEN "attempts" ELSE 0 END, ' +
    '    "lastErrorCode" = NULL, "updatedAt" = $4 ' +
    'WHERE "id" = $1 AND "leaseToken" = $2 AND "leaseExpiresAt" > $4 ' +
    'RETURNING "id"',
    lease.id,
    lease.leaseToken,
    lease.revision,
    now
  );
  return rows.length === 1;
}

/**
 * Release a failed operation with a safe error code only. A newer requested
 * revision bypasses the old operation's backoff and is scheduled immediately.
 */
export async function failSubscriptionAccessScope(
  db: ScopeLeaseExecutor,
  lease: Pick<SubscriptionAccessScopeLease, "id" | "leaseToken" | "revision">,
  input: { retryAt: Date; errorCode: string; now?: Date }
): Promise<boolean> {
  const now = input.now ?? new Date();
  const safeErrorCode = /^[A-Z0-9_:-]{1,64}$/.test(input.errorCode)
    ? input.errorCode
    : "UNKNOWN";
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    'UPDATE "SubscriptionAccessScope" ' +
    'SET "leaseToken" = NULL, "leaseExpiresAt" = NULL, ' +
    '    "nextAttemptAt" = CASE WHEN "desiredRevision" > $3::bigint THEN $4 ELSE $5 END, ' +
    '    "lastErrorCode" = $6, "updatedAt" = $4 ' +
    'WHERE "id" = $1 AND "leaseToken" = $2 AND "leaseExpiresAt" > $4 ' +
    'RETURNING "id"',
    lease.id,
    lease.leaseToken,
    lease.revision,
    now,
    input.retryAt,
    safeErrorCode
  );
  return rows.length === 1;
}
