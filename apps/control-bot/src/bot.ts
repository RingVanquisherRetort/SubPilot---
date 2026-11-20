import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Bot, type Context } from "grammy";
import { prisma } from "@subpilot/database";
import { encryptSecret } from "@subpilot/security";

const MANAGER_ROLES = ["OWNER", "ADMIN", "MANAGER"] as const;
const ADMIN_ROLES = ["OWNER", "ADMIN"] as const;
const BOT_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{20,}$/;
const BOT_TOKEN_TTL_MS = 5 * 60 * 1000;

type TelegramUser = Awaited<ReturnType<typeof upsertTelegramUser>>;
type PendingBotConnection = {
  projectId: string;
  expiresAt: number;
};

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
    select: { id: true, name: true, workspaceId: true }
  });
}

export function createControlBot(token: string): Bot {
  const bot = new Bot(token);
  // Pending states are short-lived and intentionally kept in memory only.
  // A bot restart cancels a pending token submission; no secrets are persisted here.
  const pendingBotConnections = new Map<number, PendingBotConnection>();

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
        "Добро пожаловать в SubPilot!\n\n" +
        `Активное пространство: ${workspace.name}\n\n` +
        "Вы сможете управлять проектами, Telegram-ботами, подписками и монетизацией.\n\n" +
        "Основные команды:\n" +
        "/newproject Название — создать проект\n" +
        "/projects — список проектов\n" +
        "/workspaces — мои пространства\n" +
        "/createagency Название — создать агентство\n" +
        "/invite — пригласить участника\n" +
        "/help — помощь"
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

    const pending = pendingBotConnections.get(ctx.from.id);
    if (!pending) return;

    if (ctx.message.text.startsWith("/")) return;

    if (pending.expiresAt < Date.now()) {
      pendingBotConnections.delete(ctx.from.id);
      await ctx.reply("Время ожидания истекло. Запустите /connectbot ещё раз.");
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
          allowed_updates: ["my_chat_member"]
        });

        if (!configured) {
          throw new Error("Telegram did not confirm webhook configuration.");
        }

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
          ? "Webhook настроен. Теперь добавьте бота администратором в канал или группу — SubPilot обнаружит её автоматически."
          : "Токен зашифрован и сохранён. Для автоматической работы укажите публичный HTTPS-адрес API в PUBLIC_API_URL и подключите webhook.")
      );

    } catch (error) {
      // Do not log the input message or token. Telegram error text is intentionally omitted.
      console.error("Control bot token verification failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось проверить бота. Убедитесь, что токен действителен, и повторите /connectbot.");
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
      "/connectbot ID — подключить отдельного бота\n" +
      "/cancel — отменить текущую операцию"
    );
  });

  bot.catch((error) => {
    console.error("Unhandled SubPilot control-bot error:", error.error);
  });

  return bot;
}
