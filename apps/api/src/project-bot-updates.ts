import { randomUUID } from "node:crypto";
import { Bot, InlineKeyboard, type Context } from "grammy";
import { prisma } from "@subpilot/database";
import {
  evaluatePaymentEligibility,
  getAccessDeliveryFailureState,
  isTelegramInviteAlreadyRevoked,
  matchesTelegramStarsRefundReceipt,
  recalculateSubscriptionPeriod
} from "@subpilot/payments";
import { enqueueProjectOwnerNotification } from "./owner-notifications.js";
import { hasRequiredSubscriptionChatRights } from "./telegram-chat-access.js";
import { isPaymentFromProjectBot } from "./telegram-payment-origin.js";
import { getInvoiceDispatchState } from "./telegram-invoice-state.js";
import { getSubscriptionGrantChatIds, getSubscriptionGrantTelegramChatIds } from "./subscription-grant-persistence.js";
import { shouldQueueNewSubscriberNotification } from "./payment-event-notification.js";
import { shouldProcessTelegramUpdate } from "./telegram-update-order.js";
import { shouldActivateConnectedChat } from "./connected-chat-quota.js";
import { parseTelegramStarSubscriptionUpdate } from "./telegram-star-subscription-update.js";
import { classifyTelegramStarsPayment } from "./telegram-star-payment-kind.js";

type TelegramUpdate = Parameters<Bot["handleUpdate"]>[0];

const MAX_STARS_AMOUNT = 10_000;
const INVITE_LIFETIME_SECONDS = 24 * 60 * 60;
const PENDING_PAYMENT_TTL_MS = 24 * 60 * 60 * 1000;

async function requirePrivateBuyerChat(ctx: Context): Promise<boolean> {
  if (ctx.chat?.type === "private") return true;

  const message = "Откройте личный чат с этим ботом, чтобы просматривать тарифы и обращаться по вопросам оплаты.";
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: message, show_alert: true }).catch(() => undefined);
  } else if (ctx.chat) {
    await ctx.reply(message).catch(() => undefined);
  }
  return false;
}

function getStarAmount(amount: { toString(): string }): number | null {
  const value = amount.toString();
  if (!/^\d{1,5}$/.test(value)) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_STARS_AMOUNT
    ? parsed
    : null;
}

async function createPurchaseInvoice(
  bot: Bot,
  projectId: string,
  projectBotId: string,
  ctx: Context,
  planId: string
): Promise<void> {
  if (!ctx.chat || ctx.chat.type !== "private" || !ctx.from) {
    await ctx.reply("Покупка доступна только в личном чате с ботом проекта.");
    return;
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true }
  });
  if (!project || project.status !== "ACTIVE") {
    await ctx.reply("Этот проект временно недоступен для новых покупок.");
    return;
  }

  const plan = await prisma.creatorPlan.findFirst({
    where: { id: planId, projectId, status: "ACTIVE" },
    include: {
      chats: {
        include: { connectedChat: true }
      }
    }
  });

  if (!plan) {
    await ctx.reply("Тариф не найден или сейчас недоступен.");
    return;
  }

  const paymentEligibility = evaluatePaymentEligibility({
    provider: "TELEGRAM_STARS",
    productType: "TELEGRAM_CHANNEL_ACCESS",
    surface: "TELEGRAM_BOT",
    telegramTpaRelated: true
  });
  if (!paymentEligibility.allowed) {
    await ctx.reply("Оплата этого тарифа сейчас недоступна: " + paymentEligibility.message);
    return;
  }

  if (plan.currency !== "XTR") {
    await ctx.reply("Этот тариф пока не настроен для оплаты в Telegram Stars. Обратитесь к владельцу проекта.");
    return;
  }

  const amountStars = getStarAmount(plan.price);
  if (amountStars === null) {
    await ctx.reply("У тарифа некорректная цена в Stars. Попросите владельца проверить настройки тарифа.");
    return;
  }

  if (plan.isRecurring && plan.durationDays !== 30) {
    await ctx.reply("Для автопродления Telegram Stars сейчас поддерживается только период 30 дней. Измените длительность тарифа или отключите автопродление.");
    return;
  }

  const activeChats = plan.chats.filter((item) => item.connectedChat.isActive);
  if (activeChats.length === 0) {
    await ctx.reply("У тарифа пока нет активных каналов или групп для выдачи доступа.");
    return;
  }

  const customer = await prisma.projectCustomer.upsert({
    where: {
      projectId_telegramUserId: {
        projectId,
        telegramUserId: BigInt(ctx.from.id)
      }
    },
    update: {
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      lastName: ctx.from.last_name ?? null
    },
    create: {
      projectId,
      telegramUserId: BigInt(ctx.from.id),
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      lastName: ctx.from.last_name ?? null
    }
  });

  const pending = await prisma.$transaction(async (tx) => {
    // Serialize checkout creation for this project/customer/plan. Without a
    // transaction-scoped lock, two fast /buy updates could both observe no active
    // subscription and create separate pending entitlements.
    await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`subscription:${projectId}:${customer.id}:${plan.id}`}, 0))) AS acquired`;

    const now = new Date();
    const activeSubscription = await tx.subscription.findFirst({
      where: {
        projectId,
        customerId: customer.id,
        planId: plan.id,
        status: "ACTIVE",
        OR: [{ endsAt: null }, { endsAt: { gt: now } }]
      },
      orderBy: { endsAt: "desc" }
    });
    if (plan.isRecurring && activeSubscription?.telegramStarInitialChargeId) {
      return {
        payment: null,
        subscription: activeSubscription,
        invoiceDispatchState: "RECURRING_ACTIVE" as const
      };
    }

    const pendingSubscription = activeSubscription ? null : await tx.subscription.findFirst({
      where: { projectId, customerId: customer.id, planId: plan.id, status: "PENDING" },
      orderBy: { createdAt: "desc" }
    });
    const subscription = activeSubscription ?? pendingSubscription ?? await tx.subscription.create({
      data: {
        projectId,
        customerId: customer.id,
        planId: plan.id,
        status: "PENDING"
      }
    });

    const existingPayments = await tx.payment.findMany({
      where: {
        projectId,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        status: "PENDING",
        createdAt: { gt: new Date(now.getTime() - PENDING_PAYMENT_TTL_MS) }
      },
      orderBy: { createdAt: "desc" },
      take: 10
    });
    const reusablePayment = existingPayments.find((candidate) => {
      const metadata = candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)
        ? candidate.metadata as Record<string, unknown>
        : {};
      return metadata.projectBotId === projectBotId;
    });

    if (reusablePayment) {
      const metadata = reusablePayment.metadata && typeof reusablePayment.metadata === "object" &&
        !Array.isArray(reusablePayment.metadata)
        ? reusablePayment.metadata as Record<string, unknown>
        : {};
      return {
        payment: reusablePayment,
        subscription,
        invoiceDispatchState: getInvoiceDispatchState(metadata)
      };
    }

    const payment = await tx.payment.create({
      data: {
        projectId,
        customerId: customer.id,
        subscriptionId: subscription.id,
        provider: "TELEGRAM_STARS",
        amount: plan.price,
        currency: "XTR",
        status: "PENDING",
        idempotencyKey: randomUUID(),
        metadata: {
          source: "project_bot",
          productType: "TELEGRAM_CHANNEL_ACCESS",
          checkoutSurface: "TELEGRAM_BOT",
          projectBotId,
          planId: plan.id,
          planTitle: plan.title,
          planDescription: plan.description,
          durationDays: plan.durationDays,
          isRecurring: plan.isRecurring,
          chatIds: activeChats.map((item) => item.connectedChat.telegramChatId.toString()),
          termsVersion: "2026-11-20",
          termsAcceptedAt: now.toISOString()
        }
      }
    });

    return { payment, subscription, invoiceDispatchState: "NOT_STARTED" as const };
  });

  if (!pending.payment) {
    await ctx.reply(
      "Для этого тарифа у вас уже есть активная Stars-подписка. Управлять автопродлением можно командой /subscription. " +
      "Повторный счёт не создан."
    );
    return;
  }

  if (pending.invoiceDispatchState !== "NOT_STARTED") {
    const message = pending.invoiceDispatchState === "SENT"
      ? "У вас уже есть неоплаченный счёт по этому тарифу. Найдите предыдущее сообщение от бота с кнопкой оплаты. " +
        "Повторный счёт не создан, чтобы не допустить двойного списания. Неоплаченный счёт действует 24 часа."
      : "Запрос на выставление счёта уже выполнялся, но SubPilot не получил подтверждение о сохранении сообщения. Счёт мог быть отправлен. " +
        "Повторный счёт не создан во избежание двойного списания. Проверьте сообщения от бота или обратитесь в /paysupport.";
    await ctx.reply(message);
    return;
  }

  const invoiceMetadata = pending.payment.metadata &&
    typeof pending.payment.metadata === "object" &&
    !Array.isArray(pending.payment.metadata)
    ? pending.payment.metadata as Record<string, unknown>
    : {};
  const invoiceTitle = typeof invoiceMetadata.planTitle === "string"
    ? invoiceMetadata.planTitle
    : plan.title;
  const invoiceDescription = typeof invoiceMetadata.planDescription === "string"
    ? invoiceMetadata.planDescription
    : `Доступ к подписке «${invoiceTitle}»`;
  const invoiceAmountStars = getStarAmount(pending.payment.amount);
  if (invoiceAmountStars === null) {
    await ctx.reply("Не удалось проверить сумму ранее созданного счёта. Обратитесь к владельцу проекта.");
    return;
  }

  const dispatchStartedAt = new Date().toISOString();
  const dispatchClaim = await prisma.$transaction(async (tx) => {
    // Serialize the external invoice side effect as well as payment creation. Two
    // concurrent /buy updates must not both pass a stale "not dispatched" read.
    await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`subscription:${projectId}:${customer.id}:${plan.id}`}, 0))) AS acquired`;
    const currentPayment = await tx.payment.findUnique({ where: { id: pending.payment.id } });
    if (!currentPayment || currentPayment.status !== "PENDING") {
      return { claimed: false, reason: "STATUS_CHANGED" as const };
    }
    const currentMetadata = currentPayment.metadata && typeof currentPayment.metadata === "object" && !Array.isArray(currentPayment.metadata)
      ? currentPayment.metadata as Record<string, unknown>
      : {};
    const currentDispatchState = getInvoiceDispatchState(currentMetadata);
    if (currentDispatchState !== "NOT_STARTED") {
      return { claimed: false, reason: currentDispatchState };
    }
    const updated = await tx.payment.updateMany({
      where: { id: pending.payment.id, status: "PENDING" },
      data: { metadata: { ...currentMetadata, invoiceDispatchStartedAt: dispatchStartedAt } }
    });
    return { claimed: updated.count === 1, reason: updated.count === 1 ? "CLAIMED" as const : "STATUS_CHANGED" as const };
  });
  if (!dispatchClaim.claimed) {
    if (dispatchClaim.reason === "SENT") {
      await ctx.reply("У вас уже есть неоплаченный счёт по этому тарифу. Найдите предыдущее сообщение от бота. Повторный счёт не создан; срок действия — 24 часа.");
    } else if (dispatchClaim.reason === "AMBIGUOUS") {
      await ctx.reply("Запрос на выставление счёта уже выполнялся, но подтверждение не сохранено. Счёт мог быть отправлен. Проверьте сообщения от бота или обратитесь в /paysupport; второй счёт не создан.");
    } else {
      await ctx.reply("Статус счёта уже изменился. Не создавайте новую покупку; проверьте поддержку по оплате через /paysupport.");
    }
    return;
  }

  let invoiceMessageId: number;
  try {
    if (plan.isRecurring) {
      const invoiceLink = await bot.api.createInvoiceLink(
        invoiceTitle.slice(0, 32),
        invoiceDescription.slice(0, 255),
        pending.payment.id,
        "",
        "XTR",
        [{ label: invoiceTitle.slice(0, 32), amount: invoiceAmountStars }],
        { subscription_period: 2_592_000 }
      );
      const sent = await ctx.api.sendMessage(
        ctx.chat.id,
        "Ежемесячная подписка «" + invoiceTitle + "». Telegram будет автоматически списывать " +
          invoiceAmountStars + " ⭐ каждые 30 дней, пока автопродление не будет отменено.",
        { reply_markup: new InlineKeyboard().url("Оплатить и включить автопродление", invoiceLink) }
      );
      invoiceMessageId = sent.message_id;
    } else {
      const sent = await ctx.api.sendInvoice(
        ctx.chat.id,
        invoiceTitle.slice(0, 32),
        invoiceDescription.slice(0, 255),
        pending.payment.id,
        "XTR",
        [{ label: invoiceTitle.slice(0, 32), amount: invoiceAmountStars }]
      );
      invoiceMessageId = sent.message_id;
    }
  } catch (error) {
    // Telegram may have received the request even when the client did not receive a definitive response.
    // Keep the payment pending and suppress retries until its normal 24-hour expiry rather than risk two invoices.
    console.error(
      "Project bot invoice dispatch has an ambiguous result:",
      error instanceof Error ? error.name : "UnknownError"
    );
    await ctx.reply(
      "Telegram не дал однозначного ответа по выставлению счёта. Он мог быть отправлен, поэтому повторный счёт не создан. " +
      "Проверьте предыдущие сообщения от бота. Если счёта нет, обратитесь в поддержку через /paysupport; " +
      "не начинайте новую покупку до проверки."
    );
    return;
  }

  try {
    const recorded = await prisma.payment.updateMany({
      where: { id: pending.payment.id, status: "PENDING" },
      data: {
        metadata: {
          ...invoiceMetadata,
          invoiceDispatchStartedAt: dispatchStartedAt,
          invoiceMessageId,
          invoiceSentAt: new Date().toISOString()
        }
      }
    });
    if (recorded.count !== 1) {
      await ctx.reply(
        "Счёт отправлен, но его статус изменился до сохранения. Не запрашивайте новый счёт; " +
        "проверьте сообщение с оплатой или обратитесь в /paysupport."
      );
    }
  } catch (error) {
    console.error(
      "Telegram invoice was sent but its message reference could not be persisted:",
      error instanceof Error ? error.name : "UnknownError"
    );
    await ctx.reply(
      "Счёт отправлен, но SubPilot не смог сохранить его ссылку в журнале. Не запрашивайте новый счёт. " +
      "Используйте уже отправленное сообщение для оплаты или обратитесь в /paysupport."
    );
  }
}

