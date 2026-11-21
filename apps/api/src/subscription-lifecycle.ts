import { randomUUID } from "node:crypto";
import {
  acquireSubscriptionLifecycleLease,
  releaseSubscriptionLifecycleLease,
  renewSubscriptionLifecycleLease
} from "./subscription-lifecycle-lease.js";
import { Bot, InlineKeyboard } from "grammy";
import { prisma } from "@subpilot/database";
import { decryptSecret } from "@subpilot/security";
import { isTelegramInviteAlreadyRevoked, MAX_ACCESS_DELIVERY_ATTEMPTS } from "@subpilot/payments";
import {
  deliverSubscriptionAccess,
  recordSubscriptionAccessDeliveryFailure
} from "./project-bot-updates.js";
import { getSubscriptionGrantTelegramChatIds } from "./subscription-grant-persistence.js";
import { buildExpiredSubscriptionNotice } from "./subscription-messages.js";
import { runLifecyclePassWithLease } from "./subscription-lifecycle-runner.js";
import {
  deliverPendingOwnerNotifications,
  enqueueProjectOwnerNotification,
  enqueueProjectOwnerNotificationUsing
} from "./owner-notifications.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_PAYMENT_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;
const WORKER_LEASE_HEARTBEAT_MS = 60_000;
type LeaseOwnershipCheck = () => boolean;

async function cancelStalePendingPayments(
  now: Date,
  isLeaseOwned: LeaseOwnershipCheck = () => true
): Promise<void> {
  const cutoff = new Date(now.getTime() - PENDING_PAYMENT_TTL_MS);
  const stalePayments = await prisma.payment.findMany({
    where: {
      provider: "TELEGRAM_STARS",
      status: "PENDING",
      createdAt: { lte: cutoff }
    },
    select: { id: true, subscriptionId: true },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE
  });

  for (const payment of stalePayments) {
    if (!isLeaseOwned()) return;
    await prisma.$transaction(async (tx) => {
      const cancelled = await tx.payment.updateMany({
        where: {
          id: payment.id,
          provider: "TELEGRAM_STARS",
          status: "PENDING",
          createdAt: { lte: cutoff }
        },
        data: { status: "CANCELLED" }
      });
      if (cancelled.count !== 1 || !payment.subscriptionId) return;

      const remainingPendingPayments = await tx.payment.count({
        where: { subscriptionId: payment.subscriptionId, status: "PENDING" }
      });
      if (remainingPendingPayments === 0) {
        await tx.subscription.updateMany({
          where: { id: payment.subscriptionId, status: "PENDING" },
          data: { status: "CANCELLED", cancelledAt: now }
        });
      }
    });
  }
}

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

