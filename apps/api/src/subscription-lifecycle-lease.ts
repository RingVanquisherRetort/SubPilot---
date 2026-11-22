import { prisma } from "@subpilot/database";

export const SUBSCRIPTION_LIFECYCLE_LEASE_KEY = "subscription-lifecycle";
export const SUBSCRIPTION_LIFECYCLE_LEASE_TTL_MS = 5 * 60_000;

export async function acquireSubscriptionLifecycleLease(
  leaseId: string,
  key = SUBSCRIPTION_LIFECYCLE_LEASE_KEY
): Promise<boolean> {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + SUBSCRIPTION_LIFECYCLE_LEASE_TTL_MS);
  const acquired = await prisma.$queryRaw<Array<{ key: string }>>`
    INSERT INTO "WorkerLease" ("key", "leaseId", "lockedUntil", "createdAt", "updatedAt")
    VALUES (${key}, ${leaseId}, ${lockedUntil}, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE
      SET "leaseId" = EXCLUDED."leaseId",
          "lockedUntil" = EXCLUDED."lockedUntil",
          "updatedAt" = EXCLUDED."updatedAt"
      WHERE "WorkerLease"."lockedUntil" <= ${now}
    RETURNING "key"
  `;
  return acquired.length === 1;
}

export async function renewSubscriptionLifecycleLease(
  leaseId: string,
  key = SUBSCRIPTION_LIFECYCLE_LEASE_KEY
): Promise<boolean> {
  const renewed = await prisma.workerLease.updateMany({
    where: { key, leaseId },
    data: { lockedUntil: new Date(Date.now() + SUBSCRIPTION_LIFECYCLE_LEASE_TTL_MS) }
  });
  return renewed.count === 1;
}

export async function releaseSubscriptionLifecycleLease(
  leaseId: string,
  key = SUBSCRIPTION_LIFECYCLE_LEASE_KEY
): Promise<void> {
  await prisma.workerLease.deleteMany({
    where: { key, leaseId }
  });
}
