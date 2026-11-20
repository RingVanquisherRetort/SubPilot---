import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Bot, InlineKeyboard, type Context } from "grammy";
import { prisma } from "@subpilot/database";
import { decryptSecret, encryptSecret } from "@subpilot/security";

const MANAGER_ROLES = ["OWNER", "ADMIN", "MANAGER"] as const;
const ADMIN_ROLES = ["OWNER", "ADMIN"] as const;
const BOT_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{20,}$/;
const BOT_TOKEN_TTL_MS = 5 * 60 * 1000;

type TelegramUser = Awaited<ReturnType<typeof upsertTelegramUser>>;
type PendingBotConnection = {
  projectId: string;
  expiresAt: number;
};

type PendingTextAction =
  | { kind: "new_project" }
  | { kind: "new_agency" }
  | { kind: "create_plan"; projectId: string }
  | { kind: "edit_plan"; projectId: string; planId: string };

function homeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📁 Мои проекты", "ui:projects")
    .text("🏢 Пространства", "ui:workspaces")
    .row()
    .text("➕ Новый проект", "ui:newproject")
    .text("🏬 Создать агентство", "ui:newagency")
    .row()
    .text("👥 Команда", "ui:team")
    .text("❔ Помощь", "ui:help");
}

function backHomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("⬅️ В главное меню", "ui:home");
}


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