async function validatePreCheckout(
  query: {
    invoice_payload: string;
    from: { id: number };
    currency: string;
    total_amount: number;
  },
  projectId: string,
  projectBotId: string
): Promise<boolean> {
  const payment = await prisma.payment.findUnique({
    where: { id: query.invoice_payload },
    include: {
      customer: true,
      project: { select: { status: true } }
    }
  });

  return Boolean(
    payment &&
    isPaymentFromProjectBot(payment.metadata, projectBotId) &&
    payment.projectId === projectId &&
    payment.project.status === "ACTIVE" &&
    payment.provider === "TELEGRAM_STARS" &&
    payment.currency === "XTR" &&
    payment.status === "PENDING" &&
    payment.customer.telegramUserId === BigInt(query.from.id) &&
    query.currency === "XTR" &&
    Number(payment.amount.toString()) === query.total_amount
  );
}

const ACCESS_DELIVERY_ERROR_CODES = new Set([
  "CONNECTED_CHAT_INACTIVE",
  "INVITE_REVOKE_FAILED",
  "SUBSCRIBER_UNBAN_FAILED",
  "INVITE_CREATION_FAILED",
  "SOURCE_BOT_UNAVAILABLE"
]);

export async function recordSubscriptionAccessDeliveryFailure(
  subscriptionId: string,
  connectedChatId: string,
  errorCode: string,
  now = new Date()
): Promise<void> {
  const safeErrorCode = ACCESS_DELIVERY_ERROR_CODES.has(errorCode)
    ? errorCode
    : "INVITE_CREATION_FAILED";
  const state = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "SubscriptionAccessGrant" WHERE "subscriptionId" = $1 AND "connectedChatId" = $2 FOR UPDATE',
      subscriptionId,
      connectedChatId
    );
    const key = { subscriptionId_connectedChatId: { subscriptionId, connectedChatId } };
    const current = await tx.subscriptionAccessGrant.findUnique({
      where: key,
      select: { deliveryAttempts: true }
    });
    const next = getAccessDeliveryFailureState(
      current?.deliveryAttempts ?? 0,
      now,
      safeErrorCode
    );
    await tx.subscriptionAccessGrant.upsert({
      where: key,
      create: {
        subscriptionId,
        connectedChatId,
        inviteLink: "",
        expiresAt: new Date(0),
        deliveryAttempts: next.attempts,
        deliveryNextAttemptAt: next.nextAttemptAt,
        deliveryLastError: next.lastError,
        deliveryFailedAt: next.failedAt
      },
      update: {
        deliveryAttempts: next.attempts,
        deliveryNextAttemptAt: next.nextAttemptAt,
        deliveryLastError: next.lastError,
        deliveryFailedAt: next.failedAt
      }
    });
    return next;
  });

  if (state.failedAt) {
    try {
      const [subscription, chat] = await Promise.all([
        prisma.subscription.findUnique({
          where: { id: subscriptionId },
          select: {
            projectId: true,
            project: { select: { name: true } },
            plan: { select: { title: true } }
          }
        }),
        prisma.connectedChat.findUnique({
          where: { id: connectedChatId },
          select: { title: true, username: true, telegramChatId: true }
        })
      ]);
      if (subscription && chat) {
        const chatName = chat.title ?? chat.username ?? chat.telegramChatId.toString();
        await enqueueProjectOwnerNotification({
          projectId: subscription.projectId,
          dedupeKey: `subscription:${subscriptionId}:access-delivery-dead-letter:${connectedChatId}:${state.failedAt.getTime()}`,
          eventType: "access_delivery_dead_letter",
          messageText:
            "🚨 SubPilot остановил автоматическую выдачу доступа после 10 неудачных попыток.\n" +
            `Проект: «${subscription.project.name}»\nТариф: «${subscription.plan.title}»\n` +
            `Площадка: ${chatName}\nКод ошибки: ${state.lastError}\n` +
            "Исправьте права исходного бота или подключение площадки, затем выполните /faileddeliveries и /retrydelivery ID в центральном боте."
        });
      }
    } catch (error) {
      console.error(
        "Could not notify workspace owner about access delivery dead letter:",
        error instanceof Error ? error.name : "UnknownError"
      );
    }
  }
}

async function clearSubscriptionAccessDeliveryFailure(
  subscriptionId: string,
  connectedChatId: string
): Promise<void> {
  await prisma.subscriptionAccessGrant.updateMany({
    where: { subscriptionId, connectedChatId, revokedAt: null },
    data: {
      deliveryAttempts: 0,
      deliveryNextAttemptAt: new Date(),
      deliveryLastError: null,
      deliveryFailedAt: null
    }
  });
}

