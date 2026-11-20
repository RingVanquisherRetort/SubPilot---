import { Bot, InlineKeyboard } from "grammy";
import { prisma } from "@subpilot/database";
import { decryptSecret } from "@subpilot/security";
import { deliverSubscriptionAccess } from "./project-bot-updates.js";
import {
  deliverPendingOwnerNotifications,
  enqueueProjectOwnerNotification
} from "./owner-notifications.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;

function createRenewalKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Продлить подписку", "buyer:plans");
}

async function getProjectBot(projectId: string, projectBotId?: string): Promise<Bot | null> {
  const record = await prisma.projectBot.findFirst({
    where: {
      projectId,
      status: "ACTIVE",
      ...(projectBotId ? { id: projectBotId } : {})
    },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }]
  });

  if (!record) return null;

  try {
    return new Bot(decryptSecret(record.tokenEncrypted));
  } catch (error) {
    console.error(
      "Could not decrypt project bot token for lifecycle job:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return null;
  }
}

async function retryPendingAccessDeliveries(now: Date): Promise<void> {
  const due = await prisma.subscription.findMany({
    where: {
      status: "ACTIVE",
      AND: [
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        {
          accessGrants: {
            some: {
              joinedAt: null,
              revokedAt: null,
              updatedAt: { lte: new Date(now.getTime() - 5 * 60_000) },
              OR: [
                { inviteLink: "" },
                { expiresAt: { lte: now } }
              ]
            }
          }
        }
      ]
    },
    include: {
      customer: true,
      project: { select: { id: true, name: true } },
      plan: { select: { title: true } },
      payments: {
        where: { status: "SUCCEEDED" },
        orderBy: { paidAt: "desc" },
        take: 1,
        select: { metadata: true }
      }
    },
    orderBy: { updatedAt: "asc" },
    take: BATCH_SIZE
  });

  for (const subscription of due) {
    const metadata = subscription.payments[0]?.metadata &&
      typeof subscription.payments[0].metadata === "object" &&
      !Array.isArray(subscription.payments[0].metadata)
      ? subscription.payments[0].metadata as Record<string, unknown>
      : {};
    const projectBotId = typeof metadata.projectBotId === "string"
      ? metadata.projectBotId
      : undefined;
    const chatIds = Array.isArray(metadata.chatIds)
      ? metadata.chatIds.filter((value): value is string => typeof value === "string")
      : undefined;
    const bot = await getProjectBot(subscription.projectId, projectBotId);
    if (!bot) continue;

    try {
      const access = await deliverSubscriptionAccess(bot, subscription.id, chatIds);
      if (access.links.length > 0 && access.failed.length === 0) {
        await bot.api.sendMessage(
          Number(subscription.customer.telegramUserId),
          "Платёж подтверждён. Не все ссылки удалось выдать сразу, поэтому SubPilot повторил попытку. Актуальные ссылки для вступления:\n\n" +
          access.links.join("\n")
        );
      }
      if (access.failed.length > 0) {
        await enqueueProjectOwnerNotification({
          projectId: subscription.projectId,
          dedupeKey: "subscription:" + subscription.id + ":access-delivery-pending",
          eventType: "access_delivery_pending",
          messageText:
            "⚠️ Не удалось автоматически выдать доступ по тарифу «" + subscription.plan.title +
            "» в проекте «" + subscription.project.name + "». Необходимо проверить права бота и подключённые площадки: " +
            access.failed.join(", ")
        });
      }
    } catch (error) {
      console.error(
        "Could not retry subscription access delivery:",
        error instanceof Error ? error.name : "UnknownError"
      );
    }
  }
}

async function sendRenewalReminders(now: Date): Promise<void> {
  const threeDayLimit = new Date(now.getTime() + 3 * DAY_MS);
  const oneDayLimit = new Date(now.getTime() + DAY_MS);

  const due = await prisma.subscription.findMany({
    where: {
      status: "ACTIVE",
      endsAt: { gt: now, lte: threeDayLimit },
      OR: [
        {
          endsAt: { gt: oneDayLimit, lte: threeDayLimit },
          reminder3dAt: null
        },
        {
          endsAt: { gt: now, lte: oneDayLimit },
          reminder1dAt: null
        }
      ]
    },
    include: {
      customer: true,
      plan: true,
      project: { select: { id: true, name: true } },
      payments: {
        where: { status: "SUCCEEDED" },
        orderBy: { paidAt: "desc" },
        take: 1,
        select: { metadata: true }
      }
    },
    orderBy: { endsAt: "asc" },
    take: BATCH_SIZE
  });

  const bots = new Map<string, Bot | null>();

  for (const subscription of due) {
    const expiresAt = subscription.endsAt;
    if (!expiresAt) continue;

    const daysLeft = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS));
    const isOneDayReminder = expiresAt.getTime() <= oneDayLimit.getTime();
    const field = isOneDayReminder ? "reminder1dAt" : "reminder3dAt";
    if (subscription[field]) continue;

    await enqueueProjectOwnerNotification({
      projectId: subscription.projectId,
      dedupeKey: `subscription:${subscription.id}:owner:${field}`,
      eventType: isOneDayReminder ? "subscription_ending_1d" : "subscription_ending_3d",
      messageText:
        `⏳ Скоро закончится тариф\nПроект: «${subscription.project.name}»\n` +
        `Тариф: «${subscription.plan.title}»\n` +
        `Окончание: ${expiresAt.toLocaleString("ru-RU")}\n` +
        `Осталось примерно ${daysLeft} дн.`
    });

    const latestMetadata = subscription.payments[0]?.metadata &&
      typeof subscription.payments[0].metadata === "object" &&
      !Array.isArray(subscription.payments[0].metadata)
      ? subscription.payments[0].metadata as Record<string, unknown>
      : {};
    const originProjectBotId = typeof latestMetadata.projectBotId === "string"
      ? latestMetadata.projectBotId
      : undefined;
    const botKey = subscription.projectId + ":" + (originProjectBotId ?? "primary");
    let bot = bots.get(botKey);
    if (bot === undefined) {
      bot = await getProjectBot(subscription.projectId, originProjectBotId);
      bots.set(botKey, bot);
    }
    if (!bot) continue;

    try {
      await bot.api.sendMessage(
        Number(subscription.customer.telegramUserId),
        `Напоминание о подписке «${subscription.plan.title}» в проекте «${subscription.project.name}».\n\n` +
        `Доступ закончится: ${expiresAt.toLocaleString("ru-RU")}.\n` +
        `Осталось примерно ${daysLeft} дн. Чтобы сохранить доступ, выберите продление ниже.`,
        { reply_markup: createRenewalKeyboard() }
      );

      await prisma.subscription.updateMany({
        where: {
          id: subscription.id,
          status: "ACTIVE",
          [field]: null
        },
        data: { [field]: now }
      });
    } catch (error) {
      console.error(
        "Could not send subscription renewal reminder:",
        error instanceof Error ? error.name : "UnknownError"
      );
    }
  }
}

