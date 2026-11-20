import "dotenv/config";
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { Bot } from "grammy";
import { prisma } from "@subpilot/database";
import { decryptSecret } from "@subpilot/security";
import { handleProjectBotUpdate } from "./project-bot-updates.js";
import { startSubscriptionLifecycleWorker } from "./subscription-lifecycle.js";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info"
  },
  bodyLimit: 1024 * 1024
});

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

    if (!request.body || typeof request.body !== "object") {
      return reply.code(400).send({ error: "Invalid Telegram update" });
    }

    const botToken = decryptSecret(projectBot.tokenEncrypted);
    const update = request.body as TelegramUpdate;
    await handleProjectBotUpdate(botToken, projectBot.projectId, projectBot.id, update);

    return reply.code(200).send({ ok: true });
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
