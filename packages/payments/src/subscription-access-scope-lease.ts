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
    'WITH candidate AS (\\n' +
    '  SELECT "id" FROM "SubscriptionAccessScope"\\n' +
    '  WHERE "desiredRevision" > "appliedRevision"\\n' +
    '    AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= $1)\\n' +
    '    AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= $1)\\n' +
    '  ORDER BY COALESCE("nextAttemptAt", "createdAt"), "createdAt", "id"\\n' +
    '  FOR UPDATE SKIP LOCKED\\n' +
    '  LIMIT 1\\n' +
    ')\\n' +
    'UPDATE "SubscriptionAccessScope" AS scope\\n' +
    'SET "leaseToken" = $2, "leaseExpiresAt" = $3,\\n' +
    '    "attempts" = scope."attempts" + 1, "updatedAt" = $1\\n' +
    'FROM candidate\\n' +
    'WHERE scope."id" = candidate."id"\\n' +
    'RETURNING scope."id", scope."customerId", scope."connectedChatId",\\n' +
    '          scope."desiredRevision", scope."appliedRevision", scope."leaseToken",\\n' +
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
    'UPDATE "SubscriptionAccessScope"\\n' +
    'SET "leaseExpiresAt" = $3, "updatedAt" = $2\\n' +
    'WHERE "id" = $1 AND "leaseToken" = $4 AND "leaseExpiresAt" > $2\\n' +
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
    'UPDATE "SubscriptionAccessScope"\\n' +
    'SET "appliedRevision" = GREATEST("appliedRevision", $3::bigint),\\n' +
    '    "leaseToken" = NULL, "leaseExpiresAt" = NULL,\\n' +
    '    "nextAttemptAt" = CASE WHEN "desiredRevision" > $3::bigint THEN $4 ELSE NULL END,\\n' +
    '    "attempts" = CASE WHEN "desiredRevision" > $3::bigint THEN "attempts" ELSE 0 END,\\n' +
    '    "lastErrorCode" = NULL, "updatedAt" = $4\\n' +
    'WHERE "id" = $1 AND "leaseToken" = $2 AND "leaseExpiresAt" > $4\\n' +
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
    'UPDATE "SubscriptionAccessScope"\\n' +
    'SET "leaseToken" = NULL, "leaseExpiresAt" = NULL,\\n' +
    '    "nextAttemptAt" = CASE WHEN "desiredRevision" > $3::bigint THEN $4 ELSE $5 END,\\n' +
    '    "lastErrorCode" = $6, "updatedAt" = $4\\n' +
    'WHERE "id" = $1 AND "leaseToken" = $2 AND "leaseExpiresAt" > $4\\n' +
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
