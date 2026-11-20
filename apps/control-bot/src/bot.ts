import { randomUUID } from "node:crypto";
import { Bot, type Context } from "grammy";
import { prisma } from "@subpilot/database";
import { encryptSecret } from "@subpilot/security";

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);

  return slug || "project";
}

async function upsertTelegramUser(ctx: Context) {
  const telegramUser = ctx.from;

  if (!telegramUser) {
    throw new Error("Telegram user context is missing");
  }

  return prisma.user.upsert({
    where: { telegramId: BigInt(telegramUser.id) },
    update: {
      username: telegramUser.username ?? null,
      firstName: telegramUser.first_name ?? null,
      lastName: telegramUser.last_name ?? null,
      languageCode: telegramUser.language_code ?? null
    },
    create: {
      telegramId: BigInt(telegramUser.id),
      username: telegramUser.username ?? null,
      firstName: telegramUser.first_name ?? null,
      lastName: telegramUser.last_name ?? null,
      languageCode: telegramUser.language_code ?? null
    }
  });
}

async function ensurePersonalWorkspace(user: { id: string; telegramId: bigint; firstName: string | null }) {
  const slug = `personal-${user.telegramId.toString()}`;

  const workspace = await prisma.workspace.upsert({
    where: { slug },
    update: {},
    create: {
      name: user.firstName ? `${user.firstName}'s workspace` : "My workspace",
      slug,
      type: "PERSONAL",
      createdById: user.id,
      members: {
        create: { userId: user.id, role: "OWNER" }
      }
    }
  });

  await prisma.workspaceMember.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: user.id
      }
    },
    update: {},
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      role: "OWNER"
    }
  });

  return workspace;
}

export function createControlBot(token: string): Bot {
  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    try {
      const user = await upsertTelegramUser(ctx);
      await ensurePersonalWorkspace(user);

      await ctx.reply(
        "Добро пожаловать в SubPilot!\n\n" +
        "Здесь вы сможете управлять проектами, Telegram-ботами, подписками и монетизацией.\n\n" +
        "Команды:\n" +
        "/newproject Название — создать проект\n" +
        "/projects — список проектов\n" +
        "/help — помощь"
      );
    } catch (error) {
      console.error("Control bot /start failed:", error);
      await ctx.reply("Не удалось создать рабочее пространство. Попробуйте ещё раз позже.");
    }
  });

  bot.command("newproject", async (ctx) => {
    const name = String(ctx.match ?? "").trim();

    if (name.length < 2 || name.length > 80) {
      await ctx.reply("Укажите название проекта: /newproject Мой канал");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const workspace = await ensurePersonalWorkspace(user);
      const slug = `${slugify(name)}-${randomUUID().slice(0, 6)}`;

      const project = await prisma.project.create({
        data: {
          workspaceId: workspace.id,
          name,
          slug,
          defaultCurrency: "RUB",
          countryCode: "RU"
        }
      });

      await ctx.reply(
        `Проект «${project.name}» создан.\n\n` +
        `Код проекта: ${project.id}\n\n` +
        "Следующий этап — подключение отдельного Telegram-бота проекта."
      );
    } catch (error) {
      console.error("Control bot /newproject failed:", error);
      await ctx.reply("Не удалось создать проект. Попробуйте ещё раз позже.");
    }
  });

  bot.command("connectbot", async (ctx) => {
    const input = String(ctx.match ?? "").trim();
    const match = input.match(/^(\\S+)\\s+(\\S+)$/);

    if (ctx.chat.type !== "private") {
      await ctx.reply("Для безопасности подключайте бота только в личном чате с SubPilot.");
      return;
    }

    // Best-effort deletion reduces the time a BotFather token remains in chat history.
    await ctx.deleteMessage().catch(() => undefined);

    if (!match) {
      await ctx.reply("Формат команды: /connectbot PROJECT_ID BOT_TOKEN");
      return;
    }

    const projectId = match[1];
    const botToken = match[2];

    if (!projectId || !botToken) {
      await ctx.reply("Не удалось распознать ID проекта и токен.");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const project = await prisma.project.findFirst({
        where: {
          id: projectId,
          workspace: {
            members: {
              some: {
                userId: user.id,
                role: { in: ["OWNER", "ADMIN"] }
              }
            }
          }
        },
        select: { id: true, name: true }
      });

      if (!project) {
        await ctx.reply("Проект не найден или у вас нет прав владельца/администратора.");
        return;
      }

      // Validate the token against Telegram before saving it.
      const candidateBot = new Bot(botToken);
      const botInfo = await candidateBot.api.getMe();
      const telegramBotId = BigInt(botInfo.id);

      const existingBot = await prisma.projectBot.findUnique({
        where: { telegramBotId }
      });

      if (existingBot && existingBot.projectId !== project.id) {
        await ctx.reply("Этот Telegram-бот уже подключён к другому проекту.");
        return;
      }

      const encryptedToken = encryptSecret(botToken);
      const botData = {
        username: botInfo.username ?? null,
        displayName: botInfo.first_name,
        tokenEncrypted: encryptedToken,
        status: "PENDING" as const,
        lastVerifiedAt: new Date()
      };

      if (existingBot) {
        await prisma.projectBot.update({
          where: { id: existingBot.id },
          data: botData
        });
      } else {
        await prisma.projectBot.create({
          data: {
            projectId: project.id,
            telegramBotId,
            ...botData
          }
        });
      }

      await ctx.reply(
        "Бот успешно проверен и сохранён.\n\n" +
        `Проект: ${project.name}\n` +
        `Бот: @${botInfo.username ?? botInfo.first_name}\n\n` +
        "Токен хранится в зашифрованном виде. Следующий этап — включение webhook и подключение каналов."
      );
    } catch (error) {
      // Never log the submitted token or the command payload.
      console.error("Control bot /connectbot failed:", error instanceof Error ? error.message : "Unknown error");
      await ctx.reply("Не удалось проверить или подключить бота. Проверьте токен и повторите попытку.");
    }
  });

  bot.command("projects", async (ctx) => {
    try {
      const user = await upsertTelegramUser(ctx);
      const workspace = await ensurePersonalWorkspace(user);
      const projects = await prisma.project.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, status: true }
      });

      if (projects.length === 0) {
        await ctx.reply("Пока нет проектов. Создайте первый командой /newproject Название.");
        return;
      }

      const lines = projects.map((project, index) =>
        `${index + 1}. ${project.name} — ${project.status.toLowerCase()}\nID: ${project.id}`
      );

      await ctx.reply("Ваши проекты:\n\n" + lines.join("\n\n"));
    } catch (error) {
      console.error("Control bot /projects failed:", error);
      await ctx.reply("Не удалось загрузить проекты. Попробуйте ещё раз позже.");
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "SubPilot — управление платными Telegram-сообществами.\n\n" +
      "/start — открыть кабинет\n" +
      "/newproject Название — создать проект\n" +
      "/projects — список проектов\n" +
      "/connectbot PROJECT_ID TOKEN — подключить своего бота к проекту\n\n" +
      "После подключения токен проверяется через Telegram и хранится в зашифрованном виде."
    );
  });

  bot.catch((error) => {
    console.error("Unhandled SubPilot control-bot error:", error.error);
  });

  return bot;
}
