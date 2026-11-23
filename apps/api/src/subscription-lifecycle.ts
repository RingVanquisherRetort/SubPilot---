import { retryInviteCompensation } from "./invite-compensation.js";
import { reconcileLateStarsCancellation } from "./late-stars-cancellation.js";
import { randomUUID } from "node:crypto";
import {
  acquireSubscriptionLifecycleLease,
  releaseSubscriptionLifecycleLease,
  renewSubscriptionLifecycleLease
} from "./subscription-lifecycle-lease.js";
import { Bot, InlineKeyboard } from "grammy";
import { prisma } from "@subpilot/database";
import { decryptSecret } from "@subpilot/security";
import {
  claimNextSubscriptionAccessScope,
  completeSubscriptionAccessScope,
  failSubscriptionAccessScope,
  MAX_ACCESS_DELIVERY_ATTEMPTS
} from "@subpilot/payments";
import {
  deliverSubscriptionAccess,
  recordSubscriptionAccessDeliveryFailure,
  recordSubscriptionAccessRevocationFailure
} from "./project-bot-updates.js";
import { getSubscriptionGrantTelegramChatIds } from "./subscription-grant-persistence.js";
import { buildExpiredSubscriptionNotice } from "./subscription-messages.js";
import { runLifecyclePassWithLease } from "./subscription-lifecycle-runner.js";
import { lockSubscriptionAccessScopes, requestSubscriptionAccessReconciliation } from "@subpilot/payments";
import { reconcileSubscriptionAccessRemoval } from "./subscription-access-removal.js";
import {
  deliverPendingOwnerNotifications,
  enqueueProjectOwnerNotification
} from "./owner-notifications.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_PAYMENT_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;
const WORKER_LEASE_HEARTBEAT_MS = 60_000;
type LeaseOwnershipCheck = () => boolean;
const MAX_ACCESS_SCOPE_RECONCILIATIONS_PER_PASS = 25;

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