export async function deliverSubscriptionAccess(
  bot: Bot,
  subscriptionId: string,
  chatIds?: string[],
  isLeaseOwned: () => boolean = () => true
): Promise<{ links: string[]; alreadyJoined: string[]; failed: string[] }> {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      customer: true,
      plan: {
        include: {
          chats: {
            include: { connectedChat: true }
          }
        }
      }
    }
  });

  if (!subscription || subscription.status !== "ACTIVE") {
    return { links: [], alreadyJoined: [], failed: [] };
  }

  const results = {
    links: [] as string[],
    alreadyJoined: [] as string[],
    failed: [] as string[]
  };
  const targetChats = chatIds
    ? await prisma.connectedChat.findMany({
        where: {
          projectId: subscription.projectId,
          telegramChatId: {
            in: chatIds.filter((id) => /^-?\d+$/.test(id)).map((id) => BigInt(id))
          }
        }
      })
    : subscription.plan.chats.map((item) => item.connectedChat);

  for (const chat of targetChats) {
    if (!isLeaseOwned()) return results;
    const label = chat.title ?? chat.username ?? chat.telegramChatId.toString();
    if (!chat.isActive) {
      await recordSubscriptionAccessDeliveryFailure(subscription.id, chat.id, "CONNECTED_CHAT_INACTIVE");
      results.failed.push(label);
      continue;
    }
    const existing = await prisma.subscriptionAccessGrant.findUnique({
      where: {
        subscriptionId_connectedChatId: {
          subscriptionId: subscription.id,
          connectedChatId: chat.id
        }
      }
    });

    const telegramUserId = Number(subscription.customer.telegramUserId);
    let isAlreadyMember = false;
    let isBanned = false;

    try {
      const member = await bot.api.getChatMember(chat.telegramChatId.toString(), telegramUserId);
      isAlreadyMember =
        member.status === "creator" ||
        member.status === "administrator" ||
        member.status === "member" ||
        (member.status === "restricted" && member.is_member);
      isBanned = member.status === "kicked";
    } catch {
      // A buyer who is not in this chat may produce a Telegram API error here.
      // Invite creation below remains the authoritative check for the bot's invite permissions.
    }
    if (!isLeaseOwned()) return results;

    if (isAlreadyMember) {
      const now = new Date();
      if (existing?.inviteLink && !existing.revokedAt && existing.expiresAt > now) {
        if (!isLeaseOwned()) return results;
        try {
          await bot.api.revokeChatInviteLink(chat.telegramChatId.toString(), existing.inviteLink);
          if (!isLeaseOwned()) return results;
        } catch (error) {
          if (!isTelegramInviteAlreadyRevoked(error)) {
            if (!isLeaseOwned()) return results;
            await recordSubscriptionAccessDeliveryFailure(subscription.id, chat.id, "INVITE_REVOKE_FAILED");
            console.error(
              "Could not revoke an unused invite link for an existing member:",
              error instanceof Error ? error.name : "UnknownError"
            );
            results.failed.push(label);
            continue;
          }
        }
      }

      if (!isLeaseOwned()) return results;
      await prisma.subscriptionAccessGrant.upsert({
        where: {
          subscriptionId_connectedChatId: {
            subscriptionId: subscription.id,
            connectedChatId: chat.id
          }
        },
        create: {
          subscriptionId: subscription.id,
          connectedChatId: chat.id,
          inviteLink: "",
          expiresAt: new Date(0),
          joinedAt: now
        },
        update: {
          inviteLink: "",
          expiresAt: new Date(0),
          joinedAt: now,
          revokedAt: null,
          deliveryAttempts: 0,
          deliveryNextAttemptAt: now,
          deliveryLastError: null,
          deliveryFailedAt: null
        }
      });
      results.alreadyJoined.push(label);
      continue;
    }

    const previousJoinWasCleared = Boolean(existing?.joinedAt && !isAlreadyMember);
    const now = new Date();
    if (!previousJoinWasCleared && existing && !existing.revokedAt && existing.inviteLink &&
        existing.expiresAt > now) {
      if (isBanned) {
        if (!isLeaseOwned()) return results;
        try {
          await bot.api.unbanChatMember(
            chat.telegramChatId.toString(),
            telegramUserId,
            { only_if_banned: true }
          );
          if (!isLeaseOwned()) return results;
        } catch (error) {
          if (!isLeaseOwned()) return results;
          await recordSubscriptionAccessDeliveryFailure(subscription.id, chat.id, "SUBSCRIBER_UNBAN_FAILED");
          console.error(
            "Could not unban an active subscriber before reusing an invite:",
            error instanceof Error ? error.name : "UnknownError"
          );
          results.failed.push(label);
          continue;
        }
      }
      await clearSubscriptionAccessDeliveryFailure(subscription.id, chat.id);
      results.links.push(label + ": " + existing.inviteLink);
      continue;
    }

    const needsUnban = Boolean(existing?.revokedAt || isBanned);
    try {
      // Revoke the previous link before clearing it from the database. If Telegram
      // rejects the revoke, retain the old link so the next worker pass can retry safely.
      if (existing?.inviteLink && !existing.revokedAt && existing.expiresAt > now) {
        if (!isLeaseOwned()) return results;
        try {
          await bot.api.revokeChatInviteLink(chat.telegramChatId.toString(), existing.inviteLink);
        } catch (error) {
          if (!isTelegramInviteAlreadyRevoked(error)) throw error;
        }
        if (!isLeaseOwned()) return results;
      }

      if (previousJoinWasCleared && existing) {
        if (!isLeaseOwned()) return results;
        await prisma.subscriptionAccessGrant.updateMany({
          where: { id: existing.id, revokedAt: null },
          data: { joinedAt: null, inviteLink: "", expiresAt: new Date(0) }
        });
      }

      // Persist a pending delivery row before creating the replacement invite.
      if (!isLeaseOwned()) return results;
      await prisma.subscriptionAccessGrant.upsert({
        where: {
          subscriptionId_connectedChatId: {
            subscriptionId: subscription.id,
            connectedChatId: chat.id
          }
        },
        create: {
          subscriptionId: subscription.id,
          connectedChatId: chat.id,
          inviteLink: "",
          expiresAt: new Date(0)
        },
        update: {
          inviteLink: "",
          expiresAt: new Date(0),
          joinedAt: null,
          revokedAt: null
        }
      });

      if (needsUnban) {
        if (!isLeaseOwned()) return results;
        await bot.api.unbanChatMember(
          chat.telegramChatId.toString(),
          telegramUserId,
          { only_if_banned: true }
        );
        if (!isLeaseOwned()) return results;
      }

      if (!isLeaseOwned()) return results;
      const expiresAt = new Date(Date.now() + INVITE_LIFETIME_SECONDS * 1000);
      const invite = await bot.api.createChatInviteLink(
        chat.telegramChatId.toString(),
        {
          name: "SubPilot " + subscription.id.slice(-12),
          expire_date: Math.floor(expiresAt.getTime() / 1000),
          member_limit: 1
        }
      );

      if (!isLeaseOwned()) {
        await bot.api.revokeChatInviteLink(chat.telegramChatId.toString(), invite.invite_link).catch(() => undefined);
        return results;
      }
      await prisma.subscriptionAccessGrant.upsert({
        where: {
          subscriptionId_connectedChatId: {
            subscriptionId: subscription.id,
            connectedChatId: chat.id
          }
        },
        create: {
          subscriptionId: subscription.id,
          connectedChatId: chat.id,
          inviteLink: invite.invite_link,
          expiresAt
        },
        update: {
          inviteLink: invite.invite_link,
          expiresAt,
          joinedAt: null,
          revokedAt: null,
          deliveryAttempts: 0,
          deliveryNextAttemptAt: new Date(),
          deliveryLastError: null,
          deliveryFailedAt: null
        }
      });

      results.links.push(label + ": " + invite.invite_link);
    } catch (error) {
      if (isLeaseOwned()) {
        await recordSubscriptionAccessDeliveryFailure(
          subscription.id,
          chat.id,
          "INVITE_CREATION_FAILED"
        ).catch((recordError: unknown) => {
          console.error(
            "Could not persist subscription access delivery failure:",
            recordError instanceof Error ? recordError.name : "UnknownError"
          );
        });
      }
      console.error(
        "Could not create subscription invite:",
        error instanceof Error ? error.name : "UnknownError"
      );
      results.failed.push(label);
    }
  }

  return results;
}

