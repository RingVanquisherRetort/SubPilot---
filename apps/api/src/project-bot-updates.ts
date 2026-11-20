import { randomUUID } from "node:crypto";
import { Bot, type CommandContext, type Context } from "grammy";
import { prisma } from "@subpilot/database";

type TelegramUpdate = Parameters<Bot["handleUpdate"]>[0];

const MAX_STARS_AMOUNT = 10_000;
const INVITE_LIFETIME_SECONDS = 24 * 60 * 60;

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
  ctx: CommandContext<Context>,
  planId: string
): Promise<void> {
  if (ctx.chat.type !== "private" || !ctx.from) {
    await ctx.reply("Покупка доступна только в личном чате с ботом проекта.");
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

  if (plan.currency !== "XTR") {
    await ctx.reply("Этот тариф пока не настроен для оплаты в Telegram Stars. Обратитесь к владельцу проекта.");
    return;
  }

  const amountStars = getStarAmount(plan.price);
  if (amountStars === null) {
    await ctx.reply("У тарифа некорректная цена в Stars. Попросите владельца проверить настройки тарифа.");
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
    const subscription = await tx.subscription.create({
      data: {
        projectId,
        customerId: customer.id,
        planId: plan.id,
        status: "PENDING"
      }
    });

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
          planId: plan.id
        }
      }
    });

    return { payment, subscription };
  });

  try {
    await ctx.api.sendInvoice(
      ctx.chat.id,
      plan.title.slice(0, 32),
      (plan.description ?? `Доступ к подписке «${plan.title}»`).slice(0, 255),
      pending.payment.id,
      [{ label: plan.title.slice(0, 32), amount: amountStars }],
      "XTR"
    );
  } catch (error) {
    await prisma.$transaction([
      prisma.payment.updateMany({
        where: { id: pending.payment.id, status: "PENDING" },
        data: { status: "FAILED" }
      }),
      prisma.subscription.updateMany({
        where: { id: pending.subscription.id, status: "PENDING" },
        data: { status: "CANCELLED", cancelledAt: new Date() }
      })
    ]);

    console.error(
      "Project bot could not create Telegram Stars invoice:",
      error instanceof Error ? error.name : "UnknownError"
    );
    await ctx.reply("Не удалось выставить счёт. Попробуйте ещё раз позже.");
  }
}

async function validatePreCheckout(
  query: {
    invoice_payload: string;
    from: { id: number };
    currency: string;
    total_amount: number;
  },
  projectId: string
): Promise<boolean> {
  const payment = await prisma.payment.findUnique({
    where: { id: query.invoice_payload },
    include: { customer: true }
  });

  return Boolean(
    payment &&
    payment.projectId === projectId &&
    payment.provider === "TELEGRAM_STARS" &&
    payment.currency === "XTR" &&
    payment.status === "PENDING" &&
    payment.customer.telegramUserId === BigInt(query.from.id) &&
    query.currency === "XTR" &&
    Number(payment.amount.toString()) === query.total_amount
  );
}

