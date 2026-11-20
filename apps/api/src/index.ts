import "dotenv/config";
import Fastify from "fastify";
import { prisma } from "@subpilot/database";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" }
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
    app.log.error({ err: error }, "Database readiness check failed");
    return reply.code(503).send({
      status: "not_ready",
      database: "unavailable"
    });
  }
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down SubPilot API");
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
};

start().catch(async (error: unknown) => {
  app.log.error({ err: error }, "Could not start SubPilot API");
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