async function processSuccessfulStarsPayment(
  bot: Bot,
  projectId: string,
  projectBotId: string,
  ctx: Context
): Promise<void> {
  const message = ctx.message;
  if (!message || !("successful_payment" in message)) return;

  const receipt = message.successful_payment;
  const payment = await prisma.payment.findUnique({
    where: { id: receipt.invoice_payload },
    include: {
      customer: true,
      subscription: {
        include: { plan: true }
      },
      project: { select: { name: true } }
    }
  });

  if (
    !payment ||
    typeof receipt.telegram_payment_charge_id !== "string" ||
    receipt.telegram_payment_charge_id.length === 0 ||
    !isPaymentFromProjectBot(payment.metadata, projectBotId) ||
    !payment.subscription ||
    payment.projectId !== projectId ||
    payment.provider !== "TELEGRAM_STARS" ||
    payment.currency !== "XTR" ||
    payment.customer.telegramUserId !== BigInt(ctx.from?.id ?? 0) ||
    receipt.currency !== "XTR" ||
    Number(payment.amount.toString()) !== receipt.total_amount
  ) {
    console.error("Telegram Stars receipt did not match a pending SubPilot payment.");
    await ctx.reply("Платёж получен, но заказ не удалось автоматически сопоставить. Обратитесь к владельцу проекта и сохраните квитанцию Telegram.");
    return;
  }

  const subscription = payment.subscription;
  const now = new Date();
  const metadata = payment.metadata && typeof payment.metadata === "object" && !Array.isArray(payment.metadata)
    ? payment.metadata as Record<string, unknown>
    : {};
  const snapshotDurationDays = Object.prototype.hasOwnProperty.call(metadata, "durationDays")
    ? (typeof metadata.durationDays === "number" &&
       Number.isInteger(metadata.durationDays) && metadata.durationDays > 0
        ? metadata.durationDays
        : null)
    : subscription.plan.durationDays;
  const snapshotPlanTitle = typeof metadata.planTitle === "string"
    ? metadata.planTitle
    : subscription.plan.title;
  const snapshotChatIds = Array.isArray(metadata.chatIds)
    ? metadata.chatIds.filter((value): value is string => typeof value === "string")
    : undefined;
  const expirationTimestamp = receipt.subscription_expiration_date;
  const expirationFromTelegram =
    typeof expirationTimestamp === "number" &&
    Number.isSafeInteger(expirationTimestamp) &&
    expirationTimestamp > 0
      ? new Date(expirationTimestamp * 1000)
      : null;
  if (
    expirationTimestamp !== undefined &&
    (!expirationFromTelegram || !Number.isFinite(expirationFromTelegram.getTime()))
  ) {
    await ctx.reply(
      "Telegram прислал некорректную дату окончания подписки. Доступ автоматически не изменён. " +
      "Сохраните квитанцию и обратитесь в /paysupport."
    );
    return;
  }

  const recurringReceipt = receipt as typeof receipt & {
    is_recurring?: true;
    is_first_recurring?: true;
  };
  const transactionResult = await prisma.$transaction(async (tx) => {
    // Serialize all successful charges for one entitlement. Telegram may retry
    // updates, and multiple monthly renewals must extend from the latest period.
    await tx.$queryRawUnsafe('SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE', subscription.id);
    const currentSubscription = await tx.subscription.findUnique({
      where: { id: subscription.id }
    });
    if (!currentSubscription) {
      throw new Error("Subscription disappeared while processing a successful payment.");
    }

    const currentAnchorPayment = await tx.payment.findUnique({
      where: { id: payment.id },
      select: { status: true }
    });
    if (!currentAnchorPayment) {
      throw new Error("The original Telegram Stars payment disappeared during processing.");
    }

    const eventKey = "telegram-stars:" + receipt.telegram_payment_charge_id;
    const alreadyRecorded = await tx.paymentWebhookEvent.findUnique({
      where: { dedupeKey: eventKey },
      select: { id: true }
    });
    if (alreadyRecorded) {
      return {
        endsAt: currentSubscription.endsAt,
        isInitialActivation: false,
        isRenewal: false,
        paymentRejected: false,
        paymentWasProcessed: false
      };
    }

    const paymentKind = classifyTelegramStarsPayment({
      planIsRecurring: metadata.isRecurring === true,
      paymentStatus: currentAnchorPayment.status,
      initialChargeId: currentSubscription.telegramStarInitialChargeId,
      isRecurring: recurringReceipt.is_recurring,
      isFirstRecurring: recurringReceipt.is_first_recurring
    });
    if (!paymentKind) {
      return {
        endsAt: currentSubscription.endsAt,
        isInitialActivation: false,
        isRenewal: false,
        paymentRejected: true,
        paymentWasProcessed: false
      };
    }

    const currentEnd = currentSubscription.endsAt && currentSubscription.endsAt > now
      ? currentSubscription.endsAt
      : now;
    const isRecurringPayment = paymentKind !== "ONE_TIME";
    const endsAt = (isRecurringPayment ? expirationFromTelegram : null) ??
      (snapshotDurationDays
        ? new Date(currentEnd.getTime() + snapshotDurationDays * 24 * 60 * 60 * 1000)
        : null);
    const isInitialActivation = paymentKind === "RECURRING_RENEWAL"
      ? false
      : currentSubscription.status !== "ACTIVE";
    let paymentRecordId = payment.id;

    if (paymentKind === "RECURRING_RENEWAL") {
      // Keep the checkout payment as the immutable invoice-payload anchor.
      // Each later Telegram charge receives its own ledger row so refunds,
      // revenue reports and idempotency remain period-specific.
      const renewalPayment = await tx.payment.create({
        data: {
          projectId: payment.projectId,
          customerId: payment.customerId,
          subscriptionId: subscription.id,
          provider: "TELEGRAM_STARS",
          providerPaymentId: receipt.telegram_payment_charge_id,
          idempotencyKey: "telegram-stars-renewal:" + receipt.telegram_payment_charge_id,
          amount: payment.amount,
          currency: "XTR",
          status: "SUCCEEDED",
          paidAt: now,
          metadata: {
            ...metadata,
            isRecurring: true,
            isRenewal: true,
            originalPaymentId: payment.id,
            telegramPaymentChargeId: receipt.telegram_payment_charge_id,
            subscriptionExpirationDate: receipt.subscription_expiration_date ?? null
          }
        },
        select: { id: true }
      });
      paymentRecordId = renewalPayment.id;
    } else {
      const updated = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: { in: ["PENDING", "CANCELLED"] },
          provider: "TELEGRAM_STARS",
          providerPaymentId: null
        },
        data: {
          status: "SUCCEEDED",
          providerPaymentId: receipt.telegram_payment_charge_id,
          paidAt: now
        }
      });

      if (updated.count !== 1) {
        return {
          endsAt: currentSubscription.endsAt,
          isInitialActivation: false,
          isRenewal: false,
          paymentRejected: false,
          paymentWasProcessed: false
        };
      }
    }

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "ACTIVE",
        startsAt: currentSubscription.startsAt ?? now,
        endsAt,
        reminder3dAt: null,
        reminder1dAt: null,
        ...(paymentKind === "INITIAL_RECURRING"
          ? {
              telegramStarInitialChargeId: receipt.telegram_payment_charge_id,
              telegramStarSubscriptionState: "ACTIVE"
            }
          : {})
      }
    });

    await tx.paymentWebhookEvent.create({
      data: {
        connectionId: null,
        dedupeKey: eventKey,
        providerEventId: receipt.telegram_payment_charge_id,
        eventType: "telegram.stars.payment.succeeded",
        payload: {
          paymentId: paymentRecordId,
          originalPaymentId: payment.id,
          invoicePayload: receipt.invoice_payload,
          currency: receipt.currency,
          totalAmount: receipt.total_amount,
          telegramPaymentChargeId: receipt.telegram_payment_charge_id,
          providerPaymentChargeId: receipt.provider_payment_charge_id,
          isInitialActivation,
          isRecurring: isRecurringPayment,
          isRenewal: paymentKind === "RECURRING_RENEWAL"
        },
        processedAt: now
      }
    });

    // Persist pending access-delivery rows in the same transaction as payment
    // confirmation. The lifecycle worker can recover after a process interruption.
    let connectedChatIds: string[] = [];
    if (snapshotChatIds !== undefined) {
      const telegramChatIds = snapshotChatIds
        .filter((value) => /^-?\d+$/.test(value))
        .map((value) => BigInt(value));
      if (telegramChatIds.length > 0) {
        const chats = await tx.connectedChat.findMany({
          where: {
            projectId,
            telegramChatId: { in: telegramChatIds }
          },
          select: { id: true, isActive: true }
        });
        connectedChatIds = getSubscriptionGrantChatIds(chats);
      }
    } else {
      const planChats = await tx.creatorPlanChat.findMany({
        where: { creatorPlanId: currentSubscription.planId },
        select: {
          connectedChatId: true,
          connectedChat: { select: { isActive: true } }
        }
      });
      connectedChatIds = getSubscriptionGrantChatIds(
        planChats.map((chat) => ({ id: chat.connectedChatId, isActive: chat.connectedChat.isActive }))
      );
    }

    if (connectedChatIds.length > 0) {
      await tx.subscriptionAccessGrant.createMany({
        data: connectedChatIds.map((connectedChatId) => ({
          subscriptionId: subscription.id,
          connectedChatId,
          inviteLink: "",
          expiresAt: new Date(0)
        })),
        skipDuplicates: true
      });
    }

    return {
      endsAt,
      isInitialActivation,
      isRenewal: paymentKind === "RECURRING_RENEWAL",
      paymentRejected: false,
      paymentWasProcessed: true
    };
  });
  const { endsAt, isInitialActivation, isRenewal, paymentRejected, paymentWasProcessed } = transactionResult;

  if (paymentRejected) {
    await ctx.reply(
      "Telegram прислал квитанцию с несовпадающими признаками рекуррентного платежа. " +
      "Доступ автоматически не менялся. Сохраните квитанцию и обратитесь в /paysupport."
    );
    return;
  }

  const queueNewSubscriberNotification = async (accessEndsAt: Date | null): Promise<void> => {
    const buyerName = [payment.customer.firstName, payment.customer.lastName]
      .filter(Boolean)
      .join(" ") || (payment.customer.username ? "@" + payment.customer.username : "Покупатель Telegram");
    const amountLabel = payment.currency === "XTR"
      ? payment.amount.toString() + " ⭐"
      : payment.amount.toString() + " " + payment.currency;

    await enqueueProjectOwnerNotification({
      projectId,
      dedupeKey: "payment:" + payment.id + ":new-subscriber",
      eventType: "new_subscriber",
      messageText:
        "🎉 Новый подписчик\nПроект: «" + payment.project.name + "»\n" +
        "Подписчик: " + buyerName + "\nТариф: «" + snapshotPlanTitle + "»\n" +
        "Оплата: " + amountLabel + "\n" +
        (accessEndsAt ? "Доступ до: " + accessEndsAt.toLocaleString("ru-RU") : "Срок действия: без ограничения")
    });
  };

  if (!paymentWasProcessed) {
    // The payment/entitlement transaction commits before the notification queue is written.
    // On a webhook retry, recover a missed first-activation alert from the transactionally
    // persisted event payload. The notification dedupe key makes this safe after partial success.
    const successfulEvent = await prisma.paymentWebhookEvent.findUnique({
      where: { dedupeKey: "telegram-stars:" + receipt.telegram_payment_charge_id },
      select: { payload: true }
    });
    const currentPayment = await prisma.payment.findUnique({
      where: { id: payment.id },
      select: { status: true }
    });
    if (shouldQueueNewSubscriberNotification(successfulEvent?.payload, currentPayment?.status ?? "UNKNOWN")) {
      await queueNewSubscriberNotification(endsAt);
    }

    await ctx.reply("Этот платёж уже был обработан. Для получения актуальных ссылок используйте /access.");
    return;
  }

  const latestPayment = await prisma.payment.findUnique({
    where: { id: payment.id },
    select: { status: true }
  });

  if (latestPayment?.status !== "SUCCEEDED") {
    await ctx.reply("Оплата пока не подтверждена в системе. Квитанцию Telegram сохраните и обратитесь к владельцу проекта.");
    return;
  }



  if (isInitialActivation) {
    await queueNewSubscriberNotification(endsAt);
  } else if (isRenewal) {
    const buyerName = [payment.customer.firstName, payment.customer.lastName]
      .filter(Boolean)
      .join(" ") || (payment.customer.username ? "@" + payment.customer.username : "Покупатель Telegram");
    await enqueueProjectOwnerNotification({
      projectId,
      dedupeKey: "payment:renewal:" + receipt.telegram_payment_charge_id,
      eventType: "subscription_renewal",
      messageText:
        "🔁 Автопродление подписки подтверждено\nПроект: «" + payment.project.name + "»\n" +
        "Подписчик: " + buyerName + "\nТариф: «" + snapshotPlanTitle + "»\n" +
        "Оплата: " + payment.amount.toString() + " ⭐\n" +
        (endsAt ? "Доступ действует до: " + endsAt.toLocaleString("ru-RU") : "Срок действия: без ограничения")
    });
  }

  const access = await deliverSubscriptionAccess(bot, subscription.id, snapshotChatIds);
  const messageParts = [
    "Оплата в Telegram Stars подтверждена. Подписка активна."
  ];

  if (endsAt) {
    messageParts.push(`Доступ действует до: ${endsAt.toLocaleString("ru-RU")}.`);
  } else {
    messageParts.push("Срок действия: без ограничения.");
  }

  if (access.links.length > 0) {
    messageParts.push("Ваши ссылки для вступления (каждая действует 24 часа и рассчитана на одного участника):");
    messageParts.push(...access.links);
  }

  if (access.alreadyJoined.length > 0) {
    messageParts.push(`Вы уже состоите в: ${access.alreadyJoined.join(", ")}.`);
  }

  if (access.failed.length > 0) {
    messageParts.push(
      `Не удалось сразу создать ссылки для: ${access.failed.join(", ")}. Платёж подтверждён; SubPilot повторит выдачу автоматически. Также можно запросить ссылки командой /access.`
    );
    await enqueueProjectOwnerNotification({
      projectId,
      dedupeKey: "subscription:" + subscription.id + ":access-delivery-pending",
      eventType: "access_delivery_pending",
      messageText:
        "⚠️ Не удалось автоматически выдать доступ по тарифу «" + snapshotPlanTitle +
        "». SubPilot повторит попытку. Проверьте права бота и состояние подключённых площадок: " +
        access.failed.join(", ")
    });
  }

  await ctx.reply(messageParts.join("\n\n"));
}

