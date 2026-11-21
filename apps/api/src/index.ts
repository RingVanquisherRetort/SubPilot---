import "dotenv/config";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { Bot } from "grammy";
import { prisma } from "@subpilot/database";
import { decryptSecret } from "@subpilot/security";
import { handleProjectBotUpdate } from "./project-bot-updates.js";
import { startSubscriptionLifecycleWorker } from "./subscription-lifecycle.js";
import { resolveTelegramUpdateSequenceEpoch } from "./telegram-update-order.js";
import { PlatformPaymentLifecycleError, processYooKassaWebhook } from "./platform-payment-lifecycle.js";
import { registerPlatformBillingWebRoutes } from "./platform-billing-web.js";
import {
  acquireTelegramWebhookLease,
  releaseTelegramWebhookLease,
  renewTelegramWebhookLease
} from "./telegram-webhook-lease.js";

const TELEGRAM_WEBHOOK_LEASE_HEARTBEAT_MS = 60_000;

type WebhookProcessingResult = "PROCESSED" | "DUPLICATE" | "BUSY";

async function processProjectBotWebhookUpdate(input: {
  projectBotId: string;
  projectId: string;
  botToken: string;
  update: TelegramUpdate;
}): Promise<WebhookProcessingResult> {
  const { projectBotId, projectId, botToken, update } = input;
  const updateId = update.update_id;
  const updateType = Object.keys(update).find((key) => key !== "update_id") ?? "unknown";
  const leaseId = randomUUID();

  if (!await acquireTelegramWebhookLease(projectBotId, leaseId)) return "BUSY";

  let leaseOwned = true;
  const heartbeat = setInterval(() => {
    void renewTelegramWebhookLease(projectBotId, leaseId)
      .then((renewed) => {
        if (!renewed) leaseOwned = false;
      })
      .catch(() => {
        leaseOwned = false;
      });
  }, TELEGRAM_WEBHOOK_LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();

  let webhookRecordId: string | null = null;
  let sequenceEpoch = 0;

  try {
    const botState = await prisma.projectBot.findUnique({
      where: { id: projectBotId },
      select: { updateSequenceEpoch: true, lastUpdateId: true, lastUpdateAt: true }
    });
    if (!botState) throw new Error("Project bot disappeared while processing a Telegram update.");

    const now = new Date();
    sequenceEpoch = resolveTelegramUpdateSequenceEpoch(
      botState.updateSequenceEpoch,
      botState.lastUpdateAt,
      now
    );
    const nextLastUpdateId = sequenceEpoch !== botState.updateSequenceEpoch ||
      botState.lastUpdateId === null ||
      BigInt(updateId) > botState.lastUpdateId
      ? BigInt(updateId)
      : botState.lastUpdateId;

    await prisma.projectBot.update({
      where: { id: projectBotId },
      data: {
        updateSequenceEpoch: sequenceEpoch,
        lastUpdateId: nextLastUpdateId,
        lastUpdateAt: now
      }
    });

    const unique = {
      projectBotId_sequenceEpoch_updateId: {
        projectBotId,
        sequenceEpoch,
        updateId
      }
    };
    const previous = await prisma.telegramWebhookUpdate.findUnique({
      where: unique,
      select: { id: true, processedAt: true }
    });
    if (previous?.processedAt) return "DUPLICATE";

    const record = await prisma.telegramWebhookUpdate.upsert({
      where: unique,
      create: {
        projectBotId,
        sequenceEpoch,
        updateId,
        updateType
      },
      update: {
        attempts: { increment: 1 },
        lastError: null,
        receivedAt: now
      },
      select: { id: true }
    });
    webhookRecordId = record.id;

    await handleProjectBotUpdate(
      botToken,
      projectId,
      projectBotId,
      update,
      updateId,
      sequenceEpoch
    );
    if (!leaseOwned) {
      throw new Error("Telegram webhook processing lease was lost before acknowledgement.");
    }

    await prisma.telegramWebhookUpdate.update({
      where: { id: record.id },
      data: { processedAt: new Date(), lastError: null }
    });
    return "PROCESSED";
  } catch (error) {
    if (webhookRecordId) {
      await prisma.telegramWebhookUpdate.updateMany({
        where: { id: webhookRecordId, processedAt: null },
        data: { lastError: error instanceof Error ? error.name : "UnknownError" }
      }).catch(() => undefined);
    } else {
      await prisma.telegramWebhookUpdate.upsert({
        where: {
          projectBotId_sequenceEpoch_updateId: { projectBotId, sequenceEpoch, updateId }
        },
        create: {
          projectBotId,
          sequenceEpoch,
          updateId,
          updateType,
          lastError: error instanceof Error ? error.name : "UnknownError"
        },
        update: {
          attempts: { increment: 1 },
          lastError: error instanceof Error ? error.name : "UnknownError"
        }
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    await releaseTelegramWebhookLease(projectBotId, leaseId).catch(() => undefined);
  }
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info"
  },
  bodyLimit: 1024 * 1024
});

registerPlatformBillingWebRoutes(app);

app.get("/health", async () => ({
  status: "ok",
  service: "subpilot-api",
  timestamp: new Date().toISOString()
}));

app.get("/ready", async (_request, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ready", database: "connected" };
  } catch (error) {
    app.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Database readiness check failed");
    return reply.code(503).send({
      status: "not_ready",
      database: "unavailable"
    });
  }
});

app.post<{ Params: { connectionId: string } }>(
  "/webhooks/platform/yookassa/:connectionId",
  async (request, reply) => {
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(request.params.connectionId)) {
      return reply.code(400).send({ error: "Invalid provider connection identifier" });
    }
    try {
      const result = await processYooKassaWebhook({
        connectionId: request.params.connectionId,
        headers: request.headers as Record<string, string | string[] | undefined>,
        rawBody: typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? null),
        body: request.body
      });
      if (!result.authenticated) {
        return reply.code(401).send({ error: "Provider notification could not be authenticated" });
      }
      return reply.code(200).send({
        ok: true,
        processed: result.processed,
        duplicates: result.duplicates,
        manualReview: result.manualReview
      });
    } catch (error) {
      const missing = error instanceof PlatformPaymentLifecycleError &&
        error.code === "PROVIDER_CONNECTION_NOT_FOUND";
      request.log.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "YooKassa webhook processing failed"
      );
      return reply.code(missing ? 404 : 503).send({
        error: missing ? "Provider connection not found" : "Webhook temporarily unavailable"
      });
    }
  }
);

