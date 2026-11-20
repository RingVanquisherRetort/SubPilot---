import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  acquireTelegramWebhookLease,
  releaseTelegramWebhookLease,
  renewTelegramWebhookLease,
  telegramWebhookLeaseKey
} from "./telegram-webhook-lease.js";

test("PostgreSQL webhook lease admits one owner and cannot be released by a stale owner", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const projectBotId = "lease-test-" + randomUUID();
  const firstLeaseId = randomUUID();
  const secondLeaseId = randomUUID();
  const key = telegramWebhookLeaseKey(projectBotId);

  try {
    assert.equal(await acquireTelegramWebhookLease(projectBotId, firstLeaseId), true);
    assert.equal(await acquireTelegramWebhookLease(projectBotId, secondLeaseId), false);

    assert.equal(await renewTelegramWebhookLease(projectBotId, firstLeaseId), true);

    // Simulate lease expiry so a replacement API replica can take ownership.
    await prisma.workerLease.update({
      where: { key },
      data: { lockedUntil: new Date(0) }
    });

    assert.equal(await acquireTelegramWebhookLease(projectBotId, secondLeaseId), true);
    assert.equal(await renewTelegramWebhookLease(projectBotId, firstLeaseId), false);

    // A stale replica must not delete the replacement replica's lease.
    await releaseTelegramWebhookLease(projectBotId, firstLeaseId);
    assert.equal(await renewTelegramWebhookLease(projectBotId, secondLeaseId), true);
  } finally {
    await releaseTelegramWebhookLease(projectBotId, firstLeaseId);
    await releaseTelegramWebhookLease(projectBotId, secondLeaseId);
    await prisma.$disconnect();
  }
});