async function processRefundedStarsPayment(
  projectBotId: string,
  ctx: Context
): Promise<void> {
  const message = ctx.message;
  const chat = ctx.chat;
  if (!message || !("refunded_payment" in message)) return;
  if (!chat || chat.type !== "private") {
    console.error("Telegram sent a Stars refund update outside a private buyer chat.");
    return;
  }

  const receipt = message.refunded_payment;
  const anchorPayment = await prisma.payment.findUnique({
    where: { id: receipt.invoice_payload },
    include: { customer: true }
  });
  if (!anchorPayment) {
    console.error("Telegram Stars refund update did not match a SubPilot invoice anchor.");
    return;
  }

  const anchorMetadata = anchorPayment.metadata && typeof anchorPayment.metadata === "object" &&
    !Array.isArray(anchorPayment.metadata)
    ? anchorPayment.metadata as Record<string, unknown>
    : {};
  let payment = anchorPayment;
  if (anchorPayment.providerPaymentId !== receipt.telegram_payment_charge_id) {
    if (anchorMetadata.isRecurring !== true || !anchorPayment.subscriptionId) {
      console.error("Telegram Stars refund charge did not match the original payment.");
      return;
    }
    const renewalPayment = await prisma.payment.findFirst({
      where: {
        projectId: anchorPayment.projectId,
        customerId: anchorPayment.customerId,
        subscriptionId: anchorPayment.subscriptionId,
        provider: "TELEGRAM_STARS",
        providerPaymentId: receipt.telegram_payment_charge_id
      },
      include: { customer: true }
    });
    if (!renewalPayment) {
      console.error("Telegram Stars refund update did not match a recorded renewal charge.");
      return;
    }
    payment = renewalPayment;
  }

  const metadata = payment.metadata && typeof payment.metadata === "object" && !Array.isArray(payment.metadata)
    ? payment.metadata as Record<string, unknown>
    : {};
  const originProjectBotId = typeof metadata.projectBotId === "string" ? metadata.projectBotId : null;
  const matches = matchesTelegramStarsRefundReceipt({
    id: payment.id,
    originalPaymentId: typeof metadata.originalPaymentId === "string" ? metadata.originalPaymentId : null,
    provider: payment.provider,
    currency: payment.currency,
    amount: payment.amount.toString(),
    providerPaymentId: payment.providerPaymentId,
    customerTelegramUserId: payment.customer.telegramUserId.toString(),
    originProjectBotId
  }, receipt, chat.id, projectBotId);

  if (!matches) {
    console.error("Telegram Stars refund update failed payment, buyer, bot, amount or charge validation.");
    return;
  }
  if (payment.status !== "SUCCEEDED" && payment.status !== "REFUNDING" && payment.status !== "REFUNDED") {
    console.error("Telegram Stars refund update matched a payment in an unexpected state:", payment.status);
    return;
  }

  const refundedAt = new Date();
  await prisma.$transaction(async (tx) => {
    if (payment.subscriptionId) {
      await tx.$queryRawUnsafe('SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE', payment.subscriptionId);
    }

    const updated = await tx.payment.updateMany({
      where: {
        id: payment.id,
        provider: "TELEGRAM_STARS",
        providerPaymentId: receipt.telegram_payment_charge_id,
        status: { in: ["SUCCEEDED", "REFUNDING"] }
      },
      data: { status: "REFUNDED", refundedAt, refundLastError: null }
    });

    const refundEventKey = "telegram-stars-refund:" + receipt.telegram_payment_charge_id;
    await tx.paymentWebhookEvent.upsert({
      where: { dedupeKey: refundEventKey },
      create: {
        connectionId: null,
        dedupeKey: refundEventKey,
        providerEventId: receipt.telegram_payment_charge_id,
        eventType: "telegram.stars.payment.refunded",
        payload: {
          paymentId: payment.id,
          telegramUserId: payment.customer.telegramUserId.toString(),
          telegramPaymentChargeId: receipt.telegram_payment_charge_id,
          amount: payment.amount.toString(),
          currency: payment.currency,
          source: "telegram_refunded_payment_update"
        },
        processedAt: refundedAt
      },
      update: { processedAt: refundedAt }
    });

    if (updated.count !== 1 || !payment.subscriptionId) return;

    const subscription = await tx.subscription.findUnique({
      where: { id: payment.subscriptionId },
      select: { status: true, startsAt: true, endsAt: true }
    });
    if (!subscription) return;

    const remainingPayments = await tx.payment.findMany({
      where: { subscriptionId: payment.subscriptionId, status: { in: ["SUCCEEDED", "REFUNDING"] } },
      orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
      select: { paidAt: true, metadata: true }
    });

    if (remainingPayments.length === 0) {
      await tx.subscription.update({
        where: { id: payment.subscriptionId },
        data: { status: "EXPIRED", endsAt: refundedAt, cancelledAt: null }
      });
      return;
    }

    const recalculated = recalculateSubscriptionPeriod(remainingPayments, {
      startsAt: subscription.startsAt,
      endsAt: subscription.endsAt
    });
    if (!recalculated.exact) {
      const shouldExpire = subscription.status === "EXPIRED" ||
        (subscription.endsAt !== null && subscription.endsAt <= refundedAt);
      if (shouldExpire && subscription.status !== "EXPIRED") {
        await tx.subscription.update({ where: { id: payment.subscriptionId }, data: { status: "EXPIRED" } });
      }
      return;
    }

    const isExpired = recalculated.endsAt !== null && recalculated.endsAt <= refundedAt;
    await tx.subscription.update({
      where: { id: payment.subscriptionId },
      data: {
        status: isExpired ? "EXPIRED" : "ACTIVE",
        startsAt: recalculated.startsAt,
        endsAt: recalculated.endsAt,
        cancelledAt: null
      }
    });
  });
}
/**
 * Processes a single update for a connected project bot.
 * No polling is started; updates are dispatched by the authenticated webhook route.
 */
