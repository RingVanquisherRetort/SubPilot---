import { randomUUID } from "node:crypto";
import { Bot, type Context } from "grammy";
import { prisma } from "@subpilot/database";

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
      "/projects — список проектов\n\n" +
      "Подключение ботов, каналов, платежей и тарифов появится в следующих этапах разработки."
    );
  });

  bot.catch((error) => {
    console.error("Unhandled SubPilot control-bot error:", error.error);
  });

  return bot;
}