async function recoverInviteCompensations(now: Date, ownsLease: LeaseOwnershipCheck): Promise<void> {
  await prisma.inviteCompensation.deleteMany({ where: { expiresAt: { lte: now } } });
  const rows = await prisma.inviteCompensation.findMany({ where: { nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" }, take: BATCH_SIZE });
  for (const row of rows) {
    if (!ownsLease()) return;
    const original = await prisma.projectBot.findFirst({ where: { projectId: row.projectId, telegramBotId: row.telegramBotId }, select: { id: true } });
    const bot = original ? await getProjectBot(row.projectId, original.id) : null;
    await retryInviteCompensation(row.inviteLink, row.telegramChatId, bot);
  }
}

async function recoverLateStarsCancellations(now: Date, ownsLease: LeaseOwnershipCheck): Promise<void> {
  const due = await prisma.subscription.findMany({
    where: { status: "CANCELLED", lateStarsCancelDueAt: { lte: now } },
    select: { id: true, projectId: true, lateStarsCancelBotId: true, telegramStarInitialChargeId: true },
    orderBy: { lateStarsCancelDueAt: "asc" }, take: BATCH_SIZE
  });
  for (const row of due) {
    if (!ownsLease()) return;
    if (!row.lateStarsCancelBotId || !row.telegramStarInitialChargeId) continue;
    const bot = await getProjectBot(row.projectId, row.lateStarsCancelBotId);
    await reconcileLateStarsCancellation(row.id, row.lateStarsCancelBotId, row.telegramStarInitialChargeId,
      (args) => bot ? bot.api.raw.editUserStarSubscription(args) : Promise.resolve(false));
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

/**
 * Drain dirty customer/chat scopes that still have a current active entitlement.
 * Revocations are deliberately left to the separate expiry/admin-removal path
 * until that path is migrated to the same out-of-transaction protocol.
 */
async function reconcilePendingSubscriptionAccessScopes(
  now: Date,
  isLeaseOwned: LeaseOwnershipCheck = () => true
): Promise<void> {
  for (let index = 0; index < MAX_ACCESS_SCOPE_RECONCILIATIONS_PER_PASS; index += 1) {
    if (!isLeaseOwned()) return;
    const lease = await claimNextSubscriptionAccessScope(prisma, {
      now: new Date(),
      onlyActiveEntitlements: true
    });
    if (!lease) return;

    try {
      const candidates = await prisma.subscriptionAccessGrant.findMany({
        where: {
          connectedChatId: lease.connectedChatId,
          revokedAt: null,
          subscription: {
            customerId: lease.customerId,
            status: "ACTIVE",
            AND: [
              { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
              { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }
            ]
          }
        },
        include: {
          connectedChat: { select: { telegramChatId: true } },
          subscription: {
            include: {
              customer: true,
              plan: { select: { title: true } },
              payments: {
                where: { status: "SUCCEEDED" },
                orderBy: { paidAt: "desc" },
                take: 1,
                select: { metadata: true }
              }
            }
          }
        },
        orderBy: { createdAt: "asc" }
      });

      if (!isLeaseOwned()) return;
      if (candidates.length === 0) {
        await completeSubscriptionAccessScope(prisma, lease, new Date());
        continue;
      }

      // Prefer a reusable valid invite, then a previously joined grant. This
      // avoids creating a second independent invite when subscriptions overlap
      // for the same customer and Telegram chat.
      const candidate =
        candidates.find((grant) =>
          !grant.joinedAt &&
          Boolean(grant.inviteLink) &&
          !grant.revokedAt &&
          grant.expiresAt > now
        ) ??
        candidates.find((grant) => Boolean(grant.joinedAt)) ??
        candidates[0]!;

      const metadata = candidate.subscription.payments[0]?.metadata &&
        typeof candidate.subscription.payments[0].metadata === "object" &&
        !Array.isArray(candidate.subscription.payments[0].metadata)
        ? candidate.subscription.payments[0].metadata as Record<string, unknown>
        : {};
      const sourceProjectBotId = typeof metadata.projectBotId === "string"
        ? metadata.projectBotId
        : undefined;
      const bot = await getProjectBot(candidate.subscription.projectId, sourceProjectBotId);
      if (!isLeaseOwned()) return;

      const retryAt = new Date(Date.now() + Math.min(
        60 * 60 * 1000,
        60_000 * (2 ** Math.min(Math.max(lease.attempts - 1, 0), 6))
      ));
      if (!bot) {
        await recordSubscriptionAccessDeliveryFailure(
          candidate.subscriptionId,
          lease.connectedChatId,
          "SOURCE_BOT_UNAVAILABLE",
          now
        );
        await failSubscriptionAccessScope(prisma, lease, {
          retryAt,
          errorCode: "SOURCE_BOT_UNAVAILABLE"
        });
        continue;
      }

      const access = await deliverSubscriptionAccess(
        bot,
        candidate.subscriptionId,
        [candidate.connectedChat.telegramChatId.toString()],
        isLeaseOwned,
        lease
      );
      if (!isLeaseOwned()) return;

      if (access.links.length > 0 && access.failed.length === 0 && access.blocked.length === 0) {
        const telegramUserId = Number(candidate.subscription.customer.telegramUserId);
        if (Number.isSafeInteger(telegramUserId) && telegramUserId > 0) {
          await bot.api.sendMessage(
            telegramUserId,
            "Доступ по подписке «" + candidate.subscription.plan.title +
              "» готов. Ваша персональная ссылка для вступления действует 24 часа:\n\n" +
              access.links.join("\n")
          ).catch((error: unknown) => {
            console.error(
              "Could not send a reconciled subscription invite to the buyer:",
              error instanceof Error ? error.name : "UnknownError"
            );
          });
        }
      }
    } catch (error) {
      await failSubscriptionAccessScope(prisma, lease, {
        retryAt: new Date(Date.now() + Math.min(
          60 * 60 * 1000,
          60_000 * (2 ** Math.min(Math.max(lease.attempts - 1, 0), 6))
        )),
        errorCode: "ACCESS_SCOPE_WORKER_FAILED"
      }).catch(() => false);
      console.error(
        "Subscription access scope reconciliation failed:",
        error instanceof Error ? error.name : "UnknownError"
      );
    }
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
      if (access.links.length > 0 && access.failed.length === 0 && access.blocked.length === 0) {
        await bot.api.sendMessage(
          Number(subscription.customer.telegramUserId),
          "Платёж подтверждён. Не все ссылки удалось выдать сразу, поэтому SubPilot повторил попытку. Актуальные ссылки для вступления:\n\n" +
          access.links.join("\n")
        );
      }
      if (access.blocked.length > 0) {
        await enqueueProjectOwnerNotification({
          projectId: subscription.projectId,
          dedupeKey: "subscription:" + subscription.id + ":access-permission-blocked",
          eventType: "access_permission_blocked",
          messageText:
            "⚠️ Повторная выдача приглашений остановлена: отсутствует активное отдельное право доступа по тарифу «" +
            subscription.plan.title + "» в проекте «" + subscription.project.name +
            "». Площадки: " + access.blocked.join(", ") +
            ". SubPilot не восстановил эти разрешения автоматически."
        });
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
          accessGrants: {
            some: { revokedAt: null, revocationNextAttemptAt: { lte: now } }
          }
        },
        {
          accessGrants: {
            some: {
              revocationReason: "ADMIN_EXCLUDED",
              revokedAt: { not: null },
              inviteLink: { not: "" },
              revocationNextAttemptAt: { lte: now }
            }
          }
        }
      ]
    },
    include: {
      customer: true,
      accessGrants: {
        where: {
          OR: [
            { revokedAt: null, revocationNextAttemptAt: { lte: now } },
            {
              revocationReason: "ADMIN_EXCLUDED",
              revokedAt: { not: null },
              inviteLink: { not: "" },
              revocationNextAttemptAt: { lte: now }
            }
          ]
        },
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
    const hasAdminExcludedInviteRetry = subscription.accessGrants.some((grant) =>
      grant.revocationReason === "ADMIN_EXCLUDED" &&
      grant.revokedAt !== null &&
      Boolean(grant.inviteLink)
    );

    // Claim expiry and publish the desired customer/chat revisions atomically.
    // No Telegram request, or other network work, is performed in this transaction.
    const expiryClaimed = subscription.status !== "ACTIVE" ||
      await prisma.$transaction(async (tx) => {
        const changed = await tx.subscription.updateMany({
          where: { id: subscription.id, status: "ACTIVE", endsAt: { lte: now } },
          data: { status: "EXPIRED" }
        });
        if (changed.count !== 1) return false;
        const grants = await tx.subscriptionAccessGrant.findMany({
          where: { subscriptionId: subscription.id, revokedAt: null },
          select: { connectedChatId: true }
        });
        const chatIds = grants.map((grant) => grant.connectedChatId);
        await lockSubscriptionAccessScopes(tx, subscription.customerId, chatIds);
        await requestSubscriptionAccessReconciliation(
          tx, subscription.customerId, chatIds, now
        );
        return true;
      }, { maxWait: 10_000, timeout: 15_000 });
    if (!expiryClaimed && !hasAdminExcludedInviteRetry) continue;

    const latestMetadata = subscription.payments[0]?.metadata &&
      typeof subscription.payments[0].metadata === "object" &&
      !Array.isArray(subscription.payments[0].metadata)
      ? subscription.payments[0].metadata as Record<string, unknown>
      : {};
    const originProjectBotId = typeof latestMetadata.projectBotId === "string"
      ? latestMetadata.projectBotId : undefined;
    const botKey = subscription.projectId + ":" + (originProjectBotId ?? "primary");
    let bot = bots.get(botKey);
    if (bot === undefined) {
      bot = await getProjectBot(subscription.projectId, originProjectBotId);
      bots.set(botKey, bot);
    }

    if (!bot) {
      for (const grant of subscription.accessGrants) {
        if (!isLeaseOwned()) return;
        await recordSubscriptionAccessRevocationFailure(
          subscription.id, grant.id, "SOURCE_BOT_UNAVAILABLE"
        );
      }
      const current = await prisma.subscription.findUnique({
        where: { id: subscription.id },
        select: { status: true, endsAt: true }
      });
      const stillDue = Boolean(current && (
        current.status === "CANCELLED" ||
        current.status === "EXPIRED" ||
        (current.status === "ACTIVE" && current.endsAt !== null && current.endsAt <= now)
      ));
      if (stillDue || hasAdminExcludedInviteRetry) {
        await enqueueProjectOwnerNotification({
          projectId: subscription.projectId,
          dedupeKey: "subscription:" + subscription.id + ":access-revocation-bot-unavailable",
          eventType: "access_revocation_bot_unavailable",
          messageText:
            "⚠️ Не удалось завершить отзыв доступа по тарифу «" +
            subscription.plan.title + "» в проекте «" + subscription.project.name +
            "»: исходный бот недоступен. Восстановите подключение исходного бота."
        });
      }
      continue;
    }

    const removalFailures: string[] = [];
    let accessPreservedByAnotherSubscription = false;
    let reconciliationPending = false;

    for (const grant of subscription.accessGrants) {
      if (!isLeaseOwned()) return;
      const chatLabel = grant.connectedChat.title ??
        grant.connectedChat.username ??
        grant.connectedChat.telegramChatId.toString();

      try {
        const result = await reconcileSubscriptionAccessRemoval({
          bot,
          subscriptionId: subscription.id,
          customerId: subscription.customerId,
          connectedChatId: grant.connectedChatId,
          telegramUserId: subscription.customer.telegramUserId,
          now,
          isLifecycleLeaseOwned: isLeaseOwned
        });

        if (result === "PRESERVED_BY_OTHER_SUBSCRIPTION") {
          accessPreservedByAnotherSubscription = true;
        } else if (result === "FAILED") {
          removalFailures.push(chatLabel);
        } else if (result === "LEASE_BUSY" || result === "LEASE_LOST") {
          // A live owner or newer revision must finish before we can report success.
          reconciliationPending = true;
        }
      } catch (error) {
        removalFailures.push(chatLabel);
        console.error(
          "Could not reconcile expired subscription access:",
          error instanceof Error ? error.name : "UnknownError"
        );
      }
    }

    const current = await prisma.subscription.findUnique({
      where: { id: subscription.id },
      select: { status: true, endsAt: true }
    });
    if (!current) continue;

    if (removalFailures.length > 0) {
      await enqueueProjectOwnerNotification({
        projectId: subscription.projectId,
        dedupeKey: "subscription:" + subscription.id + ":access-revocation-pending",
        eventType: "access_revocation_pending",
        messageText:
          "⚠️ SubPilot не смог завершить отзыв доступа по тарифу «" +
          subscription.plan.title + "» в проекте «" + subscription.project.name +
          "». Проблемные площадки: " + removalFailures.join(", ") +
          ". Повторные попытки запланированы; проверьте права исходного бота."
      });
    }

    const stillActive = current.status === "ACTIVE" &&
      (current.endsAt === null || current.endsAt > now);
    if (stillActive) continue;

    const isExpired = current.status === "EXPIRED" ||
      (current.status === "ACTIVE" && current.endsAt !== null && current.endsAt <= now);
    if (isExpired) {
      await enqueueProjectOwnerNotification({
        projectId: subscription.projectId,
        dedupeKey: "subscription:" + subscription.id + ":owner:expired",
        eventType: "subscription_expired",
        messageText:
          "🔔 Срок тарифа закончился\nПроект: «" + subscription.project.name +
          "»\nТариф: «" + subscription.plan.title +
          "»\nSubPilot запустил автоматическое отключение доступа."
      });
    }

    if (isExpired) {
      await bot.api.sendMessage(
        Number(subscription.customer.telegramUserId),
        buildExpiredSubscriptionNotice(subscription.project.name, removalFailures),
        { reply_markup: createRenewalKeyboard() }
      ).catch(() => undefined);
    } else if (current.status === "CANCELLED" &&
      removalFailures.length === 0 && !reconciliationPending) {
      const notice = accessPreservedByAnotherSubscription
        ? "Доступ по подписке «" + subscription.plan.title +
          "» отменён администратором. Другие действующие подписки продолжают работать."
        : "Доступ по подписке «" + subscription.plan.title +
          "» в проекте «" + subscription.project.name +
          "» досрочно отключён администратором.";
      await bot.api.sendMessage(
        Number(subscription.customer.telegramUserId), notice
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
      (isLeaseOwned) => recoverLateStarsCancellations(now, isLeaseOwned),
      (isLeaseOwned) => recoverInviteCompensations(now, isLeaseOwned),
      (isLeaseOwned) => reconcilePendingSubscriptionAccessScopes(now, isLeaseOwned),
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