export async function handleProjectBotUpdate(
  botToken: string,
  projectId: string,
  projectBotId: string,
  update: TelegramUpdate,
  updateId: number,
  sequenceEpoch: number
): Promise<void> {
  const projectBot = new Bot(botToken);

  const subscriptionUpdate = parseTelegramStarSubscriptionUpdate(update as unknown);
  if (subscriptionUpdate) {
    const payment = await prisma.payment.findUnique({
      where: { id: subscriptionUpdate.invoicePayload },
      select: {
        projectId: true,
        customerId: true,
        subscriptionId: true,
        provider: true,
        currency: true,
        providerPaymentId: true,
        metadata: true,
        customer: { select: { telegramUserId: true } }
      }
    });
    const metadata = payment?.metadata && typeof payment.metadata === "object" && !Array.isArray(payment.metadata)
      ? payment.metadata as Record<string, unknown>
      : null;

    // Subscription-state updates are accepted only for a recurring Stars checkout
    // created by this exact project bot. One-time invoices cannot mutate recurring state.
    if (
      payment &&
      payment.projectId === projectId &&
      payment.subscriptionId &&
      payment.provider === "TELEGRAM_STARS" &&
      payment.currency === "XTR" &&
      payment.providerPaymentId !== null &&
      payment.customer.telegramUserId === BigInt(subscriptionUpdate.telegramUserId) &&
      metadata?.source === "project_bot" &&
      metadata.projectBotId === projectBotId &&
      metadata.isRecurring === true
    ) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
          payment.subscriptionId
        );
        const current = await tx.subscription.findUnique({
          where: { id: payment.subscriptionId! },
          select: {
            projectId: true,
            customerId: true,
            telegramStarInitialChargeId: true,
            telegramStarSubscriptionLastUpdateId: true,
            telegramStarSubscriptionSequenceEpoch: true
          }
        });
        if (
          !current ||
          current.projectId !== projectId ||
          current.customerId !== payment.customerId ||
          current.telegramStarInitialChargeId !== payment.providerPaymentId ||
          !shouldProcessTelegramUpdate(
            updateId,
            current.telegramStarSubscriptionLastUpdateId === null
              ? null
              : BigInt(current.telegramStarSubscriptionLastUpdateId),
            current.telegramStarSubscriptionSequenceEpoch,
            sequenceEpoch
          )
        ) {
          return;
        }

        // A buyer cancellation stops future renewals; access remains valid until
        // the already-paid Telegram subscription period expires.
        await tx.subscription.update({
          where: { id: payment.subscriptionId! },
          data: {
            telegramStarSubscriptionState: subscriptionUpdate.state,
            telegramStarSubscriptionLastUpdateId: updateId,
            telegramStarSubscriptionSequenceEpoch: sequenceEpoch
          }
        });
      });
    }
  }

  projectBot.on("my_chat_member", async (ctx) => {
    const chat = ctx.myChatMember.chat;

    const chatType =
      chat.type === "channel" ? "CHANNEL" :
      chat.type === "group" ? "GROUP" :
      chat.type === "supergroup" ? "SUPERGROUP" :
      null;

    if (!chatType) return;

    const telegramChatId = BigInt(chat.id);
    const existingChat = await prisma.connectedChat.findUnique({
      where: { projectId_telegramChatId: { projectId, telegramChatId } },
      select: {
        isActive: true,
        lastBotStatusUpdateId: true,
        lastBotStatusSequenceEpoch: true
      }
    });
    if (existingChat && !shouldProcessTelegramUpdate(
      updateId,
      existingChat.lastBotStatusUpdateId === null ? null : BigInt(existingChat.lastBotStatusUpdateId),
      existingChat.lastBotStatusSequenceEpoch,
      sequenceEpoch
    )) {
      return;
    }

    const hasRequiredRights = hasRequiredSubscriptionChatRights(ctx.myChatMember.new_chat_member);

    await prisma.$transaction(async (tx) => {
      let isActive = hasRequiredRights;

      if (hasRequiredRights && !existingChat?.isActive) {
        const project = await tx.project.findUnique({
          where: { id: projectId },
          select: { workspaceId: true }
        });

        if (project) {
          // Lock the same workspace row used by control-bot quota mutations so
          // concurrent chat activations cannot exceed the per-project limit.
          await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${project.workspaceId} FOR UPDATE`;

          const billing = await tx.workspaceBilling.findUnique({
            where: { workspaceId: project.workspaceId },
            include: { platformPlan: true }
          });
          const currentUsage = billing
            ? await tx.connectedChat.count({ where: { projectId, isActive: true } })
            : 0;

          isActive = shouldActivateConnectedChat({
            hasRequiredRights,
            wasAlreadyActive: Boolean(existingChat?.isActive),
            billing: billing ? {
              status: billing.status,
              platformPlanIsActive: billing.platformPlan.isActive,
              features: billing.platformPlan.features
            } : null,
            currentActiveChats: currentUsage
          });
        } else {
          isActive = false;
        }
      }

      await tx.connectedChat.upsert({
        where: {
          projectId_telegramChatId: {
            projectId,
            telegramChatId
          }
        },
        create: {
          projectId,
          telegramChatId,
          type: chatType,
          title: "title" in chat ? chat.title ?? null : null,
          username: "username" in chat ? chat.username ?? null : null,
          isActive,
          lastBotStatusUpdateId: updateId,
          lastBotStatusSequenceEpoch: sequenceEpoch
        },
        update: {
          type: chatType,
          title: "title" in chat ? chat.title ?? null : null,
          username: "username" in chat ? chat.username ?? null : null,
          isActive,
          lastBotStatusUpdateId: updateId,
          lastBotStatusSequenceEpoch: sequenceEpoch
        }
      });
    }, { isolationLevel: "ReadCommitted" });
  });

  const showPlans = async (ctx: Context, edit = false): Promise<void> => {
    if (!(await requirePrivateBuyerChat(ctx))) return;
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true }
    });
    if (!project || project.status !== "ACTIVE") {
      const unavailableText = "Этот проект временно недоступен для новых покупок.";
      if (edit && ctx.callbackQuery?.message) {
        await ctx.editMessageText(unavailableText);
      } else {
        await ctx.reply(unavailableText);
      }
      return;
    }

    const plans = await prisma.creatorPlan.findMany({
      where: {
        projectId,
        status: "ACTIVE",
        currency: "XTR",
        chats: { some: { connectedChat: { isActive: true } } }
      },
      include: {
        chats: {
          where: { connectedChat: { isActive: true } },
          select: { connectedChatId: true }
        }
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }]
    });

    if (plans.length === 0) {
      if (edit && ctx.callbackQuery?.message) {
        await ctx.editMessageText("Пока нет доступных тарифов.", {
          reply_markup: new InlineKeyboard().text("↻ Обновить", "buyer:plans")
        });
      } else {
        await ctx.reply("Пока нет доступных тарифов.");
      }
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const plan of plans) {
      const duration = plan.durationDays ? `${plan.durationDays} дн.` : "без срока";
      keyboard.text(
        `${plan.title.slice(0, 24)} · ${plan.price.toString()} ⭐ · ${duration}`,
        `buyer:buy:${plan.id}`
      ).row();
    }
    keyboard.text("ℹ️ Помощь", "buyer:help");

    const text = "Выберите подписку. После выбора Telegram откроет защищённый счёт в Stars.";
    if (edit && ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } else {
      await ctx.reply(text, { reply_markup: keyboard });
    }
  };

  const purchaseTermsText =
    "Условия покупки цифрового доступа. Продавцом доступа и ответственным за содержание проекта является его Администратор. " +
    "Покупатель оплачивает выбранный тариф в Telegram Stars. Доступ выдаётся после подтверждения успешного платежа Telegram " +
    "и действует в течение срока, указанного в тарифе. По окончании оплаченного срока доступ к подключённым каналам и группам " +
    "отключается, если подписка не продлена. До оплаты ознакомьтесь с описанием тарифа и условиями проекта. " +
    "При вопросах по оплате, ошибочной оплате или возврату используйте команду /paysupport.";

  const showPurchaseTerms = async (ctx: Context, planId: string): Promise<void> => {
    if (!(await requirePrivateBuyerChat(ctx))) return;
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true }
    });
    if (!project || project.status !== "ACTIVE") {
      await ctx.reply("Этот проект временно недоступен для новых покупок.");
      return;
    }
    const plan = await prisma.creatorPlan.findFirst({
      where: { id: planId, projectId, status: "ACTIVE" },
      include: { chats: { include: { connectedChat: true } } }
    });

    if (!plan) {
      await ctx.reply("Тариф не найден или сейчас недоступен.");
      return;
    }

    const duration = plan.durationDays ? plan.durationDays + " дней" : "без ограничения срока";
    const chats = plan.chats
      .filter((item) => item.connectedChat.isActive)
      .map((item) => item.connectedChat.title ?? item.connectedChat.username ?? item.connectedChat.telegramChatId.toString());

    await ctx.reply(
      "Перед оплатой ознакомьтесь с условиями.\n\n" +
      "Тариф: «" + plan.title + "»\n" +
      "Стоимость: " + plan.price.toString() + " ⭐\n" +
      "Срок доступа: " + duration + "\n" +
      "Площадки: " + (chats.length ? chats.join(", ") : "не настроены") + "\n\n" +
      purchaseTermsText +
      "\n\nНажатие кнопки ниже подтверждает ваше согласие с этими условиями.",
      {
        reply_markup: new InlineKeyboard()
          .text("✅ Принимаю условия и перейти к оплате", "buyer:accept:" + plan.id)
          .row()
          .text("Отмена", "buyer:plans")
      }
    );
  };

  projectBot.command("terms", async (ctx) => {
    if (!(await requirePrivateBuyerChat(ctx))) return;
    await ctx.reply(purchaseTermsText);
  });

  projectBot.command("paysupport", async (ctx) => {
    if (!(await requirePrivateBuyerChat(ctx))) return;
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        creatorUser: { select: { telegramId: true, username: true } },
        workspace: {
          select: {
            createdBy: { select: { telegramId: true, username: true } }
          }
        }
      }
    });

    const contact = project?.creatorUser ?? project?.workspace.createdBy;
    if (!contact) {
      await ctx.reply("По вопросам оплаты обратитесь к администратору проекта через его описание или официальный канал связи.");
      return;
    }

    const contactUrl = contact.username
      ? "https://t.me/" + contact.username
      : "tg://user?id=" + contact.telegramId.toString();
    await ctx.reply(
      "Поддержка по оплате и возвратам. Напишите владельцу проекта: " + contactUrl +
      "\nУкажите дату и сумму платежа, а также сохраните квитанцию Telegram."
    );
  });

  projectBot.command("access", async (ctx) => {
    if (!ctx.chat || ctx.chat.type !== "private" || !ctx.from) {
      await ctx.reply("Запросить ссылки можно только в личном чате с ботом проекта.");
      return;
    }

    const customer = await prisma.projectCustomer.findUnique({
      where: {
        projectId_telegramUserId: {
          projectId,
          telegramUserId: BigInt(ctx.from.id)
        }
      }
    });
    if (!customer) {
      await ctx.reply("У вас пока нет оформленных подписок в этом проекте.");
      return;
    }

    const subscriptions = await prisma.subscription.findMany({
      where: {
        projectId,
        customerId: customer.id,
        status: "ACTIVE",
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }]
      },
      include: {
        plan: { select: { title: true } },
        accessGrants: {
          where: { revokedAt: null },
          select: { connectedChat: { select: { telegramChatId: true } } }
        }
      },
      orderBy: { updatedAt: "desc" }
    });

    if (subscriptions.length === 0) {
      await ctx.reply("Активных подписок не найдено. Посмотреть тарифы можно командой /plans.");
      return;
    }

    const messages: string[] = [];
    for (const subscription of subscriptions) {
      // A renewed subscription can contain grants from multiple immutable
      // purchase snapshots. Let buyers recover every non-revoked destination.
      const chatIds = getSubscriptionGrantTelegramChatIds(subscription.accessGrants);
      const access = await deliverSubscriptionAccess(
        projectBot,
        subscription.id,
        chatIds.length > 0 ? chatIds : undefined
      );
      if (access.links.length > 0) {
        messages.push("«" + subscription.plan.title + "»\n" + access.links.join("\n"));
      }
      if (access.alreadyJoined.length > 0) {
        messages.push("«" + subscription.plan.title + "»: вы уже состоите в " + access.alreadyJoined.join(", "));
      }
      if (access.failed.length > 0) {
        messages.push("«" + subscription.plan.title + "»: не удалось создать ссылки для " + access.failed.join(", ") + ". Повторите запрос позже.");
      }
    }

    await ctx.reply(messages.length > 0
      ? "Актуальное состояние ваших доступов:\n\n" + messages.join("\n\n")
      : "Для активных подписок не удалось получить ссылки. Попробуйте позже или обратитесь в поддержку через /paysupport.");
  });

  const showBuyerSubscriptionSettings = async (ctx: Context): Promise<void> => {
    if (!(await requirePrivateBuyerChat(ctx)) || !ctx.from) return;

    const customer = await prisma.projectCustomer.findUnique({
      where: {
        projectId_telegramUserId: {
          projectId,
          telegramUserId: BigInt(ctx.from.id)
        }
      },
      select: { id: true }
    });
    if (!customer) {
      await ctx.reply("У вас пока нет подписок в этом проекте.");
      return;
    }

    const subscriptions = await prisma.subscription.findMany({
      where: {
        projectId,
        customerId: customer.id,
        status: "ACTIVE",
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }]
      },
      include: { plan: { select: { title: true } } },
      orderBy: { updatedAt: "desc" }
    });

    if (subscriptions.length === 0) {
      await ctx.reply("Активных подписок не найдено. Посмотреть тарифы можно командой /plans.");
      return;
    }

    const keyboard = new InlineKeyboard();
    let hasActions = false;
    const messages = subscriptions.map((subscription) => {
      const endLabel = subscription.endsAt
        ? subscription.endsAt.toLocaleString("ru-RU")
        : "без ограничения";
      if (!subscription.telegramStarInitialChargeId) {
        return "«" + subscription.plan.title + "»\nДоступ до: " + endLabel +
          "\nАвтопродление: не подключено";
      }

      const renewalLabel = subscription.telegramStarSubscriptionState === "ACTIVE"
        ? "включено"
        : subscription.telegramStarSubscriptionState === "CANCELED"
          ? "отключено"
          : subscription.telegramStarSubscriptionState === "FAILED"
            ? "ошибка последнего обновления"
            : "статус уточняется";
      if (subscription.telegramStarSubscriptionState === "ACTIVE") {
        keyboard.text("⏹ Отключить автопродление", "star-sub:cancel:" + subscription.id).row();
        hasActions = true;
      } else if (
        subscription.telegramStarSubscriptionState === "CANCELED" &&
        (!subscription.endsAt || subscription.endsAt > new Date())
      ) {
        keyboard.text("▶️ Включить автопродление", "star-sub:resume:" + subscription.id).row();
        hasActions = true;
      }

      return "«" + subscription.plan.title + "»\nДоступ до: " + endLabel +
        "\nАвтопродление: " + renewalLabel +
        (subscription.telegramStarSubscriptionState === "CANCELED"
          ? "\nДоступ сохранится до конца уже оплаченного периода."
          : subscription.telegramStarSubscriptionState === "FAILED"
            ? "\nПоследнее продление не прошло. Проверьте баланс Stars и статус подписки в Telegram."
            : "");
    });

    const message = "Ваши подписки:\n\n" + messages.join("\n\n");
    if (hasActions) {
      await ctx.reply(message, { reply_markup: keyboard });
    } else {
      await ctx.reply(message);
    }
  };

  projectBot.command("subscription", async (ctx) => {
    await showBuyerSubscriptionSettings(ctx);
  });

  projectBot.command("start", async (ctx) => {
    if (!(await requirePrivateBuyerChat(ctx))) return;
    await ctx.reply(
      "Добро пожаловать! Здесь можно выбрать подписку и безопасно оплатить её через Telegram Stars.",
      {
        reply_markup: new InlineKeyboard()
          .text("💎 Посмотреть подписки", "buyer:plans")
          .row()
          .text("👤 Мои подписки", "buyer:subscription")
          .row()
          .text("ℹ️ Как это работает", "buyer:help")
      }
    );
  });

  projectBot.command("plans", async (ctx) => showPlans(ctx));

  projectBot.command("buy", async (ctx) => {
    const planId = String(ctx.match ?? "").trim();
    if (!planId) {
      await showPlans(ctx);
      return;
    }

    await showPurchaseTerms(ctx, planId);
  });

  projectBot.callbackQuery("buyer:plans", async (ctx) => {
    if (!(await requirePrivateBuyerChat(ctx))) return;
    await ctx.answerCallbackQuery();
    await showPlans(ctx, true);
  });

  projectBot.callbackQuery("buyer:subscription", async (ctx) => {
    if (!(await requirePrivateBuyerChat(ctx))) return;
    await ctx.answerCallbackQuery();
    await showBuyerSubscriptionSettings(ctx);
  });

  projectBot.callbackQuery(/^star-sub:(cancel|resume):(.+)$/, async (ctx) => {
    if (!(await requirePrivateBuyerChat(ctx)) || !ctx.from) return;
    await ctx.answerCallbackQuery();

    const action = ctx.match[1];
    const subscriptionId = ctx.match[2];
    if (!subscriptionId || (action !== "cancel" && action !== "resume")) return;

    const customer = await prisma.projectCustomer.findUnique({
      where: {
        projectId_telegramUserId: {
          projectId,
          telegramUserId: BigInt(ctx.from.id)
        }
      },
      select: { id: true }
    });
    if (!customer) {
      await ctx.reply("Подписка не найдена. Обновите меню через /subscription.");
      return;
    }

    const subscription = await prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        projectId,
        customerId: customer.id,
        status: "ACTIVE",
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }]
      },
      select: {
        id: true,
        endsAt: true,
        telegramStarInitialChargeId: true,
        telegramStarSubscriptionState: true
      }
    });
    const stateMatches = action === "cancel"
      ? subscription?.telegramStarSubscriptionState === "ACTIVE"
      : subscription?.telegramStarSubscriptionState === "CANCELED";
    if (
      !subscription ||
      !subscription.telegramStarInitialChargeId ||
      !stateMatches
    ) {
      await ctx.reply("Состояние автопродления уже изменилось или срок подписки закончился. Проверьте /subscription.");
      return;
    }

    try {
      const rawApi = projectBot.api.raw as unknown as {
        editUserStarSubscription: (args: {
          user_id: number;
          telegram_payment_charge_id: string;
          is_canceled: boolean;
        }) => Promise<boolean>;
      };
      const changed = await rawApi.editUserStarSubscription({
        user_id: ctx.from.id,
        telegram_payment_charge_id: subscription.telegramStarInitialChargeId,
        is_canceled: action === "cancel"
      });
      if (!changed) {
        await ctx.reply("Telegram не подтвердил изменение автопродления. Попробуйте ещё раз позже.");
        return;
      }

      const nextState = action === "cancel" ? "CANCELED" : "ACTIVE";
      const saved = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
          subscription.id
        );
        const updated = await tx.subscription.updateMany({
          where: {
            id: subscription.id,
            projectId,
            customerId: customer.id,
            telegramStarInitialChargeId: subscription.telegramStarInitialChargeId
          },
          data: { telegramStarSubscriptionState: nextState }
        });
        return updated.count === 1;
      });

      if (!saved) {
        await ctx.reply(
          "Telegram принял запрос, но локальный статус не удалось обновить. " +
          "Откройте /subscription ещё раз; состояние будет сверено по обновлению Telegram."
        );
        return;
      }

      await ctx.reply(action === "cancel"
        ? "Автопродление отключено. Доступ останется активным до конца уже оплаченного периода."
        : "Автопродление снова включено. Следующее списание будет выполняться Telegram по расписанию.");
      await showBuyerSubscriptionSettings(ctx);
    } catch (error) {
      console.error(
        "Could not update Telegram Stars subscription renewal state:",
        error instanceof Error ? error.name : "UnknownError"
      );
      await ctx.reply("Не удалось изменить автопродление в Telegram. Попробуйте позже или обратитесь в /paysupport.");
    }
  });

  projectBot.callbackQuery("buyer:help", async (ctx) => {
    if (!(await requirePrivateBuyerChat(ctx))) return;
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Выберите тариф кнопкой в меню. Оплата проходит внутри Telegram в Stars. После подтверждения оплаты бот пришлёт персональные ссылки для вступления. Каждая ссылка действует 24 часа и рассчитана на одного участника.",
      { reply_markup: new InlineKeyboard().text("💎 Выбрать подписку", "buyer:plans") }
    );
  });

  projectBot.callbackQuery(/^buyer:buy:(.+)$/, async (ctx) => {
    if (!(await requirePrivateBuyerChat(ctx))) return;
    await ctx.answerCallbackQuery();
    const planId = ctx.match[1];
    if (!planId) return;
    await showPurchaseTerms(ctx, planId);
  });

  projectBot.callbackQuery(/^buyer:accept:(.+)$/, async (ctx) => {
    if (!(await requirePrivateBuyerChat(ctx))) return;
    await ctx.answerCallbackQuery();
    const planId = ctx.match[1];
    if (!planId) return;
    await createPurchaseInvoice(projectBot, projectId, projectBotId, ctx, planId);
  });

  projectBot.on("pre_checkout_query", async (ctx) => {
    let isValid = false;
    try {
      const timeout = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 7_000);
      });
      isValid = await Promise.race([
        validatePreCheckout(ctx.preCheckoutQuery, projectId, projectBotId),
        timeout
      ]);
    } catch (error) {
      console.error(
        "Could not validate Telegram Stars pre-checkout:",
        error instanceof Error ? error.name : "UnknownError"
      );
    }

    await ctx.answerPreCheckoutQuery(
      isValid,
      isValid ? undefined : "Счёт не удалось подтвердить или он устарел. Создайте новую покупку."
    );
  });

  projectBot.on("message:successful_payment", async (ctx) => {
    await processSuccessfulStarsPayment(projectBot, projectId, projectBotId, ctx);
  });

  projectBot.on("message:refunded_payment", async (ctx) => {
    await processRefundedStarsPayment(projectBotId, ctx);
  });

  projectBot.on("chat_member", async (ctx) => {
    const inviteLink = ctx.chatMember.invite_link?.invite_link;
    const newMember = ctx.chatMember.new_chat_member;
    const telegramChatId = BigInt(ctx.chat.id);
    const telegramUserId = BigInt(newMember.user.id);
    const isMember =
      newMember.status === "member" ||
      newMember.status === "administrator" ||
      newMember.status === "creator" ||
      (newMember.status === "restricted" && newMember.is_member);

    if (newMember.user.is_bot) return;

    const cursorWhere = {
      projectBotId_telegramChatId_telegramUserId: {
        projectBotId,
        telegramChatId,
        telegramUserId
      }
    };
    const existingCursor = await prisma.telegramChatMemberCursor.findUnique({
      where: cursorWhere
    });
    if (existingCursor && !shouldProcessTelegramUpdate(
      updateId,
      BigInt(existingCursor.lastUpdateId),
      existingCursor.sequenceEpoch,
      sequenceEpoch
    )) {
      return;
    }
    const saveCursor = async (): Promise<void> => {
      await prisma.telegramChatMemberCursor.upsert({
        where: cursorWhere,
        create: {
          projectBotId,
          telegramChatId,
          telegramUserId,
          lastUpdateId: updateId,
          sequenceEpoch
        },
        update: { lastUpdateId: updateId, sequenceEpoch }
      });
    };

    if (!isMember) {
      const leftGrants = await prisma.subscriptionAccessGrant.findMany({
        where: {
          connectedChat: { projectId, telegramChatId },
          subscription: {
            status: "ACTIVE",
            customer: { telegramUserId }
          },
          joinedAt: { not: null },
          revokedAt: null
        },
        select: { id: true }
      });

      for (const grant of leftGrants) {
        await prisma.subscriptionAccessGrant.updateMany({
          where: { id: grant.id, revokedAt: null },
          data: { joinedAt: null, inviteLink: "", expiresAt: new Date(0) }
        });
      }
      await saveCursor();
      return;
    }

    if (!inviteLink) {
      await saveCursor();
      return;
    }

    const grant = await prisma.subscriptionAccessGrant.findFirst({
      where: {
        inviteLink,
        connectedChat: { projectId, telegramChatId },
        joinedAt: null,
        revokedAt: null
      },
      include: {
        subscription: { include: { customer: true } }
      }
    });

    if (!grant) {
      await saveCursor();
      return;
    }

    if (grant.subscription.customer.telegramUserId !== telegramUserId) {
      let inviteRevoked = false;
      try {
        await projectBot.api.revokeChatInviteLink(ctx.chat.id, inviteLink);
        inviteRevoked = true;
      } catch (error) {
        if (isTelegramInviteAlreadyRevoked(error)) {
          // A one-member link may already be expired after the unintended user consumed it.
          // Treat Telegram's explicit expired-hash response as safe revocation and issue a fresh link.
          inviteRevoked = true;
        } else {
          console.error(
            "Could not revoke an invite link used by the wrong Telegram user:",
            error instanceof Error ? error.name : "UnknownError"
          );
        }
      }

      let unintendedUserRemoved = false;
      try {
        await projectBot.api.banChatMember(ctx.chat.id, newMember.user.id);
        await projectBot.api.unbanChatMember(ctx.chat.id, newMember.user.id, { only_if_banned: true });
        unintendedUserRemoved = true;
      } catch (error) {
        console.error(
          "Could not remove an unintended invite-link user:",
          error instanceof Error ? error.name : "UnknownError"
        );
      }

      if (!inviteRevoked || !unintendedUserRemoved) {
        await enqueueProjectOwnerNotification({
          projectId,
          dedupeKey: "security:invite-mismatch:" + grant.id + ":" + newMember.user.id,
          eventType: "access_security_issue",
          messageText:
            "⚠️ Попытка вступления по чужой ссылке в проекте. Площадка: " +
            ("title" in ctx.chat ? ctx.chat.title : String(ctx.chat.id)) +
            ". Telegram ID вошедшего пользователя: " + newMember.user.id +
            ". Отзыв ссылки или удаление пользователя не удалось полностью — требуется проверка."
        }).catch(() => undefined);
      }

      if (inviteRevoked) {
        await prisma.subscriptionAccessGrant.updateMany({
          where: { id: grant.id, revokedAt: null },
          data: { inviteLink: "", expiresAt: new Date(0), revokedAt: new Date() }
        });

        const freshAccess = await deliverSubscriptionAccess(projectBot, grant.subscriptionId);
        if (freshAccess.links.length > 0) {
          await projectBot.api.sendMessage(
            Number(grant.subscription.customer.telegramUserId),
            "Похоже, ваша персональная ссылка была использована другим аккаунтом. Создана новая ссылка для вступления:\n" +
            freshAccess.links.join("\n")
          ).catch(() => undefined);
        }
      }
      await saveCursor();
      return;
    }

    await prisma.subscriptionAccessGrant.updateMany({
      where: { id: grant.id, joinedAt: null, revokedAt: null },
      data: { joinedAt: new Date() }
    });
    await saveCursor();
  });

  await projectBot.handleUpdate(update);
}