async function expireSubscriptions(now: Date): Promise<void> {
  const due = await prisma.subscription.findMany({
    where: {
      OR: [
        { status: "ACTIVE", endsAt: { lte: now } },
        {
          status: "EXPIRED",
          accessGrants: { some: { revokedAt: null } }
        }
      ]
    },
    include: {
      customer: true,
      accessGrants: {
        where: { revokedAt: null },
        include: { connectedChat: true }
      },
      project: { select: { id: true, name: true } },
      plan: { select: { title: true } },
      payments: {
        orderBy: { paidAt: "desc" },
        take: 1,
        select: { metadata: true }
      }
    },
    orderBy: { endsAt: "asc" },
    take: BATCH_SIZE
  });

  const bots = new Map<string, Bot | null>();

  for (const subscription of due) {
    let newlyExpired = false;
    if (subscription.status === "ACTIVE") {
      const expired = await prisma.subscription.updateMany({
        where: { id: subscription.id, status: "ACTIVE", endsAt: { lte: now } },
        data: { status: "EXPIRED" }
      });
      newlyExpired = expired.count === 1;
    }

    if (newlyExpired) {
      await enqueueProjectOwnerNotification({
        projectId: subscription.projectId,
        dedupeKey: `subscription:${subscription.id}:owner:expired`,
        eventType: "subscription_expired",
        messageText:
          `🔔 Срок тарифа закончился\nПроект: «${subscription.project.name}»\n` +
          `Тариф: «${subscription.plan.title}»\n` +
          "SubPilot запустил автоматическое отключение доступа."
      });
    }

    const latestMetadata = subscription.payments[0]?.metadata &&
      typeof subscription.payments[0].metadata === "object" &&
      !Array.isArray(subscription.payments[0].metadata)
      ? subscription.payments[0].metadata as Record<string, unknown>
      : {};
    const originProjectBotId = typeof latestMetadata.projectBotId === "string"
      ? latestMetadata.projectBotId
      : undefined;
    const botKey = subscription.projectId + ":" + (originProjectBotId ?? "primary");
    let bot = bots.get(botKey);
    if (bot === undefined) {
      bot = await getProjectBot(subscription.projectId, originProjectBotId);
      bots.set(botKey, bot);
    }
    if (!bot) continue;

    for (const grant of subscription.accessGrants) {
      const chatId = grant.connectedChat.telegramChatId.toString();
      let completed = true;

      try {
        if (grant.inviteLink && grant.expiresAt > now) {
          await bot.api.revokeChatInviteLink(chatId, grant.inviteLink);
        }

        if (grant.joinedAt) {
          const telegramUserId = Number(subscription.customer.telegramUserId);
          await bot.api.banChatMember(chatId, telegramUserId);
          await bot.api.unbanChatMember(chatId, telegramUserId, { only_if_banned: true });
        }
      } catch (error) {
        completed = false;
        console.error(
          "Could not revoke expired subscription access:",
          error instanceof Error ? error.name : "UnknownError"
        );
      }

      if (completed) {
        await prisma.subscriptionAccessGrant.updateMany({
          where: { id: grant.id, revokedAt: null },
          data: { revokedAt: now }
        });
      }
    }

    if (subscription.status === "ACTIVE") {
      await bot.api.sendMessage(
        Number(subscription.customer.telegramUserId),
        `Срок подписки в проекте «${subscription.project.name}» закончился. Доступ к закрытым площадкам прекращён.\n\nВы можете оформить её снова:`,
        { reply_markup: createRenewalKeyboard() }
      ).catch(() => undefined);
    }
  }
}

export async function runSubscriptionLifecycle(now = new Date()): Promise<void> {
  await retryPendingAccessDeliveries(now);
  await sendRenewalReminders(now);
  await expireSubscriptions(now);
  await deliverPendingOwnerNotifications(now);
}

export function startSubscriptionLifecycleWorker(
  intervalMs = 60_000
): () => void {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      await runSubscriptionLifecycle();
    } catch (error) {
      console.error(
        "Subscription lifecycle worker failed:",
        error instanceof Error ? error.name : "UnknownError"
      );
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
