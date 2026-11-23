import { Bot } from "grammy";
import { prisma } from "@subpilot/database";
import { reconcileSubscriptionAccessRemoval } from "../subscription-access-removal.js";

// Invoked only by the PostgreSQL process-death test, with a loopback Bot API.
const [port, subscriptionId, customerId, connectedChatId, userId] = process.argv.slice(2);
if (!port || !/^\d+$/.test(port) || !subscriptionId || !customerId || !connectedChatId || !userId) {
  throw new Error("Missing test fixture arguments");
}
try {
  const bot = new Bot("42:test", { client: { apiRoot: "http://127.0.0.1:" + port } });
  const result = await reconcileSubscriptionAccessRemoval({
    bot, subscriptionId, customerId, connectedChatId, telegramUserId: BigInt(userId), allowAutomaticMemberBan: true
  });
  process.send?.(result);
} finally {
  await prisma.$disconnect();
}
