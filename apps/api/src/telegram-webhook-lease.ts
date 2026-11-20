import { prisma } from "@subpilot/database";

export const TELEGRAM_WEBHOOK_LEASE_TTL_MS = 5 * 60_000;

export function telegramWebhookLeaseKey(projectBotId: string): string {
  return "telegram-webhook:" + projectBotId;
}

export async function acquireTelegramWebhookLease(projectBotId: string, leaseId: string): Promise<boolean> {
  const key = telegramWebhookLeaseKey(projectBotId);
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + TELEGRAM_WEBHOOK_LEASE_TTL_MS);
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

export async function renewTelegramWebhookLease(projectBotId: string, leaseId: string): Promise<boolean> {
  const renewed = await prisma.workerLease.updateMany({
    where: { key: telegramWebhookLeaseKey(projectBotId), leaseId },
    data: { lockedUntil: new Date(Date.now() + TELEGRAM_WEBHOOK_LEASE_TTL_MS) }
  });
  return renewed.count === 1;
}

export async function releaseTelegramWebhookLease(projectBotId: string, leaseId: string): Promise<void> {
  await prisma.workerLease.deleteMany({
    where: { key: telegramWebhookLeaseKey(projectBotId), leaseId }
  });
}