async function retryPendingAccessDeliveries(
  now: Date,
  isLeaseOwned: LeaseOwnershipCheck = () => true
): Promise<void> {
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
              deliveryAttempts: { lt: MAX_ACCESS_DELIVERY_ATTEMPTS },
              deliveryNextAttemptAt: { lte: now },
              OR: [
                { inviteLink: "" },
                { expiresAt: { lte: now } },
                { deliveryLastError: { not: null } }
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
      },
      accessGrants: {
        where: {
          joinedAt: null,
          revokedAt: null,
          deliveryAttempts: { lt: MAX_ACCESS_DELIVERY_ATTEMPTS },
          deliveryNextAttemptAt: { lte: now },
          OR: [
            { inviteLink: "" },
            { expiresAt: { lte: now } },
            { deliveryLastError: { not: null } }
          ]
        },
        select: {
          id: true,
          connectedChat: { select: { id: true, telegramChatId: true } }
        }
      }
    },
    orderBy: { updatedAt: "asc" },
    take: BATCH_SIZE
  });

  for (const subscription of due) {
    if (!isLeaseOwned()) return;
    const metadata = subscription.payments[0]?.metadata &&
      typeof subscription.payments[0].metadata === "object" &&
      !Array.isArray(subscription.payments[0].metadata)
      ? subscription.payments[0].metadata as Record<string, unknown>
      : {};
    const projectBotId = typeof metadata.projectBotId === "string"
      ? metadata.projectBotId
      : undefined;
    // Deliver against every persisted grant, not just the latest payment's
    // chatIds snapshot. Earlier purchases can have destinations no longer linked
    // to the plan, but their active entitlement rows must still be recoverable.
    const chatIds = getSubscriptionGrantTelegramChatIds(subscription.accessGrants);
    const bot = await getProjectBot(subscription.projectId, projectBotId);
    if (!isLeaseOwned()) return;
    if (!bot) {
      for (const grant of subscription.accessGrants) {
        if (!isLeaseOwned()) return;
        await recordSubscriptionAccessDeliveryFailure(
          subscription.id,
          grant.connectedChat.id,
          "SOURCE_BOT_UNAVAILABLE"
        );
      }
      await enqueueProjectOwnerNotification({
        projectId: subscription.projectId,
        dedupeKey: "subscription:" + subscription.id + ":access-delivery-bot-unavailable",
        eventType: "access_delivery_bot_unavailable",
        messageText:
          "⚠️ Не удалось восстановить доступ по тарифу «" + subscription.plan.title +
          "» в проекте «" + subscription.project.name +
          "»: исходный бот недоступен или отключён. Восстановите подключение исходного бота, чтобы SubPilot повторил выдачу ссылок."
      });
      continue;
    }

    try {
      const access = await deliverSubscriptionAccess(bot, subscription.id, chatIds, isLeaseOwned);
      if (!isLeaseOwned()) return;
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

async function sendRenewalReminders(
  now: Date,
  isLeaseOwned: LeaseOwnershipCheck = () => true
): Promise<void> {
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
    if (!isLeaseOwned()) return;
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

    if (!isLeaseOwned()) return;

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

    if (!isLeaseOwned()) return;

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

async function expireSubscriptions(
  now: Date,
  isLeaseOwned: LeaseOwnershipCheck = () => true
): Promise<void> {
  const due = await prisma.subscription.findMany({
    where: {
      OR: [
        { status: "ACTIVE", endsAt: { lte: now } },
        {
          status: { in: ["EXPIRED", "CANCELLED"] },
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
    if (!isLeaseOwned()) return;
    if (subscription.status === "ACTIVE") {
      await prisma.$transaction(async (tx) => {
        const expired = await tx.subscription.updateMany({
          where: { id: subscription.id, status: "ACTIVE", endsAt: { lte: now } },
          data: { status: "EXPIRED" }
        });
        if (expired.count !== 1) return false;

        // Persist the state transition and its owner-notification outbox rows atomically.
        await enqueueProjectOwnerNotificationUsing(tx, {
          projectId: subscription.projectId,
          dedupeKey: `subscription:${subscription.id}:owner:expired`,
          eventType: "subscription_expired",
          messageText:
            `🔔 Срок тарифа закончился\nПроект: «${subscription.project.name}»\n` +
            `Тариф: «${subscription.plan.title}»\n` +
            "SubPilot запустил автоматическое отключение доступа."
        });
        return true;
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
    if (!bot) {
      await enqueueProjectOwnerNotification({
        projectId: subscription.projectId,
        dedupeKey: "subscription:" + subscription.id + ":access-revocation-bot-unavailable",
        eventType: "access_revocation_bot_unavailable",
        messageText:
          (subscription.status === "CANCELLED"
            ? "⚠️ Администратор досрочно отозвал доступ по тарифу «"
            : "⚠️ Срок доступа по тарифу «") + subscription.plan.title +
          "» в проекте «" + subscription.project.name +
          "», но исходный бот недоступен. Восстановите подключение исходного бота, чтобы SubPilot смог обработать отзыв."
      });
      continue;
    }

    const removalFailures: string[] = [];
    let accessPreservedByAnotherSubscription = false;
    for (const grant of subscription.accessGrants) {
      if (!isLeaseOwned()) return;
      const otherActiveGrant = await prisma.subscriptionAccessGrant.findFirst({
        where: {
          id: { not: grant.id },
          connectedChatId: grant.connectedChatId,
          revokedAt: null,
          subscription: {
            id: { not: subscription.id },
            customerId: subscription.customerId,
            status: "ACTIVE",
            AND: [
              { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
              { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }
            ]
          }
        },
        select: { id: true }
      });
      if (otherActiveGrant) {
        // Preserve membership from the other entitlement, but still revoke the
        // expiring grant's unused one-person invite so it cannot be shared later.
        const chatId = grant.connectedChat.telegramChatId.toString();
        try {
          if (grant.inviteLink && grant.expiresAt > now) {
            await bot.api.revokeChatInviteLink(chatId, grant.inviteLink);
            if (!isLeaseOwned()) return;
          }
        } catch (error) {
          if (!isTelegramInviteAlreadyRevoked(error)) {
            removalFailures.push(
              grant.connectedChat.title ?? grant.connectedChat.username ?? chatId
            );
            continue;
          }
        }
        accessPreservedByAnotherSubscription = true;
        if (!isLeaseOwned()) return;
        await prisma.subscriptionAccessGrant.updateMany({
          where: { id: grant.id, revokedAt: null },
          data: { revokedAt: now, inviteLink: "", expiresAt: new Date(0) }
        });
        continue;
      }

      const chatId = grant.connectedChat.telegramChatId.toString();
      let completed = true;

      try {
        if (grant.inviteLink && grant.expiresAt > now) {
          try {
            await bot.api.revokeChatInviteLink(chatId, grant.inviteLink);
            if (!isLeaseOwned()) return;
          } catch (error) {
            if (!isTelegramInviteAlreadyRevoked(error)) throw error;
          }
        }

        if (grant.joinedAt) {
          const telegramUserId = Number(subscription.customer.telegramUserId);
          await bot.api.banChatMember(chatId, telegramUserId);
          if (!isLeaseOwned()) return;
          await bot.api.unbanChatMember(chatId, telegramUserId, { only_if_banned: true });
          if (!isLeaseOwned()) return;
        }
      } catch (error) {
        completed = false;
        removalFailures.push(
          grant.connectedChat.title ?? grant.connectedChat.username ?? chatId
        );
        console.error(
          "Could not revoke expired subscription access:",
          error instanceof Error ? error.name : "UnknownError"
        );
      }

      if (completed) {
        if (!isLeaseOwned()) return;
        await prisma.subscriptionAccessGrant.updateMany({
          where: { id: grant.id, revokedAt: null },
          data: { revokedAt: now }
        });
      }
    }

    if (removalFailures.length > 0) {
      await enqueueProjectOwnerNotification({
        projectId: subscription.projectId,
        dedupeKey: "subscription:" + subscription.id + ":access-revocation-pending",
        eventType: "access_revocation_pending",
        messageText:
          "⚠️ SubPilot не смог полностью отключить истёкший доступ по тарифу «" +
          subscription.plan.title + "» в проекте «" + subscription.project.name +
          "». Проверьте права исходного бота и подключённые площадки: " + removalFailures.join(", ")
      });
    }

    if (subscription.status === "ACTIVE") {
      await bot.api.sendMessage(
        Number(subscription.customer.telegramUserId),
        buildExpiredSubscriptionNotice(subscription.project.name, removalFailures),
        { reply_markup: createRenewalKeyboard() }
      ).catch(() => undefined);
    } else if (subscription.status === "CANCELLED" && removalFailures.length === 0) {
      const notice = accessPreservedByAnotherSubscription
        ? `Доступ по подписке «${subscription.plan.title}» в проекте «${subscription.project.name}» отменён администратором. Другие действующие подписки продолжают работать.`
        : `Доступ по подписке «${subscription.plan.title}» в проекте «${subscription.project.name}» досрочно отключён администратором.`;
      await bot.api.sendMessage(
        Number(subscription.customer.telegramUserId),
        notice
      ).catch(() => undefined);
    }
  }
}

export async function runSubscriptionLifecycle(now = new Date()): Promise<void> {
  const leaseId = randomUUID();
  await runLifecyclePassWithLease({
    leaseId,
    heartbeatMs: WORKER_LEASE_HEARTBEAT_MS,
    acquire: acquireSubscriptionLifecycleLease,
    renew: renewSubscriptionLifecycleLease,
    release: releaseSubscriptionLifecycleLease,
    stages: [
      (isLeaseOwned) => cancelStalePendingPayments(now, isLeaseOwned),
      (isLeaseOwned) => retryPendingAccessDeliveries(now, isLeaseOwned),
      (isLeaseOwned) => sendRenewalReminders(now, isLeaseOwned),
      (isLeaseOwned) => expireSubscriptions(now, isLeaseOwned),
      (isLeaseOwned) => deliverPendingOwnerNotifications(now, isLeaseOwned)
    ],
    onLeaseLost: (reason) => {
      console.error(
        "Subscription lifecycle worker lost its PostgreSQL lease; the current pass will stop.",
        reason
      );
    },
    onReleaseError: (error) => {
      console.error(
        "Could not release subscription lifecycle worker lease:",
        error instanceof Error ? error.name : "UnknownError"
      );
    }
  });
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