async function deliverSubscriptionAccess(
  bot: Bot,
  subscriptionId: string
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

  for (const planChat of subscription.plan.chats) {
    const chat = planChat.connectedChat;
    if (!chat.isActive) continue;

    const label = chat.title ?? chat.username ?? chat.telegramChatId.toString();
    const existing = await prisma.subscriptionAccessGrant.findUnique({
      where: {
        subscriptionId_connectedChatId: {
          subscriptionId: subscription.id,
          connectedChatId: chat.id
        }
      }
    });

    if (existing?.joinedAt) {
      results.alreadyJoined.push(label);
      continue;
    }

    const now = new Date();
    if (existing && !existing.revokedAt && existing.expiresAt > now) {
      results.links.push(`${label}: ${existing.inviteLink}`);
      continue;
    }

    try {
      if (existing?.inviteLink) {
        await bot.api.revokeChatInviteLink(chat.telegramChatId.toString(), existing.inviteLink)
          .catch(() => undefined);
      }

      const expiresAt = new Date(Date.now() + INVITE_LIFETIME_SECONDS * 1000);
      const invite = await bot.api.createChatInviteLink(
        chat.telegramChatId.toString(),
        {
          name: `SubPilot ${subscription.id.slice(-12)}`,
          expire_date: Math.floor(expiresAt.getTime() / 1000),
          member_limit: 1
        }
      );

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
          revokedAt: null
        }
      });

      results.links.push(`${label}: ${invite.invite_link}`);
    } catch (error) {
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
      }
    }
  });

  if (
    !payment ||
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
  const expirationFromTelegram = receipt.subscription_expiration_date
    ? new Date(receipt.subscription_expiration_date * 1000)
    : null;
  const endsAt = expirationFromTelegram ??
    (subscription.plan.durationDays
      ? new Date(now.getTime() + subscription.plan.durationDays * 24 * 60 * 60 * 1000)
      : null);

  await prisma.$transaction(async (tx) => {
    const updated = await tx.payment.updateMany({
      where: {
        id: payment.id,
        status: "PENDING",
        provider: "TELEGRAM_STARS"
      },
      data: {
        status: "SUCCEEDED",
        providerPaymentId: receipt.telegram_payment_charge_id,
        paidAt: now
      }
    });

    if (updated.count === 1) {
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: "ACTIVE",
          startsAt: now,
          endsAt
        }
      });

      await tx.paymentWebhookEvent.create({
        data: {
          connectionId: null,
          dedupeKey: `telegram-stars:${receipt.telegram_payment_charge_id}`,
          providerEventId: receipt.telegram_payment_charge_id,
          eventType: "telegram.stars.payment.succeeded",
          payload: {
            invoicePayload: receipt.invoice_payload,
            currency: receipt.currency,
            totalAmount: receipt.total_amount,
            telegramPaymentChargeId: receipt.telegram_payment_charge_id,
            providerPaymentChargeId: receipt.provider_payment_charge_id
          },
          processedAt: now
        }
      });
    }
  });

  const latestPayment = await prisma.payment.findUnique({
    where: { id: payment.id },
    select: { status: true }
  });

  if (latestPayment?.status !== "SUCCEEDED") {
    await ctx.reply("Оплата пока не подтверждена в системе. Квитанцию Telegram сохраните и обратитесь к владельцу проекта.");
    return;
  }

  const access = await deliverSubscriptionAccess(bot, subscription.id);
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
      `Не удалось автоматически создать ссылки для: ${access.failed.join(", ")}. Платёж подтверждён; обратитесь к владельцу проекта для восстановления доступа.`
    );
  }

  await ctx.reply(messageParts.join("\n\n"));
}

/**
 * Processes a single update for a connected project bot.
 * No polling is started; updates are dispatched by the authenticated webhook route.
 */
export async function handleProjectBotUpdate(
  botToken: string,
  projectId: string,
  update: TelegramUpdate
): Promise<void> {
  const projectBot = new Bot(botToken);

  projectBot.on("my_chat_member", async (ctx) => {
    const chat = ctx.myChatMember.chat;

    const chatType =
      chat.type === "channel" ? "CHANNEL" :
      chat.type === "group" ? "GROUP" :
      chat.type === "supergroup" ? "SUPERGROUP" :
      null;

    if (!chatType) return;

    const membershipStatus = ctx.myChatMember.new_chat_member.status;
    const isActive = membershipStatus === "administrator" || membershipStatus === "creator";

    await prisma.connectedChat.upsert({
      where: {
        projectId_telegramChatId: {
          projectId,
          telegramChatId: BigInt(chat.id)
        }
      },
      create: {
        projectId,
        telegramChatId: BigInt(chat.id),
        type: chatType,
        title: "title" in chat ? chat.title ?? null : null,
        username: "username" in chat ? chat.username ?? null : null,
        isActive
      },
      update: {
        type: chatType,
        title: "title" in chat ? chat.title ?? null : null,
        username: "username" in chat ? chat.username ?? null : null,
        isActive
      }
    });
  });

  projectBot.command("buy", async (ctx) => {
    const planId = String(ctx.match ?? "").trim();
    if (!planId) {
      await ctx.reply("Формат: /buy PLAN_ID");
      return;
    }

    await createPurchaseInvoice(projectBot, projectId, ctx, planId);
  });

  projectBot.on("pre_checkout_query", async (ctx) => {
    const isValid = await validatePreCheckout(ctx.preCheckoutQuery, projectId);
    await ctx.answerPreCheckoutQuery(
      isValid,
      isValid ? undefined : "Счёт устарел или не совпадает с данными заказа. Создайте новую покупку."
    );
  });

  projectBot.on("message:successful_payment", async (ctx) => {
    await processSuccessfulStarsPayment(projectBot, projectId, ctx);
  });

  projectBot.on("chat_member", async (ctx) => {
    const inviteLink = ctx.chatMember.invite_link?.invite_link;
    const newMember = ctx.chatMember.new_chat_member;

    if (!inviteLink || newMember.status === "left" || newMember.status === "kicked" || newMember.user.is_bot) {
      return;
    }

    await prisma.subscriptionAccessGrant.updateMany({
      where: {
        inviteLink,
        connectedChat: {
          projectId,
          telegramChatId: BigInt(ctx.chat.id)
        },
        joinedAt: null,
        revokedAt: null
      },
      data: { joinedAt: new Date() }
    });
  });

  await projectBot.handleUpdate(update);
}