app.post<{ Params: { botId: string } }>("/webhooks/telegram/:botId", async (request, reply) => {
  const { botId } = request.params;

  if (!/^\d{5,20}$/.test(botId)) {
    return reply.code(400).send({ error: "Invalid bot identifier" });
  }

  const providedSecret = request.headers["x-telegram-bot-api-secret-token"];

  if (typeof providedSecret !== "string" || !providedSecret) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  try {
    const projectBot = await prisma.projectBot.findUnique({
      where: { telegramBotId: BigInt(botId) },
      select: {
        id: true,
        projectId: true,
        tokenEncrypted: true,
        webhookSecretHash: true,
        status: true
      }
    });

    if (!projectBot || !projectBot.webhookSecretHash) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const providedHash = createHash("sha256").update(providedSecret).digest();
    const storedHash = Buffer.from(projectBot.webhookSecretHash, "hex");

    if (storedHash.length !== providedHash.length || !timingSafeEqual(storedHash, providedHash)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    if (projectBot.status === "DISABLED") {
      return reply.code(410).send({ error: "Bot disabled" });
    }

    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      return reply.code(400).send({ error: "Invalid Telegram update" });
    }

    const botToken = decryptSecret(projectBot.tokenEncrypted);
    const update = request.body as TelegramUpdate;
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      return reply.code(400).send({ error: "Invalid Telegram update identifier" });
    }
    const outcome = await processProjectBotWebhookUpdate({
      projectBotId: projectBot.id,
      projectId: projectBot.projectId,
      botToken,
      update
    });
    if (outcome === "BUSY") {
      return reply.code(503).send({ error: "Another update for this bot is still processing; Telegram should retry." });
    }
    return reply.code(200).send({ ok: true, duplicate: outcome === "DUPLICATE" });
  } catch (error) {
    // Never log the request body, bot token or Telegram webhook secret.
    request.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Project bot webhook processing failed"
    );
    return reply.code(500).send({ error: "Webhook processing failed" });
  }
});

type TelegramUpdate = Parameters<Bot["handleUpdate"]>[0];

let stopSubscriptionLifecycle: (() => void) | undefined;

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down SubPilot API");
  stopSubscriptionLifecycle?.();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

const start = async (): Promise<void> => {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port");
  }

  await prisma.$connect();
  await app.listen({ port, host });
  stopSubscriptionLifecycle = startSubscriptionLifecycleWorker();
};

start().catch(async (error: unknown) => {
  app.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Could not start SubPilot API");
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