async function ensurePersonalWorkspace(user: TelegramUser) {
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

async function getActiveWorkspace(user: TelegramUser) {
  if (user.activeWorkspaceId) {
    const activeMembership = await prisma.workspaceMember.findFirst({
      where: {
        userId: user.id,
        workspaceId: user.activeWorkspaceId
      },
      include: { workspace: true }
    });

    if (activeMembership) {
      return {
        workspace: activeMembership.workspace,
        role: activeMembership.role
      };
    }
  }

  const personalWorkspace = await ensurePersonalWorkspace(user);
  const membership = await prisma.workspaceMember.findUniqueOrThrow({
    where: {
      workspaceId_userId: {
        workspaceId: personalWorkspace.id,
        userId: user.id
      }
    }
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { activeWorkspaceId: personalWorkspace.id }
  });

  return { workspace: personalWorkspace, role: membership.role };
}

async function canAccessProject(
  projectId: string,
  userId: string,
  roles: readonly ("OWNER" | "ADMIN" | "MANAGER" | "VIEWER")[]
) {
  return prisma.project.findFirst({
    where: {
      id: projectId,
      workspace: {
        members: {
          some: {
            userId,
            role: { in: [...roles] }
          }
        }
      }
    },
    select: { id: true, name: true, workspaceId: true, defaultCurrency: true }
  });
}

export function createControlBot(token: string): Bot {
  const bot = new Bot(token);
  // Pending states are short-lived and intentionally kept in memory only.
  // A bot restart cancels a pending token submission; no secrets are persisted here.
  const pendingBotConnections = new Map<number, PendingBotConnection>();
  const pendingTextActions = new Map<number, PendingTextAction>();

  bot.callbackQuery("ui:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const { workspace, role } = await getActiveWorkspace(user);
    await ctx.editMessageText(
      `🚀 SubPilot\n\nПространство: ${workspace.name}\nРоль: ${String(role).toLowerCase()}\n\nВыберите действие:`,
      { reply_markup: homeKeyboard() }
    );
  });

  bot.callbackQuery("ui:team", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const { workspace, role } = await getActiveWorkspace(user);
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
      include: { user: true },
      orderBy: { createdAt: "asc" },
      take: 30
    });
    const lines = members.map((member, index) => {
      const name = [member.user.firstName, member.user.lastName].filter(Boolean).join(" ") ||
        (member.user.username ? `@${member.user.username}` : "Пользователь");
      return `${index + 1}. ${name} · ${member.role.toLowerCase()}`;
    });
    const keyboard = new InlineKeyboard();
    if (role === "OWNER" || role === "ADMIN") {
      keyboard.text("➕ Пригласить участника", "ui:invite").row();
    }
    keyboard.text("⬅️ В главное меню", "ui:home");
    await ctx.editMessageText(
      `Команда пространства «${workspace.name}»:\n\n${lines.join("\n") || "Пока только вы."}`,
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery("ui:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const { role } = await getActiveWorkspace(user);
    if (role !== "OWNER" && role !== "ADMIN") {
      await ctx.reply("Приглашать участников могут только владелец или администратор.");
      return;
    }
    const keyboard = new InlineKeyboard()
      .text("Менеджер", "ui:invite:MANAGER")
      .text("Наблюдатель", "ui:invite:VIEWER")
      .row();
    if (role === "OWNER") keyboard.text("Администратор", "ui:invite:ADMIN").row();
    keyboard.text("Отмена", "ui:team");
    await ctx.reply("Выберите роль нового участника:", { reply_markup: keyboard });
  });

  bot.callbackQuery(/^ui:invite:(ADMIN|MANAGER|VIEWER)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const requestedRole = ctx.match[1] as "ADMIN" | "MANAGER" | "VIEWER";
    const user = await upsertTelegramUser(ctx);
    const { workspace, role: actorRole } = await getActiveWorkspace(user);
    if ((requestedRole === "ADMIN" && actorRole !== "OWNER") ||
        !["OWNER", "ADMIN"].includes(actorRole)) {
      await ctx.reply("У вас нет прав назначить эту роль.");
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.workspaceInvite.create({
      data: {
        workspaceId: workspace.id,
        invitedByUserId: user.id,
        tokenHash,
        role: requestedRole,
        expiresAt
      }
    });
    const botInfo = await ctx.api.getMe();
    const inviteLink = `https://t.me/${botInfo.username}?start=join_${token}`;
    await ctx.reply(
      `Приглашение в «${workspace.name}» создано. Роль: ${requestedRole.toLowerCase()}. Ссылка действует 7 дней и используется один раз:\n\n${inviteLink}`,
      { reply_markup: new InlineKeyboard().text("К команде", "ui:team").row().text("В главное меню", "ui:home") }
    );
  });

  bot.callbackQuery("ui:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      "SubPilot — кабинет для управления проектами, ботами, подписками и платежами.\n\n" +
      "Используйте кнопки меню. Когда потребуется текст (например, название проекта), бот сам попросит его ввести.",
      { reply_markup: backHomeKeyboard() }
    );
  });

  bot.callbackQuery("ui:projects", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const { workspace } = await getActiveWorkspace(user);
    const projects = await prisma.project.findMany({
      where: { workspaceId: workspace.id, status: { not: "ARCHIVED" } },
      orderBy: { createdAt: "desc" },
      take: 30
    });

    const keyboard = new InlineKeyboard();
    for (const project of projects) {
      keyboard.text(project.name.slice(0, 30), `ui:project:${project.id}`).row();
    }
    keyboard.text("➕ Создать проект", "ui:newproject").row();
    keyboard.text("⬅️ Назад", "ui:home");

    await ctx.editMessageText(
      projects.length
        ? `Проекты пространства «${workspace.name}»:\nВыберите проект:`
        : `В пространстве «${workspace.name}» пока нет проектов. Создайте первый:`,
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery("ui:workspaces", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: user.id },
      include: { workspace: true },
      orderBy: { createdAt: "asc" }
    });
    const keyboard = new InlineKeyboard();
    for (const membership of memberships) {
      const active = membership.workspaceId === user.activeWorkspaceId ? " ✓" : "";
      keyboard.text(
        `${membership.workspace.name.slice(0, 24)} · ${membership.role}${active}`,
        `ui:switch:${membership.workspaceId}`
      ).row();
    }
    keyboard.text("🏬 Создать агентство", "ui:newagency").row();
    keyboard.text("⬅️ Назад", "ui:home");
    await ctx.editMessageText("Ваши рабочие пространства. Нажмите, чтобы переключиться:", {
      reply_markup: keyboard
    });
  });

  bot.callbackQuery(/^ui:switch:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const workspaceId = ctx.match[1];
    if (!workspaceId) return;
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      include: { workspace: true }
    });
    if (!membership) {
      await ctx.answerCallbackQuery({ text: "У вас больше нет доступа к этому пространству.", show_alert: true });
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { activeWorkspaceId: workspaceId } });
    await ctx.editMessageText(`Активное пространство: ${membership.workspace.name}\n\nВыберите действие:`, {
      reply_markup: homeKeyboard()
    });
  });

  bot.callbackQuery("ui:newproject", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    pendingTextActions.set(ctx.from.id, { kind: "new_project" });
    await ctx.reply("Напишите название нового проекта одним сообщением. Для отмены нажмите кнопку:", {
      reply_markup: new InlineKeyboard().text("Отмена", "ui:cancel")
    });
  });

  bot.callbackQuery("ui:newagency", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    pendingTextActions.set(ctx.from.id, { kind: "new_agency" });
    await ctx.reply("Напишите название агентства одним сообщением:", {
      reply_markup: new InlineKeyboard().text("Отмена", "ui:cancel")
    });
  });

  bot.callbackQuery("ui:cancel", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Операция отменена." });
    if (ctx.from) {
      pendingTextActions.delete(ctx.from.id);
      pendingBotConnections.delete(ctx.from.id);
    }
    await ctx.reply("Возвращаемся в меню.", { reply_markup: homeKeyboard() });
  });

  bot.callbackQuery(/^ui:project:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const projectId = ctx.match[1];
    if (!projectId) return;
    const project = await canAccessProject(projectId, user.id, ["OWNER", "ADMIN", "MANAGER", "VIEWER"]);
    if (!project) {
      await ctx.editMessageText("Проект не найден или у вас нет доступа.", { reply_markup: backHomeKeyboard() });
      return;
    }
    const [botCount, chatCount, planCount] = await Promise.all([
      prisma.projectBot.count({ where: { projectId, status: "ACTIVE" } }),
      prisma.connectedChat.count({ where: { projectId, isActive: true } }),
      prisma.creatorPlan.count({ where: { projectId, status: "ACTIVE" } })
    ]);
    const keyboard = new InlineKeyboard()
      .text("🤖 Подключить бота", `ui:connect:${projectId}`)
      .row()
      .text("💎 Тарифы", `ui:plans:${projectId}`)
      .text("➕ Создать тариф", `ui:createplan:${projectId}`)
      .row()
      .text("📣 Каналы и группы", `ui:chats:${projectId}`)
      .text("💳 Платежи", `ui:payments:${projectId}`)
      .row()
      .text("⬅️ К проектам", "ui:projects");
    await ctx.editMessageText(
      `📁 ${project.name}\n\nБоты: ${botCount}\nАктивные площадки: ${chatCount}\nАктивные тарифы: ${planCount}\n\nВыберите раздел:`,
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^ui:connect:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const projectId = ctx.match[1];
    if (!projectId) return;
    const user = await upsertTelegramUser(ctx);
    const project = await canAccessProject(projectId, user.id, MANAGER_ROLES);
    if (!project) {
      await ctx.reply("Нет прав подключать бота к этому проекту.");
      return;
    }
    pendingBotConnections.set(ctx.from.id, { projectId, expiresAt: Date.now() + BOT_TOKEN_TTL_MS });
    await ctx.reply(
      `Подключаем бота к проекту «${project.name}». Отправьте токен от @BotFather следующим сообщением. Я удалю сообщение с токеном сразу после получения, если Telegram позволит.`,
      { reply_markup: new InlineKeyboard().text("Отмена", "ui:cancel") }
    );
  });

  bot.callbackQuery(/^ui:plans:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const projectId = ctx.match[1];
    if (!projectId) return;
    const project = await canAccessProject(projectId, user.id, ["OWNER", "ADMIN", "MANAGER", "VIEWER"]);
    if (!project) return;
    const plans = await prisma.creatorPlan.findMany({
      where: { projectId, status: "ACTIVE" },
      include: { _count: { select: { chats: true, subscriptions: true } } },
      orderBy: { sortOrder: "asc" },
      take: 30
    });
    const keyboard = new InlineKeyboard();
    for (const plan of plans) {
      keyboard.text(
        `${plan.title.slice(0, 26)} · ${plan.price.toString()} ⭐`,
        `p:v:${projectId}:${plan.id}`
      ).row();
    }
    keyboard.text("➕ Создать тариф", `ui:createplan:${projectId}`).row()
      .text("🗄 Архив тарифов", `ui:archivedplans:${projectId}`)
      .row().text("⬅️ К проекту", `ui:project:${projectId}`);
    await ctx.editMessageText(
      plans.length
        ? `Активные тарифы «${project.name}»:\\nВыберите тариф для управления:`
        : `В проекте «${project.name}» пока нет активных тарифов.`,
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^ui:archivedplans:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const projectId = ctx.match[1];
    if (!projectId) return;
    const project = await canAccessProject(projectId, user.id, ["OWNER", "ADMIN", "MANAGER", "VIEWER"]);
    if (!project) return;
    const plans = await prisma.creatorPlan.findMany({
      where: { projectId, status: "ARCHIVED" },
      orderBy: { updatedAt: "desc" },
      take: 30
    });
    const keyboard = new InlineKeyboard();
    for (const plan of plans) {
      keyboard.text(`↩️ ${plan.title.slice(0, 30)}`, `p:v:${projectId}:${plan.id}`).row();
    }
    keyboard.text("⬅️ Активные тарифы", `ui:plans:${projectId}`).row()
      .text("К проекту", `ui:project:${projectId}`);
    await ctx.editMessageText(
      plans.length ? `Архив тарифов «${project.name}»:\\nВыберите тариф для восстановления:` : "Архив пуст.",
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^p:v:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const projectId = ctx.match[1];
    const planId = ctx.match[2];
    if (!projectId || !planId) return;
    const project = await canAccessProject(projectId, user.id, ["OWNER", "ADMIN", "MANAGER", "VIEWER"]);
    if (!project) return;
    const plan = await prisma.creatorPlan.findFirst({
      where: { id: planId, projectId },
      include: {
        _count: { select: { chats: true, subscriptions: true } },
        chats: { include: { connectedChat: true } }
      }
    });
    if (!plan) {
      await ctx.editMessageText("Тариф не найден.", { reply_markup: new InlineKeyboard().text("К тарифам", `ui:plans:${projectId}`) });
      return;
    }

    const duration = plan.durationDays ? `${plan.durationDays} дн.` : "без ограничения";
    const chatNames = plan.chats.map(({ connectedChat }) =>
      connectedChat.title ?? connectedChat.username ?? connectedChat.telegramChatId.toString()
    );
    const keyboard = new InlineKeyboard();
    if (plan.status === "ACTIVE") {
      keyboard.text("✏️ Изменить тариф", `p:e:${projectId}:${planId}`).row()
        .text("🗄 В архив", `p:x:${projectId}:${planId}`);
    } else {
      keyboard.text("↩️ Восстановить", `p:r:${projectId}:${planId}`);
    }
    keyboard.row()
      .text("📣 Настроить площадки", `p:ch:${planId}`)
      .row()
      .text(plan.status === "ACTIVE" ? "⬅️ К активным" : "⬅️ К архиву",
        plan.status === "ACTIVE" ? `ui:plans:${projectId}` : `ui:archivedplans:${projectId}`)
      .text("К проекту", `ui:project:${projectId}`);

    await ctx.editMessageText(
      `💎 ${plan.title}\\n\\n` +
      `Цена: ${plan.price.toString()} ⭐\\n` +
      `Срок: ${duration}\\n` +
      `Статус: ${plan.status === "ACTIVE" ? "Активен" : "В архиве"}\\n` +
      `Площадок: ${plan._count.chats}\\n` +
      `Подписок всего: ${plan._count.subscriptions}\\n\\n` +
      `Каналы и группы:\\n${chatNames.join("\\n") || "Не привязаны"}\\n\\n` +
      `ID: ${plan.id}`,
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^p:ch:([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const planId = ctx.match[1];
    if (!planId) return;
    const user = await upsertTelegramUser(ctx);
    const plan = await prisma.creatorPlan.findFirst({
      where: { id: planId },
      select: { id: true, projectId: true }
    });
    if (!plan || !(await canAccessProject(plan.projectId, user.id, ["OWNER", "ADMIN", "MANAGER", "VIEWER"]))) {
      await ctx.reply("Тариф не найден или у вас нет доступа.");
      return;
    }

    const [linked, chats] = await Promise.all([
      prisma.creatorPlanChat.findMany({
        where: { creatorPlanId: planId },
        select: { connectedChatId: true }
      }),
      prisma.connectedChat.findMany({
        where: { projectId: plan.projectId, isActive: true },
        orderBy: { title: "asc" },
        take: 30
      })
    ]);
    const linkedIds = new Set(linked.map((item) => item.connectedChatId));
    const keyboard = new InlineKeyboard();
    for (const chat of chats) {
      const name = chat.title ?? chat.username ?? chat.telegramChatId.toString();
      keyboard.text(
        `${linkedIds.has(chat.id) ? "✅" : "➕"} ${name.slice(0, 45)}`,
        `p:ct:${planId}:${chat.id}`
      ).row();
    }
    keyboard.text("⬅️ К тарифу", `p:v:${plan.projectId}:${planId}`);
    await ctx.editMessageText(
      chats.length
        ? "Каналы и группы тарифа. Нажмите на площадку, чтобы привязать или отвязать её:\\n\\n✅ — доступ включён в тариф\\n➕ — нажмите, чтобы добавить"
        : "В проекте нет активных каналов или групп. Сначала добавьте бота проекта администратором в нужную площадку.",
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^p:ct:([^:]+):([^:]+)$/, async (ctx) => {
    const planId = ctx.match[1];
    const chatId = ctx.match[2];
    if (!planId || !chatId) return;
    const user = await upsertTelegramUser(ctx);
    const plan = await prisma.creatorPlan.findFirst({
      where: { id: planId },
      select: { id: true, projectId: true }
    });
    if (!plan || !(await canAccessProject(plan.projectId, user.id, MANAGER_ROLES))) {
      await ctx.reply("Нет прав изменять площадки этого тарифа.");
      return;
    }
    const chat = await prisma.connectedChat.findFirst({
      where: { id: chatId, projectId: plan.projectId, isActive: true },
      select: { id: true }
    });
    if (!chat) {
      await ctx.answerCallbackQuery({ text: "Площадка недоступна или отключена.", show_alert: true });
      return;
    }

    const existing = await prisma.creatorPlanChat.findUnique({
      where: {
        creatorPlanId_connectedChatId: {
          creatorPlanId: planId,
          connectedChatId: chatId
        }
      }
    });
    if (existing) {
      const activeLinkCount = await prisma.creatorPlanChat.count({
        where: { creatorPlanId: planId, connectedChat: { isActive: true } }
      });
      if (activeLinkCount <= 1) {
        await ctx.answerCallbackQuery({
          text: "У тарифа должна оставаться хотя бы одна активная площадка.",
          show_alert: true
        });
        return;
      }
      await prisma.creatorPlanChat.delete({
        where: {
          creatorPlanId_connectedChatId: {
            creatorPlanId: planId,
            connectedChatId: chatId
          }
        }
      });
    } else {
      await prisma.creatorPlanChat.create({
        data: { creatorPlanId: planId, connectedChatId: chatId }
      });
    }
    await ctx.answerCallbackQuery({ text: "Список площадок обновлён." });

    const [linked, chats] = await Promise.all([
      prisma.creatorPlanChat.findMany({
        where: { creatorPlanId: planId },
        select: { connectedChatId: true }
      }),
      prisma.connectedChat.findMany({
        where: { projectId: plan.projectId, isActive: true },
        orderBy: { title: "asc" },
        take: 30
      })
    ]);
    const linkedIds = new Set(linked.map((item) => item.connectedChatId));
    const keyboard = new InlineKeyboard();
    for (const item of chats) {
      const name = item.title ?? item.username ?? item.telegramChatId.toString();
      keyboard.text(
        `${linkedIds.has(item.id) ? "✅" : "➕"} ${name.slice(0, 45)}`,
        `p:ct:${planId}:${item.id}`
      ).row();
    }
    keyboard.text("⬅️ К тарифу", `p:v:${plan.projectId}:${planId}`);
    await ctx.editMessageText(
      "Площадки тарифа обновлены. Нажмите на площадку, чтобы изменить выбор:\\n\\n✅ — доступ включён в тариф\\n➕ — нажмите, чтобы добавить",
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^p:e:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const projectId = ctx.match[1];
    const planId = ctx.match[2];
    if (!projectId || !planId) return;
    const user = await upsertTelegramUser(ctx);
    const project = await canAccessProject(projectId, user.id, MANAGER_ROLES);
    const plan = project
      ? await prisma.creatorPlan.findFirst({ where: { id: planId, projectId } })
      : null;
    if (!plan) {
      await ctx.reply("Нет прав изменять этот тариф или тариф не найден.");
      return;
    }
    pendingTextActions.set(ctx.from.id, { kind: "edit_plan", projectId, planId });
    await ctx.reply(
      `Изменяем тариф «${plan.title}». Отправьте новые данные в формате:\\nНазвание | Цена в Stars | Дней\\n\\nТекущие данные: ${plan.title} | ${plan.price.toString()} | ${plan.durationDays ?? 0}`,
      { reply_markup: new InlineKeyboard().text("Отмена", "ui:cancel") }
    );
  });

  bot.callbackQuery(/^p:x:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const projectId = ctx.match[1];
    const planId = ctx.match[2];
    if (!projectId || !planId) return;
    const user = await upsertTelegramUser(ctx);
    const project = await canAccessProject(projectId, user.id, MANAGER_ROLES);
    if (!project) {
      await ctx.reply("Нет прав архивировать тариф.");
      return;
    }
    const result = await prisma.creatorPlan.updateMany({
      where: { id: planId, projectId, status: "ACTIVE" },
      data: { status: "ARCHIVED" }
    });
    if (result.count !== 1) {
      await ctx.reply("Тариф не найден или уже находится в архиве.");
      return;
    }
    await ctx.editMessageText("Тариф перемещён в архив. Действующие подписки сохраняются до своего окончания.", {
      reply_markup: new InlineKeyboard()
        .text("🗄 Архив тарифов", `ui:archivedplans:${projectId}`)
        .row().text("К активным тарифам", `ui:plans:${projectId}`)
    });
  });

  bot.callbackQuery(/^p:r:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const projectId = ctx.match[1];
    const planId = ctx.match[2];
    if (!projectId || !planId) return;
    const user = await upsertTelegramUser(ctx);
    const project = await canAccessProject(projectId, user.id, MANAGER_ROLES);
    if (!project) {
      await ctx.reply("Нет прав восстанавливать тариф.");
      return;
    }
    const result = await prisma.creatorPlan.updateMany({
      where: { id: planId, projectId, status: "ARCHIVED" },
      data: { status: "ACTIVE" }
    });
    if (result.count !== 1) {
      await ctx.reply("Тариф не найден или уже активен.");
      return;
    }
    await ctx.editMessageText("Тариф восстановлен и снова доступен в меню покупателя.", {
      reply_markup: new InlineKeyboard().text("Открыть тариф", `p:v:${projectId}:${planId}`)
        .row().text("К активным тарифам", `ui:plans:${projectId}`)
    });
  });

  bot.callbackQuery(/^ui:createplan:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const projectId = ctx.match[1];
    if (!projectId) return;
    const user = await upsertTelegramUser(ctx);
    const project = await canAccessProject(projectId, user.id, MANAGER_ROLES);
    if (!project) {
      await ctx.reply("Нет прав создавать тарифы в этом проекте.");
      return;
    }
    pendingTextActions.set(ctx.from.id, { kind: "create_plan", projectId });
    await ctx.reply(
      "Введите данные тарифа в одном сообщении в формате:\nНазвание | Цена в Stars | Дней\n\nПример: VIP на месяц | 499 | 30\nУкажите 0 дней для бессрочного доступа.",
      { reply_markup: new InlineKeyboard().text("Отмена", "ui:cancel") }
    );
  });

  bot.callbackQuery(/^ui:chats:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const projectId = ctx.match[1];
    if (!projectId) return;
    const project = await canAccessProject(projectId, user.id, ["OWNER", "ADMIN", "MANAGER", "VIEWER"]);
    if (!project) return;
    const chats = await prisma.connectedChat.findMany({
      where: { projectId },
      orderBy: [{ isActive: "desc" }, { title: "asc" }],
      take: 30
    });
    const lines = chats.map((chat, i) =>
      `${i + 1}. ${chat.title ?? chat.username ?? chat.telegramChatId.toString()} — ${chat.isActive ? "активна" : "неактивна"}`
    );
    await ctx.editMessageText(
      lines.length ? `Каналы и группы «${project.name}»:\n\n${lines.join("\n")}` : "Пока нет подключённых каналов или групп. Добавьте бота проекта администратором в нужную площадку.",
      { reply_markup: backHomeKeyboard() }
    );
  });

  bot.callbackQuery(/^ui:payments:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const projectId = ctx.match[1];
    if (!projectId) return;
    const project = await canAccessProject(projectId, user.id, ["OWNER", "ADMIN", "MANAGER", "VIEWER"]);
    if (!project) return;
    const payments = await prisma.payment.findMany({
      where: { projectId },
      include: { customer: true, subscription: { include: { plan: true } } },
      orderBy: { createdAt: "desc" },
      take: 10
    });
    const lines = payments.map((payment, i) =>
      `${i + 1}. ${payment.subscription?.plan.title ?? "Платёж"} — ${payment.amount.toString()} ${payment.currency}\nСтатус: ${payment.status} · ${payment.customer.username ? "@" + payment.customer.username : payment.customer.telegramUserId.toString()}\nID: ${payment.id}`
    );
    await ctx.editMessageText(
      lines.length ? `Последние платежи «${project.name}»:\n\n${lines.join("\n\n")}` : "Платежей пока нет.",
      { reply_markup: backHomeKeyboard() }
    );
  });

  bot.command("start", async (ctx) => {
    try {
      const user = await upsertTelegramUser(ctx);
      const startPayload = String(ctx.match ?? "").trim();

      if (startPayload.startsWith("join_")) {
        const inviteToken = startPayload.slice(5);
        const tokenHash = createHash("sha256").update(inviteToken).digest("hex");
        const invite = await prisma.workspaceInvite.findUnique({
          where: { tokenHash },
          include: { workspace: true }
        });

        if (!invite || invite.usedAt || invite.expiresAt.getTime() <= Date.now()) {
          await ctx.reply("Приглашение не найдено, уже использовано или срок его действия истёк.");
          return;
        }

        const accepted = await prisma.$transaction(async (tx) => {
          const claimed = await tx.workspaceInvite.updateMany({
            where: {
              id: invite.id,
              usedAt: null,
              expiresAt: { gt: new Date() }
            },
            data: { usedAt: new Date() }
          });

          if (claimed.count !== 1) return false;

          await tx.workspaceMember.upsert({
            where: {
              workspaceId_userId: {
                workspaceId: invite.workspaceId,
                userId: user.id
              }
            },
            update: {},
            create: {
              workspaceId: invite.workspaceId,
              userId: user.id,
              role: invite.role
            }
          });

          await tx.user.update({
            where: { id: user.id },
            data: { activeWorkspaceId: invite.workspaceId }
          });

          return true;
        });

        if (!accepted) {
          await ctx.reply("Это приглашение уже было использовано. Попросите владельца создать новое.");
          return;
        }

        await ctx.reply(
          `Вы присоединились к пространству «${invite.workspace.name}».\n` +
          `Ваша роль: ${invite.role.toLowerCase()}.\n\n` +
          "Текущий кабинет: /start · Проекты: /projects"
        );
        return;
      }

      const { workspace } = await getActiveWorkspace(user);

      await ctx.reply(
        `🚀 Добро пожаловать в SubPilot!\n\nАктивное пространство: ${workspace.name}\n\nВыберите нужный раздел кнопками ниже.`,
        { reply_markup: homeKeyboard() }
      );
    } catch (error) {
      console.error("Control bot /start failed:", error);
      await ctx.reply("Не удалось открыть рабочее пространство. Попробуйте ещё раз позже.");
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
      const { workspace, role } = await getActiveWorkspace(user);

      if (!MANAGER_ROLES.includes(role as typeof MANAGER_ROLES[number])) {
        await ctx.reply("У вас нет прав создавать проекты в этом пространстве.");
        return;
      }

      const slug = `${slugify(name)}-${randomUUID().slice(0, 6)}`;
      const project = await prisma.project.create({
        data: {
          workspaceId: workspace.id,
          creatorUserId: user.id,
          name,
          slug,
          defaultCurrency: "RUB",
          countryCode: "RU"
        }
      });

      await ctx.reply(
        `Проект «${project.name}» создан в пространстве «${workspace.name}».\n\n` +
        `ID проекта: ${project.id}\n\n` +
        "Чтобы подключить отдельного бота, используйте /connectbot и отправьте ID проекта."
      );
    } catch (error) {
      console.error("Control bot /newproject failed:", error);
      await ctx.reply("Не удалось создать проект. Попробуйте ещё раз позже.");
    }
  });

  bot.command("projects", async (ctx) => {
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const projects = await prisma.project.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, status: true, bots: { select: { username: true, status: true } } }
      });

      if (projects.length === 0) {
        await ctx.reply(
          `В пространстве «${workspace.name}» пока нет проектов.\n` +
          "Создайте первый командой /newproject Название."
        );
        return;
      }

      const lines = projects.map((project, index) => {
        const botInfo = project.bots[0]
          ? `@ ${project.bots[0].username ?? "бот без username"} · ${project.bots[0].status.toLowerCase()}`
          : "бот не подключён";
        return `${index + 1}. ${project.name} — ${project.status.toLowerCase()}\nID: ${project.id}\n${botInfo}`;
      });

      await ctx.reply(`Проекты пространства «${workspace.name}»:\n\n` + lines.join("\n\n"));
    } catch (error) {
      console.error("Control bot /projects failed:", error);
      await ctx.reply("Не удалось загрузить проекты. Попробуйте ещё раз позже.");
    }
  });

  bot.command("createagency", async (ctx) => {
    const name = String(ctx.match ?? "").trim();

    if (name.length < 2 || name.length > 80) {
      await ctx.reply("Укажите название агентства: /createagency My Agency");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const slug = `agency-${user.telegramId.toString()}-${randomUUID().slice(0, 8)}`;

      const agency = await prisma.workspace.create({
        data: {
          name,
          slug,
          type: "AGENCY",
          createdById: user.id,
          members: {
            create: { userId: user.id, role: "OWNER" }
          }
        }
      });

      await prisma.user.update({
        where: { id: user.id },
        data: { activeWorkspaceId: agency.id }
      });

      await ctx.reply(
        `Агентство «${agency.name}» создано.\n\n` +
        "Оно стало активным пространством. Теперь новые проекты будут создаваться внутри агентства.\n\n" +
        `ID пространства: ${agency.id}\n` +
        "Список пространств: /workspaces"
      );
    } catch (error) {
      console.error("Control bot /createagency failed:", error);
      await ctx.reply("Не удалось создать агентство. Попробуйте ещё раз позже.");
    }
  });

  bot.command("invite", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Создавать приглашения можно только в личном чате с SubPilot.");
      return;
    }

    const requestedRole = String(ctx.match ?? "").trim().toUpperCase() || "MANAGER";

    if (!["ADMIN", "MANAGER", "VIEWER"].includes(requestedRole)) {
      await ctx.reply("Формат: /invite [ADMIN|MANAGER|VIEWER]");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role: actorRole } = await getActiveWorkspace(user);

      if (!ADMIN_ROLES.includes(actorRole as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Приглашать участников могут только владелец или администратор пространства.");
        return;
      }

      if (requestedRole === "ADMIN" && actorRole !== "OWNER") {
        await ctx.reply("Назначать администраторов может только владелец пространства.");
        return;
      }

      const token = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await prisma.workspaceInvite.create({
        data: {
          workspaceId: workspace.id,
          invitedByUserId: user.id,
          tokenHash,
          role: requestedRole as "ADMIN" | "MANAGER" | "VIEWER",
          expiresAt
        }
      });

      const botInfo = await ctx.api.getMe();
      const inviteLink = `https://t.me/${botInfo.username}?start=join_${token}`;

      await ctx.reply(
        `Приглашение в «${workspace.name}» создано.\n\n` +
        `Роль: ${requestedRole.toLowerCase()}\n` +
        "Срок действия: 7 дней, одно использование.\n\n" +
        `Ссылка для отправки участнику:\n${inviteLink}`
      );
    } catch (error) {
      console.error("Control bot /invite failed:", error);
      await ctx.reply("Не удалось создать приглашение.");
    }
  });

  bot.command("members", async (ctx) => {
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const members = await prisma.workspaceMember.findMany({
        where: { workspaceId: workspace.id },
        include: { user: true },
        orderBy: { createdAt: "asc" }
      });

      const lines = members.map((member, index) => {
        const name = [member.user.firstName, member.user.lastName].filter(Boolean).join(" ")
          || (member.user.username ? `@${member.user.username}` : "Пользователь");
        const username = member.user.username ? `@${member.user.username}` : "без username";
        return `${index + 1}. ${name}\n${username} · ${member.role.toLowerCase()}\nTelegram ID: ${member.user.telegramId.toString()}`;
      });

      await ctx.reply(
        `Участники пространства «${workspace.name}»:\n\n` +
        lines.join("\n\n") +
        "\n\nПригласить участника: /invite"
      );
    } catch (error) {
      console.error("Control bot /members failed:", error);
      await ctx.reply("Не удалось загрузить участников.");
    }
  });

  bot.command("removemember", async (ctx) => {
    const telegramIdInput = String(ctx.match ?? "").trim();

    if (!/^\d{1,20}$/.test(telegramIdInput)) {
      await ctx.reply("Формат: /removemember TELEGRAM_ID\nПосмотреть ID можно командой /members.");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role: actorRole } = await getActiveWorkspace(user);

      if (!ADMIN_ROLES.includes(actorRole as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Удалять участников могут только владелец или администратор пространства.");
        return;
      }

      const target = await prisma.workspaceMember.findFirst({
        where: {
          workspaceId: workspace.id,
          user: { telegramId: BigInt(telegramIdInput) }
        },
        include: { user: true }
      });

      if (!target) {
        await ctx.reply("Такой участник не найден в активном пространстве.");
        return;
      }

      if (target.userId === user.id || target.role === "OWNER") {
        await ctx.reply("Нельзя удалить владельца пространства или самого себя этой командой.");
        return;
      }

      if (actorRole !== "OWNER" && target.role === "ADMIN") {
        await ctx.reply("Администратор не может удалять других администраторов.");
        return;
      }

      await prisma.workspaceMember.delete({ where: { id: target.id } });

      if (target.user.activeWorkspaceId === workspace.id) {
        await prisma.user.update({
          where: { id: target.userId },
          data: { activeWorkspaceId: null }
        });
      }

      await ctx.reply(
        `Участник ${target.user.username ? `@${target.user.username}` : target.user.telegramId.toString()} удалён из «${workspace.name}».`
      );
    } catch (error) {
      console.error("Control bot /removemember failed:", error);
      await ctx.reply("Не удалось удалить участника.");
    }
  });

  bot.command("invites", async (ctx) => {
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(user);

      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Просматривать приглашения могут только владелец и администратор.");
        return;
      }

      const invites = await prisma.workspaceInvite.findMany({
        where: {
          workspaceId: workspace.id,
          usedAt: null,
          expiresAt: { gt: new Date() }
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, role: true, expiresAt: true, createdAt: true }
      });

      if (invites.length === 0) {
        await ctx.reply("Активных приглашений нет. Создать новое: /invite");
        return;
      }

      const lines = invites.map((invite, index) =>
        `${index + 1}. ${invite.role.toLowerCase()}\nID: ${invite.id}\nИстекает: ${invite.expiresAt.toLocaleString("ru-RU", { timeZone: "UTC" })} UTC`
      );

      await ctx.reply("Активные приглашения:\n\n" + lines.join("\n\n"));
    } catch (error) {
      console.error("Control bot /invites failed:", error);
      await ctx.reply("Не удалось загрузить приглашения.");
    }
  });

  bot.command("revokeinvite", async (ctx) => {
    const inviteId = String(ctx.match ?? "").trim();

    if (!inviteId) {
      await ctx.reply("Формат: /revokeinvite INVITE_ID\nСписок: /invites");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(user);

      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Отзывать приглашения могут только владелец и администратор.");
        return;
      }

      const revoked = await prisma.workspaceInvite.updateMany({
        where: {
          id: inviteId,
          workspaceId: workspace.id,
          usedAt: null
        },
        data: { usedAt: new Date() }
      });

      await ctx.reply(
        revoked.count === 1
          ? "Приглашение отозвано."
          : "Активное приглашение с таким ID не найдено."
      );
    } catch (error) {
      console.error("Control bot /revokeinvite failed:", error);
      await ctx.reply("Не удалось отозвать приглашение.");
    }
  });

  bot.command("workspaces", async (ctx) => {
    try {
      const user = await upsertTelegramUser(ctx);
      const active = await getActiveWorkspace(user);
      const memberships = await prisma.workspaceMember.findMany({
        where: { userId: user.id },
        include: { workspace: true },
        orderBy: { createdAt: "asc" }
      });

      const lines = memberships.map(({ workspace, role }) => {
        const marker = workspace.id === active.workspace.id ? " → " : "";
        const type = workspace.type === "AGENCY" ? "агентство" : "личное";
        return `${marker}${workspace.name} · ${type} · ${role.toLowerCase()}\nID: ${workspace.id}`;
      });

      await ctx.reply(
        "Ваши рабочие пространства:\n\n" +
        lines.join("\n\n") +
        "\n\nПереключение: /switchworkspace WORKSPACE_ID"
      );
    } catch (error) {
      console.error("Control bot /workspaces failed:", error);
      await ctx.reply("Не удалось загрузить рабочие пространства.");
    }
  });

  bot.command("switchworkspace", async (ctx) => {
    const workspaceId = String(ctx.match ?? "").trim();

    if (!workspaceId) {
      await ctx.reply("Формат: /switchworkspace WORKSPACE_ID\nID можно посмотреть командой /workspaces.");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const membership = await prisma.workspaceMember.findFirst({
        where: { userId: user.id, workspaceId },
        include: { workspace: true }
      });

      if (!membership) {
        await ctx.reply("Это пространство вам недоступно.");
        return;
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { activeWorkspaceId: membership.workspaceId }
      });

      await ctx.reply(`Активное пространство изменено: «${membership.workspace.name}».`);
    } catch (error) {
      console.error("Control bot /switchworkspace failed:", error);
      await ctx.reply("Не удалось переключить рабочее пространство.");
    }
  });

  bot.command("renameproject", async (ctx) => {
    const input = String(ctx.match ?? "").trim();
    const splitAt = input.indexOf(" ");
    const projectId = splitAt > 0 ? input.slice(0, splitAt) : "";
    const name = splitAt > 0 ? input.slice(splitAt + 1).trim() : "";

    if (!projectId || name.length < 2 || name.length > 80) {
      await ctx.reply("Формат: /renameproject PROJECT_ID Новое название");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(user);
      if (!MANAGER_ROLES.includes(role as typeof MANAGER_ROLES[number])) {
        await ctx.reply("У вас нет прав переименовывать проекты в этом пространстве.");
        return;
      }

      const project = await prisma.project.findFirst({
        where: { id: projectId, workspaceId: workspace.id }
      });

      if (!project) {
        await ctx.reply("Проект не найден в активном пространстве.");
        return;
      }

      await prisma.project.update({
        where: { id: project.id },
        data: { name }
      });

      await ctx.reply(`Название проекта изменено на «${name}».`);
    } catch (error) {
      console.error("Control bot /renameproject failed:", error);
      await ctx.reply("Не удалось переименовать проект.");
    }
  });

  bot.command("archiveproject", async (ctx) => {
    const projectId = String(ctx.match ?? "").trim();

    if (!projectId) {
      await ctx.reply("Формат: /archiveproject PROJECT_ID");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(user);

      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Архивировать проекты может только владелец или администратор пространства.");
        return;
      }

      const project = await prisma.project.findFirst({
        where: { id: projectId, workspaceId: workspace.id }
      });

      if (!project) {
        await ctx.reply("Проект не найден в активном пространстве.");
        return;
      }

      await prisma.project.update({
        where: { id: project.id },
        data: { status: "ARCHIVED" }
      });

      await ctx.reply(`Проект «${project.name}» перемещён в архив.`);
    } catch (error) {
      console.error("Control bot /archiveproject failed:", error);
      await ctx.reply("Не удалось архивировать проект.");
    }
  });

  bot.command("restoreproject", async (ctx) => {
    const projectId = String(ctx.match ?? "").trim();

    if (!projectId) {
      await ctx.reply("Формат: /restoreproject PROJECT_ID");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(user);

      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Восстанавливать проекты может только владелец или администратор.");
        return;
      }

      const project = await prisma.project.findFirst({
        where: { id: projectId, workspaceId: workspace.id }
      });

      if (!project) {
        await ctx.reply("Проект не найден в активном пространстве.");
        return;
      }

      await prisma.project.update({
        where: { id: project.id },
        data: { status: "ACTIVE" }
      });

      await ctx.reply(`Проект «${project.name}» восстановлен.`);
    } catch (error) {
      console.error("Control bot /restoreproject failed:", error);
      await ctx.reply("Не удалось восстановить проект.");
    }
  });

  bot.command("createplan", async (ctx) => {
    const fields = String(ctx.match ?? "").split("|").map((field) => field.trim());

    if (fields.length !== 4) {
      await ctx.reply(
        "Формат: /createplan PROJECT_ID | Название | Цена | Дней\n\n" +
        "Пример: /createplan abc123 | VIP на месяц | 499 | 30\n" +
        "Укажите 0 дней для бессрочного доступа."
      );
      return;
    }

    const [projectId, title, priceInput, durationInput] = fields;
    const normalizedPrice = priceInput?.replace(",", ".");

    if (!projectId || !title || title.length > 80 || !normalizedPrice ||
        !/^\d{1,5}$/.test(normalizedPrice)) {
      await ctx.reply("Проверьте ID проекта, название и цену. Цена должна быть целым количеством Telegram Stars от 1 до 10 000.");
      return;
    }

    const priceNumber = Number(normalizedPrice);
    const durationDays = Number(durationInput);

    if (!Number.isFinite(priceNumber) || priceNumber < 1 || priceNumber > 10000 ||
        !Number.isInteger(durationDays) || durationDays < 0 || durationDays > 3650) {
      await ctx.reply("Цена должна быть больше 0, срок — целым числом от 0 до 3650 дней.");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const project = await canAccessProject(projectId, user.id, MANAGER_ROLES);

      if (!project) {
        await ctx.reply("Проект не найден или у вас нет прав управлять им.");
        return;
      }

      const activeChats = await prisma.connectedChat.findMany({
        where: { projectId: project.id, isActive: true },
        select: { id: true }
      });

      if (activeChats.length === 0) {
        await ctx.reply(
          "В проекте пока нет активных каналов или групп.\n\n" +
          "Сначала подключите бота проекта и добавьте его администратором в нужный канал/группу."
        );
        return;
      }

      const plan = await prisma.creatorPlan.create({
        data: {
          projectId: project.id,
          title,
          price: normalizedPrice,
          currency: "XTR",
          durationDays: durationDays === 0 ? null : durationDays,
          isRecurring: false,
          chats: {
            create: activeChats.map((chat) => ({ connectedChatId: chat.id }))
          }
        },
        include: { chats: true }
      });

      await ctx.reply(
        `Тариф «${plan.title}» создан.\n\n` +
        `ID: ${plan.id}\n` +
        `Цена: ${plan.price.toString()} ${plan.currency}\n` +
        `Длительность: ${plan.durationDays ? `${plan.durationDays} дней` : "бессрочно"}\n` +
        `Каналов и групп: ${plan.chats.length}\n\n` +
        "Тариф доступен для оплаты в Telegram Stars. Покупатель может отправить боту команду /buy ID_ТАРИФА."
      );
    } catch (error) {
      console.error("Control bot /createplan failed:", error);
      await ctx.reply("Не удалось создать тариф.");
    }
  });

  bot.command("plans", async (ctx) => {
    const projectId = String(ctx.match ?? "").trim();

    if (!projectId) {
      await ctx.reply("Формат: /plans PROJECT_ID");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const project = await canAccessProject(projectId, user.id, ["OWNER", "ADMIN", "MANAGER", "VIEWER"]);

      if (!project) {
        await ctx.reply("Проект не найден или у вас нет доступа.");
        return;
      }

      const plans = await prisma.creatorPlan.findMany({
        where: { projectId: project.id },
        include: { chats: { include: { connectedChat: true } } },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }]
      });

      if (plans.length === 0) {
        await ctx.reply("У проекта пока нет тарифов. Создайте первый: /createplan");
        return;
      }

      const lines = plans.map((plan, index) => {
        const duration = plan.durationDays ? `${plan.durationDays} дн.` : "без срока";
        const chats = plan.chats.filter((item) => item.connectedChat.isActive).length;
        return `${index + 1}. ${plan.title} — ${plan.price.toString()} ${plan.currency}\n` +
          `Статус: ${plan.status.toLowerCase()} · ${duration} · площадок: ${chats}\nID: ${plan.id}`;
      });

      await ctx.reply(`Тарифы проекта «${project.name}»:\n\n` + lines.join("\n\n"));
    } catch (error) {
      console.error("Control bot /plans failed:", error);
      await ctx.reply("Не удалось загрузить тарифы.");
    }
  });

  bot.command("chats", async (ctx) => {
    const projectId = String(ctx.match ?? "").trim();

    if (!projectId) {
      await ctx.reply("Формат: /chats PROJECT_ID");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const project = await canAccessProject(projectId, user.id, ["OWNER", "ADMIN", "MANAGER", "VIEWER"]);

      if (!project) {
        await ctx.reply("Проект не найден или у вас нет доступа.");
        return;
      }

      const chats = await prisma.connectedChat.findMany({
        where: { projectId: project.id },
        orderBy: [{ isActive: "desc" }, { createdAt: "asc" }]
      });

      if (chats.length === 0) {
        await ctx.reply("К проекту пока не подключены каналы или группы.");
        return;
      }

      const lines = chats.map((chat, index) =>
        `${index + 1}. ${chat.title ?? chat.username ?? "Без названия"}\n` +
        `${chat.type.toLowerCase()} · ${chat.isActive ? "активен" : "неактивен"}\nID: ${chat.id}`
      );

      await ctx.reply(
        `Площадки проекта «${project.name}»:\n\n` +
        lines.join("\n\n") +
        "\n\nНазначение тарифу: /linkchat PLAN_ID CHAT_ID"
      );
    } catch (error) {
      console.error("Control bot /chats failed:", error);
      await ctx.reply("Не удалось загрузить список площадок.");
    }
  });

  bot.command("linkchat", async (ctx) => {
    const input = String(ctx.match ?? "").trim();
    const splitAt = input.indexOf(" ");
    const planId = splitAt > 0 ? input.slice(0, splitAt) : "";
    const chatId = splitAt > 0 ? input.slice(splitAt + 1).trim() : "";

    if (!planId || !chatId) {
      await ctx.reply("Формат: /linkchat PLAN_ID CHAT_ID\nID площадок можно посмотреть командой /chats PROJECT_ID.");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const plan = await prisma.creatorPlan.findFirst({
        where: {
          id: planId,
          project: {
            workspace: {
              members: {
                some: { userId: user.id, role: { in: [...MANAGER_ROLES] } }
              }
            }
          }
        },
        select: { id: true, title: true, projectId: true }
      });

      if (!plan) {
        await ctx.reply("Тариф не найден или у вас нет прав управления.");
        return;
      }

      const chat = await prisma.connectedChat.findFirst({
        where: { id: chatId, projectId: plan.projectId, isActive: true },
        select: { id: true, title: true, username: true }
      });

      if (!chat) {
        await ctx.reply("Активная площадка с таким ID не найдена в проекте этого тарифа.");
        return;
      }

      await prisma.creatorPlanChat.upsert({
        where: {
          creatorPlanId_connectedChatId: {
            creatorPlanId: plan.id,
            connectedChatId: chat.id
          }
        },
        update: {},
        create: {
          creatorPlanId: plan.id,
          connectedChatId: chat.id
        }
      });

      await ctx.reply(
        `Площадка «${chat.title ?? chat.username ?? chat.id}» привязана к тарифу «${plan.title}».`
      );
    } catch (error) {
      console.error("Control bot /linkchat failed:", error);
      await ctx.reply("Не удалось привязать площадку к тарифу.");
    }
  });

  bot.command("unlinkchat", async (ctx) => {
    const input = String(ctx.match ?? "").trim();
    const splitAt = input.indexOf(" ");
    const planId = splitAt > 0 ? input.slice(0, splitAt) : "";
    const chatId = splitAt > 0 ? input.slice(splitAt + 1).trim() : "";

    if (!planId || !chatId) {
      await ctx.reply("Формат: /unlinkchat PLAN_ID CHAT_ID");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const plan = await prisma.creatorPlan.findFirst({
        where: {
          id: planId,
          project: {
            workspace: {
              members: {
                some: { userId: user.id, role: { in: [...MANAGER_ROLES] } }
              }
            }
          }
        },
        select: {
          id: true,
          title: true,
          chats: { select: { connectedChatId: true } }
        }
      });

      if (!plan) {
        await ctx.reply("Тариф не найден или у вас нет прав управления.");
        return;
      }

      const isLinked = plan.chats.some((link) => link.connectedChatId === chatId);
      if (!isLinked) {
        await ctx.reply("Эта площадка не привязана к выбранному тарифу.");
        return;
      }

      if (plan.chats.length <= 1) {
        await ctx.reply("У тарифа должна оставаться хотя бы одна площадка. Сначала привяжите другую через /linkchat.");
        return;
      }

      await prisma.creatorPlanChat.delete({
        where: {
          creatorPlanId_connectedChatId: {
            creatorPlanId: plan.id,
            connectedChatId: chatId
          }
        }
      });

      await ctx.reply(`Площадка отвязана от тарифа «${plan.title}».`);
    } catch (error) {
      console.error("Control bot /unlinkchat failed:", error);
      await ctx.reply("Не удалось отвязать площадку.");
    }
  });

  bot.command("payments", async (ctx) => {
    const projectId = String(ctx.match ?? "").trim();

    if (!projectId) {
      await ctx.reply("Формат: /payments PROJECT_ID");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const project = await canAccessProject(projectId, user.id, ["OWNER", "ADMIN", "MANAGER", "VIEWER"]);

      if (!project) {
        await ctx.reply("Проект не найден или у вас нет доступа.");
        return;
      }

      const payments = await prisma.payment.findMany({
        where: { projectId: project.id },
        include: {
          customer: true,
          subscription: { include: { plan: true } }
        },
        orderBy: { createdAt: "desc" },
        take: 20
      });

      if (payments.length === 0) {
        await ctx.reply("В этом проекте пока нет платежей.");
        return;
      }

      const lines = payments.map((payment, index) => {
        const customer = payment.customer.username
          ? `@${payment.customer.username}`
          : payment.customer.telegramUserId.toString();
        const plan = payment.subscription?.plan.title ?? "без тарифа";
        return `${index + 1}. ${plan} — ${payment.amount.toString()} ${payment.currency}\n` +
          `Статус: ${payment.status.toLowerCase()} · ${customer}\n` +
          `ID: ${payment.id}`;
      });

      await ctx.reply(`Последние платежи проекта «${project.name}»:\n\n` + lines.join("\n\n"));
    } catch (error) {
      console.error("Control bot /payments failed:", error);
      await ctx.reply("Не удалось загрузить историю платежей.");
    }
  });

  bot.command("refundpayment", async (ctx) => {
    const paymentId = String(ctx.match ?? "").trim();

    if (!paymentId) {
      await ctx.reply("Формат: /refundpayment PAYMENT_ID\nСписок платежей: /payments PROJECT_ID");
      return;
    }

    if (ctx.chat.type !== "private") {
      await ctx.reply("Возвраты можно оформлять только в личном чате с SubPilot.");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(user);

      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Возвратами могут управлять только владелец или администратор пространства.");
        return;
      }

      const payment = await prisma.payment.findFirst({
        where: {
          id: paymentId,
          project: { workspaceId: workspace.id }
        },
        include: {
          customer: true,
          subscription: true,
          project: {
            include: {
              bots: {
                where: { status: "ACTIVE" },
                orderBy: { createdAt: "desc" },
                take: 1
              }
            }
          }
        }
      });

      if (!payment) {
        await ctx.reply("Платёж не найден в активном пространстве.");
        return;
      }

      if (payment.provider !== "TELEGRAM_STARS" || payment.status !== "SUCCEEDED" || !payment.providerPaymentId) {
        await ctx.reply("Можно вернуть только подтверждённый платёж Telegram Stars.");
        return;
      }

      const projectBot = payment.project.bots[0];
      if (!projectBot) {
        await ctx.reply("Не найден активный бот проекта. Возврат не отправлен.");
        return;
      }

      const refundBot = new Bot(decryptSecret(projectBot.tokenEncrypted));
      const refunded = await refundBot.api.refundStarPayment(
        Number(payment.customer.telegramUserId),
        payment.providerPaymentId
      );

      if (!refunded) {
        await ctx.reply("Telegram не подтвердил возврат. Статус платежа не изменён.");
        return;
      }

      const grants = payment.subscriptionId
        ? await prisma.subscriptionAccessGrant.findMany({
            where: { subscriptionId: payment.subscriptionId },
            include: { connectedChat: true }
          })
        : [];

      const removalFailures: string[] = [];

      for (const grant of grants) {
        await refundBot.api.revokeChatInviteLink(
          grant.connectedChat.telegramChatId.toString(),
          grant.inviteLink
        ).catch(() => undefined);

        if (grant.joinedAt) {
          try {
            await refundBot.api.banChatMember(
              grant.connectedChat.telegramChatId.toString(),
              Number(payment.customer.telegramUserId)
            );
          } catch (error) {
            removalFailures.push(
              grant.connectedChat.title ?? grant.connectedChat.username ?? grant.connectedChat.telegramChatId.toString()
            );
            console.error(
              "Could not remove refunded subscriber from Telegram chat:",
              error instanceof Error ? error.name : "UnknownError"
            );
          }
        }
      }

      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: "REFUNDED", refundedAt: new Date() }
        });

        if (payment.subscriptionId) {
          await tx.subscription.update({
            where: { id: payment.subscriptionId },
            data: { status: "CANCELLED", cancelledAt: new Date() }
          });

          await tx.subscriptionAccessGrant.updateMany({
            where: { subscriptionId: payment.subscriptionId, revokedAt: null },
            data: { revokedAt: new Date() }
          });
        }
      });

      await ctx.reply(
        "Возврат Telegram Stars подтверждён.\n" +
        "Подписка отменена, ссылки приглашения отозваны." +
        (removalFailures.length > 0
          ? `\n\nБот не смог удалить участника из следующих площадок: ${removalFailures.join(", ")}. Удалите его вручную или выдайте боту право блокировать участников.`
          : "\nУчастник удалён из площадок, в которых он успел вступить.")
      );
    } catch (error) {
      console.error(
        "Control bot /refundpayment failed:",
        error instanceof Error ? error.name : "UnknownError"
      );
      await ctx.reply("Не удалось завершить возврат или синхронизировать его с SubPilot. Проверьте статус операции в Telegram.");
    }
  });

  bot.command("archiveplan", async (ctx) => {
    const planId = String(ctx.match ?? "").trim();

    if (!planId) {
      await ctx.reply("Формат: /archiveplan PLAN_ID");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const plan = await prisma.creatorPlan.findFirst({
        where: {
          id: planId,
          project: {
            workspaceId: workspace.id,
            workspace: {
              members: {
                some: { userId: user.id, role: { in: [...MANAGER_ROLES] } }
              }
            }
          }
        }
      });

      if (!plan) {
        await ctx.reply("Тариф не найден в активном пространстве или у вас нет прав.");
        return;
      }

      await prisma.creatorPlan.update({
        where: { id: plan.id },
        data: { status: "ARCHIVED" }
      });

      await ctx.reply(`Тариф «${plan.title}» перемещён в архив.`);
    } catch (error) {
      console.error("Control bot /archiveplan failed:", error);
      await ctx.reply("Не удалось архивировать тариф.");
    }
  });

  bot.command("restoreplan", async (ctx) => {
    const planId = String(ctx.match ?? "").trim();

    if (!planId) {
      await ctx.reply("Формат: /restoreplan PLAN_ID");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const plan = await prisma.creatorPlan.findFirst({
        where: {
          id: planId,
          project: {
            workspaceId: workspace.id,
            workspace: {
              members: {
                some: { userId: user.id, role: { in: [...MANAGER_ROLES] } }
              }
            }
          }
        }
      });

      if (!plan) {
        await ctx.reply("Тариф не найден в активном пространстве или у вас нет прав.");
        return;
      }

      await prisma.creatorPlan.update({
        where: { id: plan.id },
        data: { status: "ACTIVE" }
      });

      await ctx.reply(`Тариф «${plan.title}» восстановлен.`);
    } catch (error) {
      console.error("Control bot /restoreplan failed:", error);
      await ctx.reply("Не удалось восстановить тариф.");
    }
  });

  bot.command("connectbot", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) {
      await ctx.reply("Подключение ботов доступно только в личном чате с SubPilot.");
      return;
    }

    const projectId = String(ctx.match ?? "").trim();

    if (!projectId) {
      await ctx.reply(
        "Формат: /connectbot PROJECT_ID\n\n" +
        "После этого я попрошу прислать токен отдельным сообщением. " +
        "Не отправляйте токен в групповые чаты."
      );
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const project = await canAccessProject(projectId, user.id, MANAGER_ROLES);

      if (!project) {
        await ctx.reply("Проект не найден или у вас нет прав управлять им.");
        return;
      }

      pendingBotConnections.set(ctx.from.id, {
        projectId,
        expiresAt: Date.now() + BOT_TOKEN_TTL_MS
      });

      await ctx.reply(
        `Подключаем бота к проекту «${project.name}».\n\n` +
        "Теперь отправьте токен от @BotFather отдельным сообщением.\n" +
        "Сообщение с токеном будет удалено сразу после получения (если Telegram разрешит).\n" +
        "Ожидание действует 5 минут. Для отмены отправьте /cancel."
      );
    } catch (error) {
      console.error("Control bot /connectbot init failed:", error);
      await ctx.reply("Не удалось начать подключение. Попробуйте ещё раз.");
    }
  });

  bot.command("cancel", async (ctx) => {
    if (ctx.from) {
      pendingBotConnections.delete(ctx.from.id);
    }
    await ctx.reply("Текущая операция отменена.");
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    if (ctx.message.text.startsWith("/")) return;

    const pendingAction = pendingTextActions.get(ctx.from.id);
    if (pendingAction) {
      pendingTextActions.delete(ctx.from.id);
      const input = ctx.message.text.trim();

      if (pendingAction.kind === "new_project") {
        if (input.length < 2 || input.length > 80) {
          await ctx.reply("Название должно содержать от 2 до 80 символов. Нажмите «Новый проект» и попробуйте ещё раз.", {
            reply_markup: homeKeyboard()
          });
          return;
        }

        try {
          const user = await upsertTelegramUser(ctx);
          const { workspace, role } = await getActiveWorkspace(user);
          if (!MANAGER_ROLES.includes(role as typeof MANAGER_ROLES[number])) {
            await ctx.reply("У вас нет прав создавать проекты в этом пространстве.", { reply_markup: homeKeyboard() });
            return;
          }
          const slug = `${slugify(input)}-${randomUUID().slice(0, 6)}`;
          const project = await prisma.project.create({
            data: {
              workspaceId: workspace.id,
              creatorUserId: user.id,
              name: input,
              slug,
              defaultCurrency: "RUB",
              countryCode: "RU"
            }
          });
          await ctx.reply(`Проект «${project.name}» создан.`, {
            reply_markup: new InlineKeyboard().text("Открыть проект", `ui:project:${project.id}`).row().text("В главное меню", "ui:home")
          });
        } catch (error) {
          console.error("Button create project failed:", error instanceof Error ? error.name : "UnknownError");
          await ctx.reply("Не удалось создать проект. Попробуйте ещё раз.", { reply_markup: homeKeyboard() });
        }
        return;
      }

      if (pendingAction.kind === "new_agency") {
        if (input.length < 2 || input.length > 80) {
          await ctx.reply("Название агентства должно содержать от 2 до 80 символов.", { reply_markup: homeKeyboard() });
          return;
        }
        try {
          const user = await upsertTelegramUser(ctx);
          const slug = `agency-${slugify(input)}-${randomUUID().slice(0, 6)}`;
          const workspace = await prisma.workspace.create({
            data: {
              name: input,
              slug,
              type: "AGENCY",
              createdById: user.id,
              members: { create: { userId: user.id, role: "OWNER" } }
            }
          });
          await prisma.user.update({ where: { id: user.id }, data: { activeWorkspaceId: workspace.id } });
          await ctx.reply(`Агентство «${workspace.name}» создано и выбрано активным пространством.`, {
            reply_markup: homeKeyboard()
          });
        } catch (error) {
          console.error("Button create agency failed:", error instanceof Error ? error.name : "UnknownError");
          await ctx.reply("Не удалось создать агентство.", { reply_markup: homeKeyboard() });
        }
        return;
      }

      if (pendingAction.kind === "create_plan") {
        const fields = input.split("|").map((field) => field.trim());
        const [title, priceInput, durationInput] = fields;
        const price = priceInput?.replace(",", ".");
        const durationDays = Number(durationInput);

        if (fields.length !== 3 || !title || title.length > 80 || !price ||
            !/^\d{1,5}$/.test(price) || Number(price) < 1 || Number(price) > 10_000 ||
            !Number.isInteger(durationDays) || durationDays < 0 || durationDays > 3650) {
          await ctx.reply("Проверьте формат. Нужно: Название | Цена в Stars | Дней. Цена — 1–10 000, срок — 0–3650.", {
            reply_markup: new InlineKeyboard().text("Повторить", `ui:createplan:${pendingAction.projectId}`).row().text("В главное меню", "ui:home")
          });
          return;
        }

        try {
          const user = await upsertTelegramUser(ctx);
          const project = await canAccessProject(pendingAction.projectId, user.id, MANAGER_ROLES);
          if (!project) {
            await ctx.reply("Проект не найден или у вас нет прав.", { reply_markup: homeKeyboard() });
            return;
          }
          const activeChats = await prisma.connectedChat.findMany({
            where: { projectId: project.id, isActive: true },
            select: { id: true }
          });
          if (activeChats.length === 0) {
            await ctx.reply("Сначала добавьте бота проекта администратором хотя бы в один канал или группу.", {
              reply_markup: new InlineKeyboard().text("Подключить бота", `ui:connect:${project.id}`).row().text("К проекту", `ui:project:${project.id}`)
            });
            return;
          }
          const plan = await prisma.creatorPlan.create({
            data: {
              projectId: project.id,
              title,
              price,
              currency: "XTR",
              durationDays: durationDays === 0 ? null : durationDays,
              isRecurring: false,
              chats: { create: activeChats.map((chat) => ({ connectedChatId: chat.id })) }
            }
          });
          await ctx.reply(`Тариф «${plan.title}» создан за ${plan.price.toString()} ⭐.`, {
            reply_markup: new InlineKeyboard().text("Посмотреть тарифы", `ui:plans:${project.id}`).row().text("К проекту", `ui:project:${project.id}`)
          });
        } catch (error) {
          console.error("Button create plan failed:", error instanceof Error ? error.name : "UnknownError");
          await ctx.reply("Не удалось создать тариф.", { reply_markup: homeKeyboard() });
        }
        return;
      }

      if (pendingAction.kind === "edit_plan") {
        const fields = input.split("|").map((field) => field.trim());
        const [title, priceInput, durationInput] = fields;
        const price = priceInput?.replace(",", ".");
        const durationDays = Number(durationInput);

        if (fields.length !== 3 || !title || title.length > 80 || !price ||
            !/^\d{1,5}$/.test(price) || Number(price) < 1 || Number(price) > 10_000 ||
            !Number.isInteger(durationDays) || durationDays < 0 || durationDays > 3650) {
          await ctx.reply("Проверьте формат. Нужно: Название | Цена в Stars | Дней. Цена — 1–10 000, срок — 0–3650.", {
            reply_markup: new InlineKeyboard()
              .text("Повторить", `p:e:${pendingAction.projectId}:${pendingAction.planId}`)
              .row().text("В главное меню", "ui:home")
          });
          return;
        }

        try {
          const user = await upsertTelegramUser(ctx);
          const project = await canAccessProject(pendingAction.projectId, user.id, MANAGER_ROLES);
          if (!project) {
            await ctx.reply("Проект не найден или у вас нет прав.", { reply_markup: homeKeyboard() });
            return;
          }
          const plan = await prisma.creatorPlan.findFirst({
            where: { id: pendingAction.planId, projectId: project.id, status: "ACTIVE" }
          });
          if (!plan) {
            await ctx.reply("Активный тариф не найден. Возможно, он уже перемещён в архив.", {
              reply_markup: new InlineKeyboard().text("К тарифам", `ui:plans:${project.id}`)
            });
            return;
          }
          await prisma.creatorPlan.update({
            where: { id: plan.id },
            data: {
              title,
              price,
              durationDays: durationDays === 0 ? null : durationDays
            }
          });
          await ctx.reply("Тариф обновлён. Новая цена применяется к новым покупкам; уже созданные платежи не меняются.", {
            reply_markup: new InlineKeyboard()
              .text("Открыть тариф", `p:v:${project.id}:${plan.id}`)
              .row().text("К тарифам", `ui:plans:${project.id}`)
          });
        } catch (error) {
          console.error("Button edit plan failed:", error instanceof Error ? error.name : "UnknownError");
          await ctx.reply("Не удалось изменить тариф.", { reply_markup: homeKeyboard() });
        }
        return;
      }
    }

    const pending = pendingBotConnections.get(ctx.from.id);
    if (!pending) return;

    if (pending.expiresAt < Date.now()) {
      pendingBotConnections.delete(ctx.from.id);
      await ctx.reply("Время ожидания истекло. Запустите подключение бота заново.");
      return;
    }

    const botToken = ctx.message.text.trim();
    await ctx.deleteMessage().catch(() => undefined);

    if (!BOT_TOKEN_PATTERN.test(botToken)) {
      await ctx.reply("Это не похоже на токен Telegram-бота. Операция отменена; запустите /connectbot ещё раз.");
      pendingBotConnections.delete(ctx.from.id);
      return;
    }

    pendingBotConnections.delete(ctx.from.id);

    try {
      const user = await upsertTelegramUser(ctx);
      const project = await canAccessProject(pending.projectId, user.id, MANAGER_ROLES);

      if (!project) {
        await ctx.reply("Права на этот проект изменились. Запустите подключение заново.");
        return;
      }

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

      const publicApiUrl = (process.env.PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "");
      const webhookSecret = publicApiUrl ? randomBytes(32).toString("base64url") : null;
      const webhookSecretHash = webhookSecret
        ? createHash("sha256").update(webhookSecret).digest("hex")
        : null;

      const botData = {
        username: botInfo.username ?? null,
        displayName: botInfo.first_name,
        tokenEncrypted: encryptSecret(botToken),
        webhookSecretHash,
        status: "PENDING" as const,
        lastVerifiedAt: new Date()
      };

      let savedProjectBotId: string;

      if (existingBot) {
        const saved = await prisma.projectBot.update({
          where: { id: existingBot.id },
          data: botData
        });
        savedProjectBotId = saved.id;
      } else {
        const saved = await prisma.projectBot.create({
          data: {
            projectId: project.id,
            telegramBotId,
            ...botData
          }
        });
        savedProjectBotId = saved.id;
      }

      let webhookReady = false;

      if (webhookSecret && publicApiUrl) {
        const webhookUrl = `${publicApiUrl}/webhooks/telegram/${telegramBotId.toString()}`;
        const configured = await candidateBot.api.setWebhook(webhookUrl, {
          secret_token: webhookSecret,
          allowed_updates: ["my_chat_member", "message", "pre_checkout_query", "chat_member", "callback_query"]
        });

        if (!configured) {
          throw new Error("Telegram did not confirm webhook configuration.");
        }

        await candidateBot.api.setMyCommands([
          { command: "start", description: "Открыть меню подписок" }
        ]);

        await prisma.projectBot.update({
          where: { id: savedProjectBotId },
          data: { status: "ACTIVE" }
        });
        webhookReady = true;
      }

      await ctx.reply(
        "Бот проверен и сохранён.\n\n" +
        `Проект: ${project.name}\n` +
        `Бот: @${botInfo.username ?? botInfo.first_name}\n` +
        (webhookReady
          ? "Webhook настроен. Добавьте бота администратором в канал или группу. Покупатели смогут открыть @бот, посмотреть /plans и оплатить тариф командой /buy ID."
          : "Токен зашифрован и сохранён. Для автоматической работы укажите публичный HTTPS-адрес API в PUBLIC_API_URL и подключите webhook.")
      );

    } catch (error) {
      // Do not log the input message or token. Telegram error text is intentionally omitted.
      console.error("Control bot token verification failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось проверить бота. Убедитесь, что токен действителен, и повторите /connectbot.");
    }
  });

  bot.command("testnotifications", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) {
      await ctx.reply("Запустите тест в личном чате с центральным ботом SubPilot.");
      return;
    }

    try {
      await upsertTelegramUser(ctx);
      const samples = [
        "🧪 Тест 1/4 — Новый подписчик\nПроект: «Тестовый проект»\nПодписчик: Демо-покупатель\nТариф: «Тестовый тариф»\nОплата: 100 ⭐",
        "🧪 Тест 2/4 — До окончания 3 дня\nПроект: «Тестовый проект»\nТариф: «Тестовый тариф»\nОкончание: через 3 дня",
        "🧪 Тест 3/4 — До окончания 1 день\nПроект: «Тестовый проект»\nТариф: «Тестовый тариф»\nОкончание: завтра",
        "🧪 Тест 4/4 — Тариф завершён\nПроект: «Тестовый проект»\nТариф: «Тестовый тариф»\nДоступ: срок действия завершён"
      ];

      for (const sample of samples) {
        await ctx.api.sendMessage(ctx.chat.id, sample);
      }
    } catch (error) {
      console.error("Notification smoke test failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось отправить тестовые уведомления. Проверьте доступность Telegram Bot API.");
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "SubPilot — управление платными Telegram-сообществами.\n\n" +
      "/start — открыть кабинет\n" +
      "/newproject Название — создать проект\n" +
      "/projects — проекты активного пространства\n" +
      "/createagency Название — создать агентство\n" +
      "/invite [ROLE] — одноразовая ссылка для участника\n" +
      "/members — участники пространства\n" +
      "/removemember ID — удалить участника\n" +
      "/invites — активные приглашения\n" +
      "/revokeinvite ID — отозвать приглашение\n" +
      "/workspaces — список пространств\n" +
      "/switchworkspace ID — переключить пространство\n" +
      "/renameproject ID Название — переименовать проект\n" +
      "/archiveproject ID — архивировать проект\n" +
      "/restoreproject ID — восстановить проект\n" +
      "/createplan ID | Название | Цена | Дней — создать тариф\n" +
      "/plans ID — посмотреть тарифы\n" +
      "/payments ID — история платежей проекта\n" +
      "/testnotifications — отправить четыре тестовых уведомления себе\n" +
      "/refundpayment ID — вернуть платёж Stars\n" +
      "/chats ID — список каналов и групп проекта\n" +
      "/linkchat PLAN_ID CHAT_ID — привязать площадку к тарифу\n" +
      "/unlinkchat PLAN_ID CHAT_ID — отвязать площадку\n" +
      "/archiveplan ID — архивировать тариф\n" +
      "/restoreplan ID — восстановить тариф\n" +
      "/connectbot ID — подключить отдельного бота\n" +
      "/cancel — отменить текущую операцию"
    );
  });

  bot.catch((error) => {
    console.error("Unhandled SubPilot control-bot error:", error.error);
  });

  return bot;
}
