import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Bot, InputFile, InlineKeyboard, type Context } from "grammy";
import { prisma } from "@subpilot/database";
import { decryptSecret, encryptSecret } from "@subpilot/security";
import { buildWorkspaceInviteAcceptanceMessage } from "./invite-acceptance.js";
import {
  ADMIN_ROLES,
  MANAGER_ROLES,
  canInviteWorkspaceRole,
  type InvitableWorkspaceRole
} from "./workspace-permissions.js";
import { isPrivateControlChat } from "./private-control-context.js";
import { getAccessibleProject } from "./project-access-service.js";
import {
  ProjectMembershipError,
  listProjectMembers,
  removeProjectMemberAccess,
  setProjectMemberAccess
} from "./project-membership-service.js";
import {
  AgencyPortfolioError,
  assignAgencyProjectCreator,
  getAgencyPortfolio,
  unassignAgencyProjectCreator
} from "./agency-portfolio-service.js";
import {
  WorkspaceMembershipError,
  createWorkspaceInvite,
  listWorkspaceMembersForAdmin,
  removeWorkspaceMember,
  revokeWorkspaceInvite,
  setWorkspaceMemberRole
} from "./workspace-membership-service.js";
import { isPlatformAdminTelegramId } from "./platform-admin.js";
import { PlatformRefundError, requestPlatformPaymentRefund } from "./platform-refund-service.js";
import { parsePlatformPlanUpsertInput } from "./platform-plan-catalog.js";
import {
  PlatformPlanCatalogError,
  setPlatformPlanActive,
  upsertPlatformPlan
} from "./platform-plan-catalog-service.js";
import {
  parsePlatformProviderConnectionInput,
  parsePlatformProviderCredentials,
  type PlatformProviderConnectionInput
} from "./platform-provider-connection.js";
import {
  createPlatformProviderConnection,
  disablePlatformProviderConnection,
  PlatformProviderConnectionError,
  listPlatformProviderConnections,
  rotatePlatformProviderCredentials,
  verifyPlatformProviderConnection
} from "./platform-provider-connection-service.js";
import { platformProviderCredentialVerifiers } from "./platform-provider-verifiers.js";
import {
  grantManualSubscriptionAccess,
  grantTrialSubscriptionAccess,
  listActiveProjectSubscriptions,
  ManualSubscriptionAccessError,
  revokeSubscriptionAccessManually
} from "./manual-subscription-access-service.js";
import { parseWorkspacePlanFeatureConfig } from "./workspace-plan-limits.js";
import {
  formatWorkspaceBillingOverview,
  getWorkspaceBillingOverview
} from "./workspace-billing-service.js";
import {
  listWorkspaceFailedAccessDeliveries,
  retryWorkspaceFailedAccessDelivery
} from "./workspace-access-delivery-service.js";
import {
  getProjectAnalytics,
  listProjectAuditHistory
} from "./project-analytics-service.js";
import {
  AgencyAuditError,
  exportAgencyAuditHistory,
  listAgencyAuditHistory
} from "./agency-audit-service.js";
import {
  assertWorkspaceQuotaInTransaction,
  formatWorkspaceQuotaError,
  isWorkspaceQuotaRestriction,
  lockWorkspace,
  withWorkspaceQuotaTransaction
} from "./workspace-quota-enforcement.js";
import {
  classifyTelegramRefundError,
  listPaymentProviderAvailability,
  recalculateSubscriptionPeriod,
  type CreatorMerchantType
} from "@subpilot/payments";

const BOT_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{20,}$/;
const BOT_TOKEN_TTL_MS = 5 * 60 * 1000;
const TEXT_ACTION_TTL_MS = 5 * 60 * 1000;
const REFUND_RETRY_LOCK_MS = 2 * 60 * 1000;

function paymentStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    CREATED: "создаётся",
    PENDING: "ожидает оплаты",
    SUCCEEDED: "оплачен",
    REFUNDING: "возврат обрабатывается",
    FAILED: "ошибка оплаты",
    CANCELLED: "отменён",
    REFUNDED: "возвращён"
  };
  return labels[status] ?? status.toLowerCase();
}
const MERCHANT_TYPE_CHOICES = [
  { key: "PERSON", value: "INDIVIDUAL", label: "Физическое лицо" },
  { key: "SELF", value: "SELF_EMPLOYED", label: "Самозанятый" },
  { key: "IP", value: "INDIVIDUAL_ENTREPRENEUR", label: "Индивидуальный предприниматель" },
  { key: "LEGAL", value: "LEGAL_ENTITY", label: "Юридическое лицо" }
] as const;
const MERCHANT_TYPE_LABELS: Record<CreatorMerchantType, string> = {
  INDIVIDUAL: "Физическое лицо",
  SELF_EMPLOYED: "Самозанятый",
  INDIVIDUAL_ENTREPRENEUR: "Индивидуальный предприниматель",
  LEGAL_ENTITY: "Юридическое лицо"
};

type TelegramUser = Awaited<ReturnType<typeof upsertTelegramUser>>;
type PendingBotConnection = {
  projectId: string;
  expiresAt: number;
};

type PendingPlatformProviderSecret =
  | { kind: "CREATE"; connection: PlatformProviderConnectionInput; expiresAt: number }
  | { kind: "ROTATE"; connectionId: string; expiresAt: number };

type PendingTextActionInput =
  | { kind: "new_project" }
  | { kind: "new_agency" }
  | { kind: "create_plan"; projectId: string }
  | { kind: "edit_plan"; projectId: string; planId: string };

type PendingTextAction = PendingTextActionInput & { expiresAt: number };

function homeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📁 Мои проекты", "ui:projects")
    .text("🏢 Пространства", "ui:workspaces")
    .row()
    .text("➕ Новый проект", "ui:newproject")
    .text("🏬 Создать агентство", "ui:newagency")
    .row()
    .text("👥 Команда", "ui:team")
    .text("❔ Помощь", "ui:help")
    .row()
    .text("💳 Тариф пространства", "ui:billing");
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
  return getAccessibleProject(projectId, userId, roles);
}

export function createControlBot(token: string): Bot {
  const bot = new Bot(token);
  // Pending states are short-lived and intentionally kept in memory only.
  // A bot restart cancels a pending token submission; no secrets are persisted here.
  const pendingBotConnections = new Map<number, PendingBotConnection>();
  const pendingTextActions = new Map<number, PendingTextAction>();
  const pendingPlatformProviderSecrets = new Map<number, PendingPlatformProviderSecret>();

  const setPendingTextAction = (userId: number, action: PendingTextActionInput): void => {
    pendingBotConnections.delete(userId);
    pendingPlatformProviderSecrets.delete(userId);
    pendingTextActions.set(userId, {
      ...action,
      expiresAt: Date.now() + TEXT_ACTION_TTL_MS
    });
  };

  const setPendingBotConnection = (userId: number, projectId: string): void => {
    pendingTextActions.delete(userId);
    pendingPlatformProviderSecrets.delete(userId);
    pendingBotConnections.set(userId, {
      projectId,
      expiresAt: Date.now() + BOT_TOKEN_TTL_MS
    });
  };

  // The control bot is a private workspace console. Never expose workspace
  // members, payment history, invitation URLs or admin actions in group chats.
  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    if (!isPrivateControlChat(chat?.type)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({
          text: "Управление SubPilot доступно только в личном чате с ботом.",
          show_alert: true
        }).catch(() => undefined);
      } else if (chat && ctx.message && "text" in ctx.message && ctx.message.text.startsWith("/")) {
        await ctx.reply("Для безопасности используйте управляющего бота SubPilot только в личном чате.")
          .catch(() => undefined);
      }
      return;
    }
    await next();
  });

  bot.callbackQuery("ui:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const { workspace, role } = await getActiveWorkspace(user);
    await ctx.editMessageText(
      `🚀 SubPilot\n\nПространство: ${workspace.name}\nРоль: ${String(role).toLowerCase()}\n\nВыберите действие:`,
      { reply_markup: homeKeyboard() }
    );
  });

  bot.callbackQuery("ui:billing", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const overview = await getWorkspaceBillingOverview(workspace.id);
      if (!overview) {
        await ctx.editMessageText(
          "Рабочее пространство не найдено.",
          { reply_markup: backHomeKeyboard() }
        );
        return;
      }
      await ctx.editMessageText(
        formatWorkspaceBillingOverview(overview),
        {
          reply_markup: new InlineKeyboard()
            .text("🔄 Обновить", "ui:billing")
            .row()
            .text("⬅️ В главное меню", "ui:home")
        }
      );
    } catch (error) {
      console.error("Control bot workspace billing overview failed:", error);
      await ctx.reply("Не удалось загрузить сведения о тарифе пространства.");
    }
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
    if (!canInviteWorkspaceRole(actorRole, requestedRole)) {
      await ctx.reply("У вас нет прав назначить эту роль.");
      return;
    }
    const created = await createWorkspaceInvite({
      workspaceId: workspace.id,
      actorUserId: user.id,
      requestedRole
    });
    const botInfo = await ctx.api.getMe();
    const inviteLink = `https://t.me/${botInfo.username}?start=join_${created.token}`;
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
    const { workspace, role } = await getActiveWorkspace(user);
    const canManageWorkspace = MANAGER_ROLES.includes(role as typeof MANAGER_ROLES[number]);
    const projectScope = workspace.type === "AGENCY" && !ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])
      ? { OR: [
          { creatorUserId: user.id },
          { members: { some: { userId: user.id } } }
        ] }
      : {};
    const projects = await prisma.project.findMany({
      where: { workspaceId: workspace.id, status: { not: "ARCHIVED" }, ...projectScope },
      orderBy: { createdAt: "desc" },
      take: 30
    });

    const keyboard = new InlineKeyboard();
    for (const project of projects) {
      keyboard.text(project.name.slice(0, 30), `ui:project:${project.id}`).row();
    }
    if (canManageWorkspace) {
      keyboard.text("➕ Создать проект", "ui:newproject").row();
      if (workspace.type === "AGENCY") {
        keyboard.text("👥 Портфель авторов", "ui:agencyportfolio").row();
      }
    }
    keyboard.text("⬅️ Назад", "ui:home");

    await ctx.editMessageText(
      projects.length
        ? `Проекты пространства «${workspace.name}»:\nВыберите проект:`
        : `В пространстве «${workspace.name}» пока нет проектов. Создайте первый:`,
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery("ui:agencyportfolio", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const portfolio = await getAgencyPortfolio({
        workspaceId: workspace.id,
        actorUserId: user.id
      });
      const sections = portfolio.creators.map((creator) =>
        "👤 " + creator.name + " · " + creator.projects.length + " проект(ов)\n" +
        creator.projects.map((project) =>
          "  • " + project.name + " — " + project.status.toLowerCase() + "\n    ID: " + project.id
        ).join("\n")
      );
      if (portfolio.unassignedProjects.length) {
        sections.push(
          "⚪ Без ответственного автора · " + portfolio.unassignedProjects.length + " проект(ов)\n" +
          portfolio.unassignedProjects.map((project) =>
            "  • " + project.name + " — " + project.status.toLowerCase() + "\n    ID: " + project.id
          ).join("\n")
        );
      }
      await ctx.editMessageText(
        "Портфель агентства «" + portfolio.workspaceName + "»\n\n" +
        "Проектов: " + portfolio.totalProjects + "\n" +
        "Назначено авторам: " + portfolio.assignedProjects + "\n" +
        "Без автора: " + portfolio.unassignedProjects.length + "\n\n" +
        (sections.join("\n\n") || "Пока нет проектов."),
        { reply_markup: new InlineKeyboard().text("📁 К проектам", "ui:projects").row().text("⬅️ В главное меню", "ui:home") }
      );
    } catch (error) {
      if (error instanceof AgencyPortfolioError) {
        const messages: Record<string, string> = {
          NOT_AN_AGENCY: "Портфель авторов доступен только в пространстве типа «Агентство».",
          PERMISSION_DENIED: "Портфель доступен владельцу, администратору и менеджеру агентства.",
          ACTOR_NOT_MEMBER: "У вас больше нет доступа к этому агентству."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось загрузить портфель агентства.");
      } else {
        console.error("Control bot agency portfolio callback failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось загрузить портфель агентства.");
      }
    }
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
      await ctx.reply("У вас больше нет доступа к этому пространству.");
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
    setPendingTextAction(ctx.from.id, { kind: "new_project" });
    await ctx.reply("Напишите название нового проекта одним сообщением. Для отмены нажмите кнопку:", {
      reply_markup: new InlineKeyboard().text("Отмена", "ui:cancel")
    });
  });

  bot.callbackQuery("ui:newagency", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    setPendingTextAction(ctx.from.id, { kind: "new_agency" });
    await ctx.reply("Напишите название агентства одним сообщением:", {
      reply_markup: new InlineKeyboard().text("Отмена", "ui:cancel")
    });
  });

  bot.callbackQuery("ui:cancel", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Операция отменена." });
    if (ctx.from) {
      pendingTextActions.delete(ctx.from.id);
      pendingBotConnections.delete(ctx.from.id);
      pendingPlatformProviderSecrets.delete(ctx.from.id);
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
    const canManageProject = MANAGER_ROLES.includes(project.accessRole as typeof MANAGER_ROLES[number]);
    const keyboard = new InlineKeyboard();
    if (canManageProject) {
      keyboard.text("🤖 Подключить бота", `ui:connect:${projectId}`).row();
    }
    keyboard.text("💎 Тарифы", `ui:plans:${projectId}`);
    if (canManageProject) {
      keyboard.text("➕ Создать тариф", `ui:createplan:${projectId}`);
    }
    keyboard.row()
      .text("📣 Каналы и группы", `ui:chats:${projectId}`)
      .row();
    if (canManageProject) {
      keyboard.text("💳 Способы оплаты", `ui:payment-methods:${projectId}`).row();
    }
    if (project.workspaceType === "AGENCY" && ADMIN_ROLES.includes(project.accessRole as typeof ADMIN_ROLES[number])) {
      keyboard.text("👥 Доступ к проекту", `ui:projectmembers:${projectId}`).row();
    }
    keyboard.text("📊 История платежей", `ui:payments:${projectId}`)
      .row()
      .text("⬅️ К проектам", "ui:projects");
    await ctx.editMessageText(
      `📁 ${project.name}\nАвтор: ${[project.creatorUser?.firstName, project.creatorUser?.lastName].filter(Boolean).join(" ") || (project.creatorUser?.username ? "@" + project.creatorUser.username : "не назначен")}\n\nБоты: ${botCount}\nАктивные площадки: ${chatCount}\nАктивные тарифы: ${planCount}\n\nВыберите раздел:`,
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^ui:projectmembers:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const projectId = ctx.match[1];
    if (!projectId) return;
    try {
      const user = await upsertTelegramUser(ctx);
      const project = await canAccessProject(projectId, user.id, ADMIN_ROLES);
      if (!project || project.workspaceType !== "AGENCY") {
        await ctx.reply("Управлять доступом к проекту могут только OWNER/ADMIN агентства.");
        return;
      }
      const directory = await listProjectMembers({
        workspaceId: project.workspaceId, actorUserId: user.id, projectId
      });
      const rows = [
        directory.creator
          ? "Ответственный автор: " + directory.creator.name + " · MANAGER · ID " + directory.creator.telegramId
          : "Ответственный автор: не назначен",
        ...directory.members.map((member) => member.name + " · " + member.role + " · ID " + member.telegramId)
      ];
      await ctx.editMessageText(
        "Доступ к проекту «" + directory.projectName + "»\n\n" +
        "OWNER/ADMIN агентства имеют полный доступ. Назначенный автор автоматически имеет MANAGER только в этом проекте.\n\n" +
        rows.join("\n") +
        "\n\n/setprojectmember PROJECT_ID TELEGRAM_ID MANAGER|VIEWER\n/removeprojectmember PROJECT_ID TELEGRAM_ID",
        { reply_markup: new InlineKeyboard().text("⬅️ К проекту", "ui:project:" + projectId).row().text("К проектам", "ui:projects") }
      );
    } catch (error) {
      console.error("Project member directory failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось загрузить доступ к проекту.");
    }
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
    setPendingBotConnection(ctx.from.id, projectId);
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
    const canManageProject = MANAGER_ROLES.includes(project.accessRole as typeof MANAGER_ROLES[number]);
    const keyboard = new InlineKeyboard();
    for (const plan of plans) {
      keyboard.text(
        `${plan.title.slice(0, 26)} · ${plan.price.toString()} ⭐`,
        `p:v:${projectId}:${plan.id}`
      ).row();
    }
    if (canManageProject) {
      keyboard.text("➕ Создать тариф", `ui:createplan:${projectId}`).row()
        .text("🗄 Архив тарифов", `ui:archivedplans:${projectId}`).row();
    }
    keyboard.text("⬅️ К проекту", `ui:project:${projectId}`);
    await ctx.editMessageText(
      plans.length
        ? `Активные тарифы «${project.name}»:\nВыберите тариф для управления:`
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
      plans.length ? `Архив тарифов «${project.name}»:\nВыберите тариф для восстановления:` : "Архив пуст.",
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
    const canManageProject = MANAGER_ROLES.includes(project.accessRole as typeof MANAGER_ROLES[number]);
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
    if (canManageProject) {
      if (plan.status === "ACTIVE") {
        keyboard.text("✏️ Изменить тариф", `p:e:${projectId}:${planId}`).row()
          .text("🗄 В архив", `p:x:${projectId}:${planId}`);
      } else {
        keyboard.text("↩️ Восстановить", `p:r:${projectId}:${planId}`);
      }
      keyboard.row()
        .text("📣 Настроить площадки", `p:ch:${planId}`)
        .row();
    }
    keyboard.text(plan.status === "ACTIVE" ? "⬅️ К активным" : "⬅️ К архиву",
      plan.status === "ACTIVE" ? `ui:plans:${projectId}` : `ui:archivedplans:${projectId}`)
      .text("К проекту", `ui:project:${projectId}`);

    await ctx.editMessageText(
      `💎 ${plan.title}\n\n` +
      `Цена: ${plan.price.toString()} ⭐\n` +
      `Срок: ${duration}\n` +
      `Статус: ${plan.status === "ACTIVE" ? "Активен" : "В архиве"}\n` +
      `Площадок: ${plan._count.chats}\n` +
      `Подписок всего: ${plan._count.subscriptions}\n\n` +
      `Каналы и группы:\n${chatNames.join("\n") || "Не привязаны"}\n\n` +
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
    const project = plan
      ? await canAccessProject(plan.projectId, user.id, ["OWNER", "ADMIN", "MANAGER", "VIEWER"])
      : null;
    const canManageProject = Boolean(project && MANAGER_ROLES.includes(project.accessRole as typeof MANAGER_ROLES[number]));
    if (!plan || !project) {
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
        canManageProject ? `p:ct:${planId}:${chat.id}` : `p:v:${plan.projectId}:${planId}`
      ).row();
    }
    keyboard.text("⬅️ К тарифу", `p:v:${plan.projectId}:${planId}`);
    await ctx.editMessageText(
      chats.length
        ? "Каналы и группы тарифа. Нажмите на площадку, чтобы привязать или отвязать её:\n\n✅ — доступ включён в тариф\n➕ — нажмите, чтобы добавить"
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
      "Площадки тарифа обновлены. Нажмите на площадку, чтобы изменить выбор:\n\n✅ — доступ включён в тариф\n➕ — нажмите, чтобы добавить",
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
    setPendingTextAction(ctx.from.id, { kind: "edit_plan", projectId, planId });
    await ctx.reply(
      `Изменяем тариф «${plan.title}». Отправьте новые данные в формате:\nНазвание | Цена в Stars | Дней\n\nТекущие данные: ${plan.title} | ${plan.price.toString()} | ${plan.durationDays ?? 0}`,
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
    let result;
    try {
      result = await withWorkspaceQuotaTransaction(
        project.workspaceId,
        "plansPerProject",
        (tx) => tx.creatorPlan.updateMany({
          where: { id: planId, projectId, status: "ARCHIVED" },
          data: { status: "ACTIVE" }
        }),
        projectId
      );
    } catch (error) {
      await ctx.reply(formatWorkspaceQuotaError(error));
      return;
    }
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
    setPendingTextAction(ctx.from.id, { kind: "create_plan", projectId });
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
      lines.length ? `Каналы и группы «${project.name}»:\n\n${lines.join("\n")}\n\nДля активности боту нужны права приглашать пользователей и ограничивать участников. Неактивная площадка также может означать, что достигнут лимит тарифа пространства. Проверьте раздел «Тариф пространства».` : "Пока нет подключённых каналов или групп. Добавьте бота проекта администратором с правами приглашать пользователей и ограничивать участников.",
      { reply_markup: backHomeKeyboard() }
    );
  });


  bot.callbackQuery(/^ui:payment-methods:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const projectId = ctx.match[1];
    if (!projectId) return;
    const project = await canAccessProject(projectId, user.id, MANAGER_ROLES);
    if (!project) {
      await ctx.reply("Настройки способов оплаты доступны владельцу, администратору или менеджеру проекта.");
      return;
    }

    const options = listPaymentProviderAvailability({
      countryCode: project.countryCode,
      merchantType: project.merchantType,
      productType: "TELEGRAM_CHANNEL_ACCESS",
      surface: "TELEGRAM_BOT",
      telegramTpaRelated: true
    });
    const enabled = options.filter((option) => option.available);
    const enabledLines = enabled.map((option) => `✅ ${option.title}`);
    const profileLabel = MERCHANT_TYPE_LABELS[project.merchantType];

    const keyboard = new InlineKeyboard()
      .text("👤 Изменить статус автора", `ui:merchant-type:${projectId}`)
      .row()
      .text("⬅️ К проекту", `ui:project:${projectId}`);

    await ctx.editMessageText(
      `💳 Способы оплаты проекта «${project.name}»\n\n` +
      `Профиль автора: ${profileLabel}\n\n` +
      `Для платного доступа к Telegram-каналам и группам сейчас доступно:\n` +
      `${enabledLines.join("\n") || "Пока нет доступных способов оплаты."}\n\n` +
      "Для цифрового доступа, продаваемого через Telegram-бота, Telegram требует оплату Stars. " +
      "Внешние провайдеры и ручные переводы нельзя включать в этот сценарий.\n\n" +
      "Статус автора нужен для подбора будущих интеграций. Он не заменяет проверку и одобрение со стороны платёжного провайдера.",
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^ui:merchant-type:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const projectId = ctx.match[1];
    if (!projectId) return;
    const project = await canAccessProject(projectId, user.id, MANAGER_ROLES);
    if (!project) {
      await ctx.reply("Изменять профиль автора могут только владелец или менеджер проекта.");
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const choice of MERCHANT_TYPE_CHOICES) {
      const selected = project.merchantType === choice.value ? " ✓" : "";
      keyboard.text(
        `${choice.label}${selected}`.slice(0, 60),
        `ui:merchant:${projectId}:${choice.key}`
      ).row();
    }
    keyboard.text("⬅️ Назад", `ui:payment-methods:${projectId}`);

    await ctx.editMessageText(
      "Укажите статус автора проекта. Он используется только для подбора подходящих способов оплаты. " +
      "Провайдер отдельно проверяет владельца аккаунта и принимает решение о подключении.\n\n" +
      `Текущий статус: ${MERCHANT_TYPE_LABELS[project.merchantType]}`,
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^ui:merchant:([^:]+):(PERSON|SELF|IP|LEGAL)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await upsertTelegramUser(ctx);
    const projectId = ctx.match[1];
    const key = ctx.match[2];
    if (!projectId || !key) return;
    const project = await canAccessProject(projectId, user.id, MANAGER_ROLES);
    if (!project) {
      await ctx.reply("Изменять профиль автора могут только владелец или менеджер проекта.");
      return;
    }
    const choice = MERCHANT_TYPE_CHOICES.find((item) => item.key === key);
    if (!choice) {
      await ctx.reply("Неизвестный статус автора.");
      return;
    }

    await prisma.project.updateMany({
      where: { id: projectId },
      data: { merchantType: choice.value }
    });
    await ctx.editMessageText(
      `Статус автора обновлён: ${choice.label}.\n\nЭтот выбор помогает подобрать способы оплаты, но не заменяет проверку платёжного провайдера.`,
      {
        reply_markup: new InlineKeyboard()
          .text("💳 Способы оплаты", `ui:payment-methods:${projectId}`)
          .row()
          .text("⬅️ К проекту", `ui:project:${projectId}`)
      }
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
      `${i + 1}. ${payment.subscription?.plan.title ?? "Платёж"} — ${payment.amount.toString()} ${payment.currency}\nСтатус: ${paymentStatusLabel(payment.status)} · ${payment.customer.username ? "@" + payment.customer.username : payment.customer.telegramUserId.toString()}\nID: ${payment.id}`
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

          await lockWorkspace(tx, invite.workspaceId);
          const existingMembership = await tx.workspaceMember.findUnique({
            where: {
              workspaceId_userId: {
                workspaceId: invite.workspaceId,
                userId: user.id
              }
            },
            select: { id: true }
          });
          if (!existingMembership) {
            await assertWorkspaceQuotaInTransaction(tx, invite.workspaceId, "members");
          }
          const membership = await tx.workspaceMember.upsert({
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
            },
            select: { role: true }
          });

          await tx.user.update({
            where: { id: user.id },
            data: { activeWorkspaceId: invite.workspaceId }
          });

          return { role: membership.role, wasAlreadyMember: Boolean(existingMembership) };
        });

        if (!accepted) {
          await ctx.reply("Это приглашение уже было использовано. Попросите владельца создать новое.");
          return;
        }

        await ctx.reply(buildWorkspaceInviteAcceptanceMessage(
          invite.workspace.name,
          accepted.role,
          accepted.wasAlreadyMember
        ));
        return;
      }

      const { workspace } = await getActiveWorkspace(user);

      await ctx.reply(
        `🚀 Добро пожаловать в SubPilot!\n\nАктивное пространство: ${workspace.name}\n\nВыберите нужный раздел кнопками ниже.`,
        { reply_markup: homeKeyboard() }
      );
    } catch (error) {
      console.error("Control bot /start failed:", error);
      await ctx.reply(
        isWorkspaceQuotaRestriction(error)
          ? formatWorkspaceQuotaError(error)
          : "Не удалось открыть рабочее пространство. Попробуйте ещё раз позже."
      );
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
      const project = await withWorkspaceQuotaTransaction(
        workspace.id,
        "projects",
        (tx) => tx.project.create({
          data: {
            workspaceId: workspace.id,
            creatorUserId: user.id,
            name,
            slug,
            defaultCurrency: "RUB",
            countryCode: "RU"
          }
        })
      );

      await ctx.reply(
        `Проект «${project.name}» создан в пространстве «${workspace.name}».\n\n` +
        `ID проекта: ${project.id}\n\n` +
        "Чтобы подключить отдельного бота, используйте /connectbot и отправьте ID проекта."
      );
    } catch (error) {
      console.error("Control bot /newproject failed:", error);
      await ctx.reply(formatWorkspaceQuotaError(error));
    }
  });

  bot.command("projectmembers", async (ctx) => {
    const projectId = String(ctx.match ?? "").trim();
    if (!projectId) {
      await ctx.reply("Формат: /projectmembers PROJECT_ID");
      return;
    }
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const directory = await listProjectMembers({
        workspaceId: workspace.id, actorUserId: user.id, projectId
      });
      const rows = [
        directory.creator ? "Ответственный автор: " + directory.creator.name + " · MANAGER" : "Ответственный автор: не назначен",
        ...directory.members.map((member) => member.name + " · " + member.role + " · Telegram ID " + member.telegramId)
      ];
      await ctx.reply(
        "Доступ к проекту «" + directory.projectName + "»:\n\n" +
        rows.join("\n") +
        "\n\n/setprojectmember PROJECT_ID TELEGRAM_ID MANAGER|VIEWER\n/removeprojectmember PROJECT_ID TELEGRAM_ID"
      );
    } catch (error) {
      if (error instanceof ProjectMembershipError) {
        await ctx.reply(error.code === "PERMISSION_DENIED"
          ? "Список проектной команды доступен только OWNER/ADMIN агентства."
          : "Проект не найден в активном агентстве.");
      } else {
        console.error("/projectmembers failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось загрузить проектную команду.");
      }
    }
  });

  bot.command("setprojectmember", async (ctx) => {
    const fields = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const projectId = fields[0] ?? "";
    const telegramId = fields[1] ?? "";
    const role = (fields[2] ?? "").toUpperCase();
    if (fields.length !== 3 || !projectId || !/^\d{1,20}$/.test(telegramId) ||
        !["MANAGER", "VIEWER"].includes(role)) {
      await ctx.reply("Формат: /setprojectmember PROJECT_ID TELEGRAM_ID [MANAGER|VIEWER]");
      return;
    }
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const result = await setProjectMemberAccess({
        workspaceId: workspace.id,
        actorUserId: user.id,
        projectId,
        targetTelegramId: telegramId,
        role: role as "MANAGER" | "VIEWER"
      });
      await ctx.reply(result.changed
        ? "Доступ к проекту «" + result.projectName + "» для " + result.memberName +
          " установлен: " + (result.previousRole ?? "нет доступа") + " → " + result.role + "."
        : "У " + result.memberName + " уже установлена роль " + result.role + ".");
    } catch (error) {
      if (error instanceof ProjectMembershipError) {
        const messages: Record<string, string> = {
          NOT_AN_AGENCY: "Проектные роли доступны только в агентствах.",
          ACTOR_NOT_MEMBER: "У вас больше нет доступа к агентству.",
          PERMISSION_DENIED: "Назначать проектные роли могут только OWNER/ADMIN агентства.",
          PROJECT_NOT_FOUND: "Проект не найден или находится в архиве.",
          MEMBER_NOT_FOUND: "Пользователь не является участником этого агентства.",
          CREATOR_HAS_MANAGER_ACCESS: "Ответственный автор автоматически имеет MANAGER. Сначала измените или снимите назначение автора."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось назначить доступ.");
      } else {
        console.error("/setprojectmember failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось назначить доступ к проекту.");
      }
    }
  });

  bot.command("removeprojectmember", async (ctx) => {
    const fields = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const projectId = fields[0] ?? "";
    const telegramId = fields[1] ?? "";
    if (fields.length !== 2 || !projectId || !/^\d{1,20}$/.test(telegramId)) {
      await ctx.reply("Формат: /removeprojectmember PROJECT_ID TELEGRAM_ID");
      return;
    }
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const result = await removeProjectMemberAccess({
        workspaceId: workspace.id, actorUserId: user.id, projectId, targetTelegramId: telegramId
      });
      await ctx.reply(result.removed
        ? "Доступ " + result.role + " для " + result.memberName + " к проекту «" + result.projectName + "» снят."
        : "У " + result.memberName + " нет отдельного доступа к этому проекту.");
    } catch (error) {
      if (error instanceof ProjectMembershipError) {
        const messages: Record<string, string> = {
          NOT_AN_AGENCY: "Проектные роли доступны только в агентствах.",
          ACTOR_NOT_MEMBER: "У вас больше нет доступа к агентству.",
          PERMISSION_DENIED: "Менять проектные роли могут только OWNER/ADMIN агентства.",
          PROJECT_NOT_FOUND: "Проект не найден.",
          MEMBER_NOT_FOUND: "Пользователь не является участником этого агентства.",
          CREATOR_HAS_MANAGER_ACCESS: "Нельзя снять доступ с назначенного автора. Сначала измените или снимите назначение автора."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось снять доступ.");
      } else {
        console.error("/removeprojectmember failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось снять доступ к проекту.");
      }
    }
  });

  bot.command("projects", async (ctx) => {
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(user);
      const projectScope = workspace.type === "AGENCY" && !ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])
        ? { OR: [
            { creatorUserId: user.id },
            { members: { some: { userId: user.id } } }
          ] }
        : {};
      const projects = await prisma.project.findMany({
        where: { workspaceId: workspace.id, ...projectScope },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          status: true,
          bots: { select: { username: true, status: true } },
          creatorUser: { select: { firstName: true, lastName: true, username: true } }
        }
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
        const creatorName = [project.creatorUser?.firstName, project.creatorUser?.lastName].filter(Boolean).join(" ") || (project.creatorUser?.username ? "@" + project.creatorUser.username : "не назначен");
        return `${index + 1}. ${project.name} — ${project.status.toLowerCase()}\nАвтор: ${creatorName}\nID: ${project.id}\n${botInfo}`;
      });

      await ctx.reply(`Проекты пространства «${workspace.name}»:\n\n` + lines.join("\n\n"));
    } catch (error) {
      console.error("Control bot /projects failed:", error);
      await ctx.reply("Не удалось загрузить проекты. Попробуйте ещё раз позже.");
    }
  });

  bot.command("agencyportfolio", async (ctx) => {
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const portfolio = await getAgencyPortfolio({
        workspaceId: workspace.id,
        actorUserId: user.id
      });
      const sections = portfolio.creators.map((creator) =>
        "👤 " + creator.name + " · " + creator.projects.length + " проект(ов)\n" +
        creator.projects.map((project) =>
          "• " + project.name + " — " + project.status.toLowerCase() + " · " + project.id
        ).join("\n")
      );
      if (portfolio.unassignedProjects.length) {
        sections.push(
          "Без ответственного автора · " + portfolio.unassignedProjects.length + "\n" +
          portfolio.unassignedProjects.map((project) =>
            "• " + project.name + " — " + project.status.toLowerCase() + " · " + project.id
          ).join("\n")
        );
      }
      await ctx.reply(
        "Портфель агентства «" + portfolio.workspaceName + "»\n\n" +
        "Проектов: " + portfolio.totalProjects + " · назначено: " + portfolio.assignedProjects +
        " · без автора: " + portfolio.unassignedProjects.length + "\n\n" +
        (sections.join("\n\n") || "Пока нет проектов.")
      );
    } catch (error) {
      if (error instanceof AgencyPortfolioError) {
        const messages: Record<string, string> = {
          NOT_AN_AGENCY: "Команда доступна только в агентстве.",
          PERMISSION_DENIED: "Портфель доступен владельцу, администратору и менеджеру агентства.",
          ACTOR_NOT_MEMBER: "У вас больше нет доступа к этому агентству."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось загрузить портфель.");
      } else {
        console.error("Control bot /agencyportfolio failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось загрузить портфель агентства.");
      }
    }
  });

  bot.command("assigncreator", async (ctx) => {
    const fields = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (fields.length !== 2 || !fields[0] || !/^\d{1,20}$/.test(fields[1] ?? "")) {
      await ctx.reply("Формат: /assigncreator PROJECT_ID TELEGRAM_ID\nАвтор должен быть участником активного агентства.");
      return;
    }
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const result = await assignAgencyProjectCreator({
        workspaceId: workspace.id,
        actorUserId: user.id,
        projectId: fields[0],
        creatorTelegramId: fields[1] ?? ""
      });
      await ctx.reply(
        result.changed
          ? "Ответственный автор проекта «" + result.projectName + "» изменён: " +
            result.previousCreatorName + " → " + result.creatorName + "."
          : "Проект «" + result.projectName + "» уже закреплён за " + result.creatorName + "."
      );
    } catch (error) {
      if (error instanceof AgencyPortfolioError) {
        const messages: Record<string, string> = {
          NOT_AN_AGENCY: "Назначать авторов можно только в агентстве.",
          PERMISSION_DENIED: "Назначать ответственных авторов могут только OWNER и ADMIN.",
          CREATOR_NOT_MEMBER: "Автор не найден среди участников активного агентства.",
          PROJECT_NOT_FOUND: "Проект не найден в активном агентстве.",
          ACTOR_NOT_MEMBER: "У вас больше нет доступа к агентству."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось назначить автора.");
      } else {
        console.error("Control bot /assigncreator failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось назначить автора.");
      }
    }
  });

  bot.command("unassigncreator", async (ctx) => {
    const projectId = String(ctx.match ?? "").trim();
    if (!projectId) {
      await ctx.reply("Формат: /unassigncreator PROJECT_ID");
      return;
    }
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const result = await unassignAgencyProjectCreator({
        workspaceId: workspace.id,
        actorUserId: user.id,
        projectId
      });
      await ctx.reply(
        result.changed
          ? "Ответственный автор проекта «" + result.projectName + "» снят. Прежний автор: " +
            result.previousCreatorName + "."
          : "У проекта «" + result.projectName + "» автор не назначен."
      );
    } catch (error) {
      if (error instanceof AgencyPortfolioError) {
        const messages: Record<string, string> = {
          NOT_AN_AGENCY: "Снимать автора можно только в агентстве.",
          PERMISSION_DENIED: "Изменять ответственного автора могут только OWNER и ADMIN.",
          PROJECT_NOT_FOUND: "Проект не найден в активном агентстве.",
          ACTOR_NOT_MEMBER: "У вас больше нет доступа к агентству."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось снять автора.");
      } else {
        console.error("Control bot /unassigncreator failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось снять автора.");
      }
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

      if (!canInviteWorkspaceRole(actorRole, requestedRole as InvitableWorkspaceRole)) {
        await ctx.reply(
          actorRole === "OWNER" || actorRole === "ADMIN"
            ? "Назначать администраторов может только владелец пространства."
            : "Приглашать участников могут только владелец или администратор пространства."
        );
        return;
      }

      const created = await createWorkspaceInvite({
        workspaceId: workspace.id,
        actorUserId: user.id,
        requestedRole: requestedRole as InvitableWorkspaceRole
      });

      const botInfo = await ctx.api.getMe();
      const inviteLink = `https://t.me/${botInfo.username}?start=join_${created.token}`;

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

  bot.command("setmemberrole", async (ctx) => {
    const fields = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const telegramId = fields[0] ?? "";
    const role = (fields[1] ?? "").toUpperCase();
    if (!/^\d{1,20}$/.test(telegramId) || !["ADMIN", "MANAGER", "VIEWER"].includes(role) || fields.length !== 2) {
      await ctx.reply("Формат: /setmemberrole TELEGRAM_ID [ADMIN|MANAGER|VIEWER]\nНазначать ADMIN может только владелец.");
      return;
    }
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const result = await setWorkspaceMemberRole({
        workspaceId: workspace.id,
        actorUserId: user.id,
        targetTelegramId: telegramId,
        requestedRole: role as InvitableWorkspaceRole
      });
      await ctx.reply(
        "Роль участника " + result.telegramId + " изменена: " +
        result.previousRole.toLowerCase() + " → " + result.role.toLowerCase() + "."
      );
    } catch (error) {
      if (error instanceof WorkspaceMembershipError) {
        const messages: Record<string, string> = {
          ACTOR_NOT_MEMBER: "У вас больше нет доступа к этому пространству.",
          PERMISSION_DENIED: "У вас нет прав изменить роль этого участника. Администраторы не могут управлять другими администраторами или назначать ADMIN.",
          MEMBER_NOT_FOUND: "Участник не найден в активном пространстве.",
          WORKSPACE_NOT_FOUND: "Рабочее пространство не найдено."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось изменить роль участника.");
      } else {
        console.error("Control bot /setmemberrole failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось изменить роль участника.");
      }
    }
  });

  bot.command("members", async (ctx) => {
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(user);
      const directory = await listWorkspaceMembersForAdmin({
        workspaceId: workspace.id,
        actorUserId: user.id
      });
      const lines = directory.members.map((member, index) => {
        const name = [member.firstName, member.lastName].filter(Boolean).join(" ")
          || (member.username ? "@" + member.username : "Пользователь");
        const username = member.username ? "@" + member.username : "без username";
        return (index + 1) + ". " + name + "\n" + username + " · " +
          member.role.toLowerCase() + "\nTelegram ID: " + member.telegramId;
      });

      await ctx.reply(
        "Участники пространства «" + directory.workspaceName + "»:\n\n" +
        lines.join("\n\n") +
        "\n\nПригласить участника: /invite"
      );
    } catch (error) {
      if (error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED") {
        await ctx.reply("Telegram ID участников доступны только владельцу и администратору пространства.");
      } else {
        console.error("Control bot /members failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось загрузить участников.");
      }
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

      const removed = await removeWorkspaceMember({
        workspaceId: workspace.id,
        actorUserId: user.id,
        targetTelegramId: telegramIdInput
      });

      await ctx.reply(
        `Участник ${removed.telegramId} удалён из «${workspace.name}».`
      );
    } catch (error) {
      if (error instanceof WorkspaceMembershipError) {
        await ctx.reply(
          error.code === "PERMISSION_DENIED"
            ? "У вас нет прав удалить этого участника."
            : error.code === "MEMBER_NOT_FOUND"
              ? "Участник не найден в активном пространстве."
              : "Не удалось удалить участника."
        );
      } else {
        console.error("Control bot /removemember failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось удалить участника.");
      }
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

      const revoked = await revokeWorkspaceInvite({
        workspaceId: workspace.id,
        actorUserId: user.id,
        inviteId
      });
      await ctx.reply(
        revoked ? "Приглашение отозвано." : "Активное приглашение с таким ID не найдено."
      );
    } catch (error) {
      if (error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED") {
        await ctx.reply("Администратор не может отозвать приглашение на роль ADMIN. Эту операцию выполняет владелец.");
      } else {
        console.error("Control bot /revokeinvite failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось отозвать приглашение.");
      }
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
      const { workspace } = await getActiveWorkspace(user);
      const project = await canAccessProject(projectId, user.id, MANAGER_ROLES);
      if (!project || project.workspaceId !== workspace.id) {
        await ctx.reply("Проект не найден или у вас нет прав переименовывать его.");
        return;
      }

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

      if (project.status !== "ARCHIVED") {
        await ctx.reply("Проект уже активен или не находится в архиве.");
        return;
      }

      const restored = await withWorkspaceQuotaTransaction(
        workspace.id,
        "projects",
        async (tx) => {
          // Restoring a project also makes its existing active creator plans and
          // connected chats available again, so validate those per-project caps.
          await assertWorkspaceQuotaInTransaction(tx, workspace.id, "plansPerProject", project.id);
          await assertWorkspaceQuotaInTransaction(tx, workspace.id, "connectedChatsPerProject", project.id);
          return tx.project.updateMany({
            where: { id: project.id, workspaceId: workspace.id, status: "ARCHIVED" },
            data: { status: "ACTIVE" }
          });
        }
      );
      if (restored.count !== 1) {
        await ctx.reply("Проект уже восстановлен или больше недоступен.");
        return;
      }

      await ctx.reply(`Проект «${project.name}» восстановлен.`);
    } catch (error) {
      console.error("Control bot /restoreproject failed:", error);
      await ctx.reply(formatWorkspaceQuotaError(error));
    }
  });

  bot.command("projectstats", async (ctx) => {
    const fields = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const projectId = fields[0] ?? "";
    const days = fields[1] === undefined ? 30 : Number(fields[1]);
    if (!projectId || fields.length > 2 || !Number.isSafeInteger(days) || days < 1 || days > 365) {
      await ctx.reply("Формат: /projectstats PROJECT_ID [DAYS]\nПериод: от 1 до 365 дней, по умолчанию 30.");
      return;
    }
    try {
      const actor = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(actor);
      const project = await canAccessProject(projectId, actor.id, MANAGER_ROLES);
      if (!project || project.workspaceId !== workspace.id) {
        await ctx.reply("Проект не найден в активном пространстве или у вас нет прав.");
        return;
      }
      const report = await getProjectAnalytics({
        workspaceId: workspace.id,
        projectId: project.id,
        periodDays: days
      });
      const currencyLines = report.revenueByCurrency.length
        ? report.revenueByCurrency.map((item) =>
            "• " + item.currency + ": поступления " + item.grossAmount +
            ", возвраты " + item.refundedAmount + ", чистый итог " + item.netAmount +
            " (" + item.successfulPayments + " оплат / " + item.refundedPayments + " возвратов)"
          )
        : ["• За выбранный период успешных оплат и возвратов нет."];
      const planLines = report.activePlans.length
        ? report.activePlans.map((item) => "• " + item.title + ": " + item.activeSubscriptions)
        : ["• Нет активных тарифов с подписчиками."];
      await ctx.reply(
        "Статистика проекта «" + report.projectName + "» за " + report.periodDays + " дней\n" +
        report.from.toLocaleDateString("ru-RU") + " — " + report.to.toLocaleDateString("ru-RU") + "\n\n" +
        "Активные подписки: " + report.activeSubscriptions + "\nУникальные активные клиенты: " + report.uniqueActiveCustomers + "\n" +
        "Новые подписки: " + report.newSubscriptions + "\nЗавершились: " + report.expiredSubscriptions + "\nДосрочно отменены: " + report.cancelledSubscriptions + "\n" +
        "Новые trial: " + report.newTrials + "\nРучные выдачи: " + report.manualGrants + "\n\n" +
        "Оплаты: " + report.successfulPayments + "\nВозвраты: " + report.refundedPayments + "\n" +
        "Повторных оплат по одной подписке за период: " + report.repeatPayingSubscriptions + "\n\n" +
        "Финансы (валюты не смешиваются):\n" + currencyLines.join("\n") +
        "\n\nАктивность тарифов:\n" + planLines.join("\n") +
        "\n\nЭто агрегированная статистика; персональные карточки клиентов не показываются."
      );
    } catch (error) {
      console.error("Control bot /projectstats failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось сформировать статистику проекта.");
    }
  });

  bot.command("auditlog", async (ctx) => {
    const fields = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const projectId = fields[0] ?? "";
    const limit = fields[1] === undefined ? 10 : Number(fields[1]);
    if (!projectId || fields.length > 2 || !Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      await ctx.reply("Формат: /auditlog PROJECT_ID [LIMIT]\nLIMIT: от 1 до 25, по умолчанию 10.");\n      return;
    }
    try {
      const actor = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(actor);
      const project = await canAccessProject(projectId, actor.id, MANAGER_ROLES);
      if (!project || project.workspaceId !== workspace.id) {
        await ctx.reply("Проект не найден в активном пространстве или у вас нет прав.");
        return;
      }
      const events = await listProjectAuditHistory({
        workspaceId: workspace.id,
        projectId: project.id,
        limit
      });
      if (events.length === 0) {
        await ctx.reply("Для этого проекта пока нет записей истории действий.");
        return;
      }
      const rows = events.map((event, index) =>
        (index + 1) + ". " + event.createdAt.toLocaleString("ru-RU") + "\n" +
        "Действие: " + event.action + "\nОбъект: " + event.resourceType +
        (event.resourceId ? " (" + event.resourceId + ")" : "") +
        "\nКто: " + event.actor
      );
      await ctx.reply(
        "История проекта «" + project.name + "» (последние " + events.length + "):\n\n" +
        rows.join("\n\n") +
        "\n\nВ истории скрыты служебные metadata и персональные данные."
      );
    } catch (error) {
      console.error("Control bot /auditlog failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось загрузить историю проекта.");
    }
  });

  bot.command("agencyaudit", async (ctx) => {
    const fields = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const limit = fields[0] === undefined ? 20 : Number(fields[0]);
    if (fields.length > 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      await ctx.reply("Формат: /agencyaudit [LIMIT]\nLIMIT: от 1 до 50, по умолчанию 20.");
      return;
    }
    try {
      const actor = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(actor);
      const report = await listAgencyAuditHistory({
        workspaceId: workspace.id,
        actorUserId: actor.id,
        limit
      });
      if (report.events.length === 0) {
        await ctx.reply("В доступных проектах агентства пока нет записей истории действий.");
        return;
      }
      const header = "История агентства «" + report.workspaceName + "» (последние " +
        report.events.length + "):\n\n";
      let chunk = header;
      for (const [index, event] of report.events.entries()) {
        const row = (index + 1) + ". " + event.createdAt.toLocaleString("ru-RU") +
          "\nПроект: " + event.projectName +
          "\nДействие: " + event.action +
          "\nОбъект: " + event.resourceType +
          (event.resourceId ? " (" + event.resourceId + ")" : "") +
          "\nКто: " + event.actor + "\n\n";
        if (chunk.length + row.length > 3500 && chunk !== header) {
          await ctx.reply(chunk);
          chunk = header;
        }
        chunk += row;
      }
      if (chunk !== header) {
        await ctx.reply(chunk + "Служебные metadata и персональные данные не включаются.");
      }
    } catch (error) {
      const message = error instanceof AgencyAuditError
        ? error.code === "NOT_AN_AGENCY"
          ? "Эта команда доступна только в рабочем пространстве типа «Агентство»."
          : error.code === "PERMISSION_DENIED"
            ? "Для просмотра истории нужны права MANAGER, ADMIN или OWNER."
            : "Не удалось получить историю агентства."
        : "Не удалось получить историю агентства.";
      console.error("Control bot /agencyaudit failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply(message);
    }
  });

  bot.command("agencyauditexport", async (ctx) => {
    const fields = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const days = fields[0] === undefined ? 90 : Number(fields[0]);
    if (fields.length > 1 || !Number.isSafeInteger(days) || days < 1 || days > 365) {
      await ctx.reply("Формат: /agencyauditexport [DAYS]\nПериод: от 1 до 365 дней, по умолчанию 90.");
      return;
    }
    try {
      const actor = await upsertTelegramUser(ctx);
      const { workspace } = await getActiveWorkspace(actor);
      const report = await exportAgencyAuditHistory({
        workspaceId: workspace.id,
        actorUserId: actor.id,
        periodDays: days
      });
      const date = new Date().toISOString().slice(0, 10);
      const filename = "subpilot-agency-audit-" + date + ".csv";
      const caption = "История агентства «" + report.workspaceName + "» за " +
        report.from.toLocaleDateString("ru-RU") + " — " +
        report.to.toLocaleDateString("ru-RU") + ". Записей: " + report.eventCount +
        (report.truncated ? ". Выгрузка ограничена первыми 5000 записями." : ".") +
        " Metadata и персональные данные не включены.";
      await ctx.replyWithDocument(
        new InputFile(Buffer.from(report.csv, "utf8"), filename),
        { caption }
      );
    } catch (error) {
      const message = error instanceof AgencyAuditError
        ? error.code === "NOT_AN_AGENCY"
          ? "Экспорт доступен только в рабочем пространстве типа «Агентство»."
          : error.code === "PERMISSION_DENIED"
            ? "Для экспорта истории нужны права MANAGER, ADMIN или OWNER."
            : "Не удалось сформировать выгрузку истории агентства."
        : "Не удалось сформировать выгрузку истории агентства.";
      console.error("Control bot /agencyauditexport failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply(message);
    }
  });

  bot.command("grantaccess", async (ctx) => {
    const fields = String(ctx.match ?? "").split("|").map((value) => value.trim());
    if (fields.length < 3 || fields.length > 4 || !fields[0] || !fields[1] || !fields[2]) {
      await ctx.reply(
        "Формат: /grantaccess PROJECT_ID | TELEGRAM_USER_ID | PLAN_ID | DAYS\n" +
        "DAYS необязателен: без него используется срок тарифа, 0 означает бессрочный доступ.\n" +
        "ID площадок и тарифов можно посмотреть командами /projects, /plans и /chats."
      );
      return;
    }
    const [projectId, telegramUserId, planId, daysText] = fields;
    let durationDays: number | null | undefined;
    if (daysText !== undefined) {
      if (!/^\d+$/.test(daysText)) {
        await ctx.reply("DAYS должен быть целым числом от 0 до 3650.");
        return;
      }
      durationDays = Number(daysText) === 0 ? null : Number(daysText);
    }
    try {
      const actor = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(actor);
      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Ручную выдачу доступа могут выполнять только владелец или администратор пространства.");
        return;
      }
      const result = await grantManualSubscriptionAccess({
        workspaceId: workspace.id,
        projectId: projectId as string,
        planId: planId as string,
        telegramUserId: telegramUserId as string,
        actorUserId: actor.id,
        ...(durationDays !== undefined ? { durationDays } : {})
      });
      await ctx.reply(
        `Ручной доступ поставлен в очередь.\nПроект: «${result.projectName}»\nТариф: «${result.planTitle}»\n` +
        `Telegram ID: ${result.telegramUserId}\nСрок: ${result.endsAt ? result.endsAt.toLocaleString("ru-RU") : "бессрочно"}\n` +
        `Площадок: ${result.destinations}\nПодписка: ${result.subscriptionId}\n\n` +
        (result.renewedExistingGrant
          ? "Срок существующей ручной подписки продлён."
          : "SubPilot выдаст приглашения фоновым обработчиком. Платёж не создавался.")
      );
    } catch (error) {
      if (error instanceof ManualSubscriptionAccessError) {
        const messages: Record<string, string> = {
          INVALID_TELEGRAM_USER_ID: "Telegram ID должен быть положительным числом.",
          INVALID_DURATION: "Срок должен быть от 1 до 3650 дней; 0 означает бессрочный доступ.",
          ACTOR_NOT_AUTHORIZED: "Только владелец или администратор пространства может выдавать доступ.",
          PROJECT_NOT_FOUND: "Проект не найден в активном пространстве или он архивирован.",
          PLAN_NOT_AVAILABLE: "Активный тариф проекта не найден.",
          NO_PLAN_DESTINATIONS: "У тарифа нет подключённых площадок.",
          TRIAL_NOT_CONFIGURED: "Для этого тарифа не задан пробный срок. Укажите DAYS явно.",
          TRIAL_ALREADY_USED: "Пробный доступ уже использовался или у клиента есть действующая подписка на этот тариф.",
          SUBSCRIPTION_NOT_FOUND: "Подписка не найдена в активном пространстве.",
          SUBSCRIPTION_NOT_ACTIVE: "Подписка уже не активна."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось выдать доступ.");
      } else {
        console.error("Manual access grant failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось выдать доступ. Изменение не было подтверждено.");
      }
    }
  });

  bot.command("trialaccess", async (ctx) => {
    const fields = String(ctx.match ?? "").split("|").map((value) => value.trim());
    if (fields.length < 3 || fields.length > 4 || !fields[0] || !fields[1] || !fields[2]) {
      await ctx.reply(
        "Формат: /trialaccess PROJECT_ID | TELEGRAM_USER_ID | PLAN_ID | DAYS\n" +
        "DAYS необязателен, если в настройках тарифа уже задан trialDays."
      );
      return;
    }
    const [projectId, telegramUserId, planId, daysText] = fields;
    let durationDays: number | undefined;
    if (daysText !== undefined) {
      if (!/^\d+$/.test(daysText) || Number(daysText) < 1 || Number(daysText) > 3650) {
        await ctx.reply("DAYS должен быть целым числом от 1 до 3650.");
        return;
      }
      durationDays = Number(daysText);
    }
    try {
      const actor = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(actor);
      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Пробный доступ могут выдавать только владелец или администратор пространства.");
        return;
      }
      const result = await grantTrialSubscriptionAccess({
        workspaceId: workspace.id,
        projectId: projectId as string,
        planId: planId as string,
        telegramUserId: telegramUserId as string,
        actorUserId: actor.id,
        ...(durationDays !== undefined ? { durationDays } : {})
      });
      await ctx.reply(
        `Пробный доступ создан.\nПроект: «${result.projectName}»\nТариф: «${result.planTitle}»\n` +
        `Telegram ID: ${result.telegramUserId}\nОкончание: ${result.endsAt.toLocaleString("ru-RU")}\n` +
        `Площадок: ${result.destinations}\nПодписка: ${result.subscriptionId}\n\n` +
        "Приглашения будут выданы фоновым обработчиком. Платёж не создавался."
      );
    } catch (error) {
      if (error instanceof ManualSubscriptionAccessError) {
        const messages: Record<string, string> = {
          INVALID_TELEGRAM_USER_ID: "Telegram ID должен быть положительным числом.",
          INVALID_DURATION: "Пробный срок должен быть от 1 до 3650 дней.",
          ACTOR_NOT_AUTHORIZED: "Только владелец или администратор пространства может выдавать пробный доступ.",
          PROJECT_NOT_FOUND: "Проект не найден в активном пространстве или он архивирован.",
          PLAN_NOT_AVAILABLE: "Активный тариф проекта не найден.",
          NO_PLAN_DESTINATIONS: "У тарифа нет подключённых площадок.",
          TRIAL_NOT_CONFIGURED: "Для этого тарифа не задан пробный срок. Укажите DAYS явно.",
          TRIAL_ALREADY_USED: "Пробный доступ уже использовался или у клиента есть действующая подписка на этот тариф."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось выдать пробный доступ.");
      } else {
        console.error("Trial access grant failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось выдать пробный доступ.");
      }
    }
  });

  bot.command("activesubscriptions", async (ctx) => {
    const projectId = String(ctx.match ?? "").trim();
    if (!projectId) {
      await ctx.reply("Формат: /activesubscriptions PROJECT_ID");
      return;
    }
    try {
      const actor = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(actor);
      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Список подписок доступен только владельцу или администратору пространства.");
        return;
      }
      const items = await listActiveProjectSubscriptions({
        workspaceId: workspace.id,
        projectId
      });
      if (items.length === 0) {
        await ctx.reply("В этом проекте нет активных подписок.");
        return;
      }
      const rows = items.map((item, index) =>
        `${index + 1}. ${item.plan.title} · ${item.customer.firstName ?? "Покупатель"}` +
        ` (ID ${item.customer.telegramUserId.toString()})\n` +
        `Тип: ${item.grantType.toLowerCase()} · окончание: ${item.endsAt ? item.endsAt.toLocaleString("ru-RU") : "без срока"}\n` +
        `ID: ${item.id}`
      );
      await ctx.reply(
        "Активные подписки (показаны до 20):\n\n" +
        rows.join("\n\n") +
        "\n\nДосрочный отзыв: /revokeaccess SUBSCRIPTION_ID"
      );
    } catch (error) {
      console.error("Active subscriptions list failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось получить список активных подписок.");
    }
  });

  bot.command("revokeaccess", async (ctx) => {
    const subscriptionId = String(ctx.match ?? "").trim();
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(subscriptionId)) {
      await ctx.reply("Формат: /revokeaccess SUBSCRIPTION_ID\nСписок: /activesubscriptions PROJECT_ID");
      return;
    }
    try {
      const actor = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(actor);
      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Досрочно отзывать доступ могут только владелец или администратор пространства.");
        return;
      }
      const result = await revokeSubscriptionAccessManually({
        subscriptionId,
        workspaceId: workspace.id,
        actorUserId: actor.id
      });
      await ctx.reply(
        `Досрочный отзыв принят.\nПроект: «${result.projectName}»\nТариф: «${result.planTitle}»\n` +
        `Подписка: ${result.subscriptionId}\n\nФоновый обработчик удалит активные приглашения и отзовёт доступ. ` +
        "Если у клиента есть другая действующая подписка на ту же площадку, она останется активной."
      );
    } catch (error) {
      if (error instanceof ManualSubscriptionAccessError) {
        const messages: Record<string, string> = {
          ACTOR_NOT_AUTHORIZED: "Только владелец или администратор пространства может отзывать доступ.",
          SUBSCRIPTION_NOT_FOUND: "Подписка не найдена в активном пространстве.",
          SUBSCRIPTION_NOT_ACTIVE: "Подписка уже не активна."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось отозвать доступ.");
      } else {
        console.error("Manual access revocation failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось отозвать доступ.");
      }
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
          "Сначала добавьте бота проекта администратором и выдайте права приглашать пользователей и ограничивать участников."
        );
        return;
      }

      const plan = await withWorkspaceQuotaTransaction(
        project.workspaceId,
        "plansPerProject",
        (tx) => tx.creatorPlan.create({
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
        }),
        project.id
      );

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
      await ctx.reply(formatWorkspaceQuotaError(error));
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
        "\n\nДля активности нужны права бота приглашать пользователей и ограничивать участников. Неактивная площадка также может означать, что достигнут лимит тарифа пространства. Проверьте раздел «Тариф пространства»." +
        "\nНазначение тарифу: /linkchat PLAN_ID CHAT_ID"
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
          project: { status: { not: "ARCHIVED" } }
        },
        select: { id: true, title: true, projectId: true }
      });
      const project = plan
        ? await canAccessProject(plan.projectId, user.id, MANAGER_ROLES)
        : null;

      if (!plan || !project) {
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
          project: { status: { not: "ARCHIVED" } }
        },
        select: {
          id: true,
          title: true,
          projectId: true,
          chats: { select: { connectedChatId: true } }
        }
      });
      const project = plan
        ? await canAccessProject(plan.projectId, user.id, MANAGER_ROLES)
        : null;

      if (!plan || !project) {
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
          `Статус: ${paymentStatusLabel(payment.status)} · ${customer}\n` +
          `ID: ${payment.id}`;
      });

      await ctx.reply(`Последние платежи проекта «${project.name}»:\n\n` + lines.join("\n\n"));
    } catch (error) {
      console.error("Control bot /payments failed:", error);
      await ctx.reply("Не удалось загрузить историю платежей.");
    }
  });

  bot.command("failednotifications", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Просматривать ошибки уведомлений можно только в личном чате с SubPilot.");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(user);
      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Просматривать ошибки уведомлений могут только владелец или администратор пространства.");
        return;
      }

      const failed = await prisma.ownerNotification.findMany({
        where: {
          sentAt: null,
          attempts: { gte: 10 },
          lastError: { not: "RECIPIENT_NO_LONGER_WORKSPACE_MEMBER" },
          project: { workspaceId: workspace.id }
        },
        include: { project: { select: { name: true } } },
        orderBy: { updatedAt: "asc" },
        take: 10
      });

      if (failed.length === 0) {
        await ctx.reply("В активном пространстве нет уведомлений с исчерпанными попытками.");
        return;
      }

      const lines = failed.map((notification, index) =>
        `${index + 1}. ${notification.project.name} · ${notification.eventType}\n` +
        `Попыток: ${notification.attempts}/10 · Ошибка: ${notification.lastError ?? "не указана"}\n` +
        `ID: ${notification.id}`
      );
      await ctx.reply(
        "Неотправленные уведомления (показаны до 10):\n\n" + lines.join("\n\n") +
        "\n\nДля повторной постановки в очередь: /retrynotification ID"
      );
    } catch (error) {
      console.error("Control bot /failednotifications failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось загрузить неотправленные уведомления.");
    }
  });

  bot.command("retrynotification", async (ctx) => {
    const notificationId = String(ctx.match ?? "").trim();
    if (!notificationId) {
      await ctx.reply("Формат: /retrynotification NOTIFICATION_ID\nСписок: /failednotifications");
      return;
    }
    if (ctx.chat.type !== "private") {
      await ctx.reply("Восстанавливать уведомления можно только в личном чате с SubPilot.");
      return;
    }

    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(user);
      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Восстанавливать уведомления могут только владелец или администратор пространства.");
        return;
      }

      const restored = await prisma.ownerNotification.updateMany({
        where: {
          id: notificationId,
          sentAt: null,
          attempts: { gte: 10 },
          lastError: { not: "RECIPIENT_NO_LONGER_WORKSPACE_MEMBER" },
          project: { workspaceId: workspace.id }
        },
        data: { attempts: 0, nextAttemptAt: new Date(), lastError: null }
      });

      await ctx.reply(restored.count === 1
        ? "Уведомление возвращено в очередь. SubPilot повторит отправку при следующем проходе обработчика."
        : "Не удалось восстановить уведомление. Проверьте его ID, статус и права в активном пространстве.");
    } catch (error) {
      console.error("Control bot /retrynotification failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось восстановить уведомление.");
    }
  });

  bot.command("faileddeliveries", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Просматривать ошибки выдачи доступа можно только в личном чате с SubPilot.");
      return;
    }
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(user);
      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Просматривать ошибки выдачи доступа могут только владелец или администратор пространства.");
        return;
      }
      const failed = await listWorkspaceFailedAccessDeliveries(workspace.id);
      if (failed.length === 0) {
        await ctx.reply("В активном пространстве нет выдач доступа, требующих ручного восстановления.");
        return;
      }
      const lines = failed.map((grant, index) => {
        const chatName = grant.connectedChat.title ??
          grant.connectedChat.username ??
          grant.connectedChat.telegramChatId.toString();
        return `${index + 1}. Проект «${grant.subscription.project.name}» · ${grant.subscription.plan.title}\n` +
          `Площадка: ${chatName}\n` +
          `Попыток: ${grant.deliveryAttempts}/10 · Ошибка: ${grant.deliveryLastError ?? "не указана"}\n` +
          `ID выдачи: ${grant.id}`;
      });
      await ctx.reply(
        "Не удалось автоматически выдать доступ (показаны до 10 записей):\n\n" +
        lines.join("\n\n") +
        "\n\nПосле исправления прав бота можно запустить: /retrydelivery ID"
      );
    } catch (error) {
      console.error("Control bot /faileddeliveries failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось загрузить ошибки выдачи доступа.");
    }
  });

  bot.command("retrydelivery", async (ctx) => {
    const grantId = String(ctx.match ?? "").trim();
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(grantId)) {
      await ctx.reply("Формат: /retrydelivery ACCESS_GRANT_ID\nСписок: /faileddeliveries");
      return;
    }
    if (ctx.chat.type !== "private") {
      await ctx.reply("Восстанавливать выдачу доступа можно только в личном чате с SubPilot.");
      return;
    }
    try {
      const user = await upsertTelegramUser(ctx);
      const { workspace, role } = await getActiveWorkspace(user);
      if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
        await ctx.reply("Восстанавливать выдачу доступа могут только владелец или администратор пространства.");
        return;
      }
      const restored = await retryWorkspaceFailedAccessDelivery({
        grantId,
        workspaceId: workspace.id,
        actorUserId: user.id
      });
      await ctx.reply(restored
        ? "Выдача доступа возвращена в очередь. Повторная попытка будет выполнена worker-процессом с обычным контролем прав и статуса подписки."
        : "Не удалось восстановить выдачу. Проверьте ID, статус подписки, активное пространство и права.");
    } catch (error) {
      console.error("Control bot /retrydelivery failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось восстановить выдачу доступа.");
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
        where: { id: paymentId, project: { workspaceId: workspace.id } },
        include: {
          customer: true,
          subscription: true,
          project: {
            include: {
              bots: {
                where: { status: "ACTIVE" },
                orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }]
              }
            }
          }
        }
      });

      if (!payment) {
        await ctx.reply("Платёж не найден в активном пространстве.");
        return;
      }
      if (payment.status === "REFUNDED") {
        await ctx.reply("Этот платёж уже отмечен как возвращённый.");
        return;
      }
      if (payment.provider !== "TELEGRAM_STARS" || payment.currency !== "XTR" || !payment.providerPaymentId ||
          (payment.status !== "SUCCEEDED" && payment.status !== "REFUNDING")) {
        await ctx.reply("Можно вернуть только подтверждённый платёж Telegram Stars.");
        return;
      }

      const telegramChargeId = payment.providerPaymentId;
      const linkedSubscriptionId = payment.subscriptionId;
      const metadata = payment.metadata && typeof payment.metadata === "object" && !Array.isArray(payment.metadata)
        ? payment.metadata as Record<string, unknown>
        : {};
      const originProjectBotId = typeof metadata.projectBotId === "string" ? metadata.projectBotId : null;
      const projectBot = originProjectBotId
        ? payment.project.bots.find((candidate) => candidate.id === originProjectBotId)
        : payment.project.bots[0];
      if (!projectBot) {
        await ctx.reply(originProjectBotId
          ? "Бот, который принял этот платёж, сейчас не активен. Возврат не отправлен; восстановите исходного бота и повторите команду."
          : "Не найден активный бот проекта. Возврат не отправлен.");
        return;
      }

      const buyerId = Number(payment.customer.telegramUserId);
      if (!Number.isSafeInteger(buyerId) || buyerId <= 0) {
        await ctx.reply("Некорректный Telegram ID покупателя. Возврат не отправлен.");
        return;
      }
      const refundBot = new Bot(decryptSecret(projectBot.tokenEncrypted));
      const attemptedAt = new Date();
      const retryBefore = new Date(attemptedAt.getTime() - REFUND_RETRY_LOCK_MS);
      const claim = await prisma.payment.updateMany({
        where: {
          id: payment.id,
          provider: "TELEGRAM_STARS",
          currency: "XTR",
          OR: [
            { status: "SUCCEEDED" },
            {
              status: "REFUNDING",
              OR: [
                { refundAttemptedAt: null },
                { refundAttemptedAt: { lte: retryBefore } }
              ]
            }
          ]
        },
        data: {
          status: "REFUNDING",
          refundAttemptedAt: attemptedAt,
          refundAttempts: { increment: 1 },
          refundLastError: null
        }
      });

      if (claim.count !== 1) {
        const current = await prisma.payment.findUnique({
          where: { id: payment.id },
          select: { status: true, refundAttemptedAt: true }
        });
        if (current?.status === "REFUNDED") {
          await ctx.reply("Этот платёж уже возвращён.");
        } else if (current?.status === "REFUNDING") {
          await ctx.reply("Возврат уже обрабатывается или ожидает сверки с Telegram. Повторите эту же команду примерно через две минуты.");
        } else {
          await ctx.reply("Статус платежа изменился. Обновите список платежей и проверьте его перед повторной операцией.");
        }
        return;
      }

      let refundConfirmed = false;
      try {
        refundConfirmed = await refundBot.api.refundStarPayment(buyerId, telegramChargeId);
      } catch (error) {
        const classification = classifyTelegramRefundError(error);
        if (classification.kind === "ALREADY_REFUNDED") {
          // A previous attempt may have succeeded at Telegram but failed before local persistence.
          refundConfirmed = true;
        } else if (classification.kind === "REJECTED") {
          await prisma.payment.updateMany({
            where: { id: payment.id, status: "REFUNDING", refundAttemptedAt: attemptedAt },
            data: {
              status: "SUCCEEDED",
              refundLastError: "TELEGRAM_API_REJECTED_" + classification.errorCode
            }
          });
          await ctx.reply("Telegram отклонил запрос на возврат (код " + classification.errorCode + "). Платёж оставлен в статусе «успешен»; проверьте причину и повторите при необходимости.");
          return;
        } else {
          await prisma.payment.updateMany({
            where: { id: payment.id, status: "REFUNDING", refundAttemptedAt: attemptedAt },
            data: { refundLastError: "TELEGRAM_RESULT_UNKNOWN" }
          });
          await ctx.reply("Telegram не дал однозначного ответа. Платёж оставлен в состоянии сверки. Не создавайте новый платёж; повторите эту же команду примерно через две минуты — SubPilot проверит результат повторным запросом.");
          return;
        }
      }

      if (!refundConfirmed) {
        await prisma.payment.updateMany({
          where: { id: payment.id, status: "REFUNDING", refundAttemptedAt: attemptedAt },
          data: { status: "SUCCEEDED", refundLastError: "TELEGRAM_RETURNED_FALSE" }
        });
        await ctx.reply("Telegram не подтвердил возврат. Платёж оставлен успешным; попробуйте повторить операцию после проверки.");
        return;
      }

      const refundedAt = new Date();
      let finalization: {
        alreadyFinalized: boolean;
        hasOtherPaidPeriods: boolean;
        shouldRevokeAccess: boolean;
        periodsRecalculated: boolean;
        subscriptionEndsAt: Date | null;
      };
      try {
        finalization = await prisma.$transaction(async (tx) => {
          if (linkedSubscriptionId) {
            await tx.$queryRawUnsafe('SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE', linkedSubscriptionId);
          }

          const changed = await tx.payment.updateMany({
            where: { id: payment.id, status: "REFUNDING" },
            data: { status: "REFUNDED", refundedAt, refundLastError: null }
          });
          if (changed.count !== 1) {
            const current = await tx.payment.findUnique({ where: { id: payment.id }, select: { status: true } });
            if (current?.status === "REFUNDED") {
              return { alreadyFinalized: true, hasOtherPaidPeriods: false, shouldRevokeAccess: false, periodsRecalculated: true, subscriptionEndsAt: null };
            }
            throw new Error("Refund state changed before local finalization.");
          }

          const refundEventKey = "telegram-stars-refund:" + telegramChargeId;
          await tx.paymentWebhookEvent.upsert({
            where: { dedupeKey: refundEventKey },
            create: {
              connectionId: null,
              dedupeKey: refundEventKey,
              providerEventId: telegramChargeId,
              eventType: "telegram.stars.payment.refunded",
              payload: {
                paymentId: payment.id,
                telegramUserId: payment.customer.telegramUserId.toString(),
                telegramPaymentChargeId: telegramChargeId,
                amount: payment.amount.toString(),
                currency: payment.currency
              },
              processedAt: refundedAt
            },
            update: { processedAt: refundedAt }
          });

          if (!linkedSubscriptionId) {
            return { alreadyFinalized: false, hasOtherPaidPeriods: false, shouldRevokeAccess: false, periodsRecalculated: true, subscriptionEndsAt: null };
          }

          const subscription = await tx.subscription.findUnique({
            where: { id: linkedSubscriptionId },
            select: { status: true, startsAt: true, endsAt: true }
          });
          if (!subscription) {
            return { alreadyFinalized: false, hasOtherPaidPeriods: false, shouldRevokeAccess: false, periodsRecalculated: true, subscriptionEndsAt: null };
          }

          const remainingPayments = await tx.payment.findMany({
            where: { subscriptionId: linkedSubscriptionId, status: { in: ["SUCCEEDED", "REFUNDING"] } },
            orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
            select: { paidAt: true, metadata: true }
          });

          if (remainingPayments.length === 0) {
            await tx.subscription.update({
              where: { id: linkedSubscriptionId },
              data: { status: "EXPIRED", endsAt: refundedAt, cancelledAt: null }
            });
            return { alreadyFinalized: false, hasOtherPaidPeriods: false, shouldRevokeAccess: true, periodsRecalculated: true, subscriptionEndsAt: refundedAt };
          }

          const recalculated = recalculateSubscriptionPeriod(remainingPayments, {
            startsAt: subscription.startsAt,
            endsAt: subscription.endsAt
          });
          if (!recalculated.exact) {
            const isAlreadyExpired = subscription.status === "EXPIRED" ||
              (subscription.endsAt !== null && subscription.endsAt <= refundedAt);
            if (isAlreadyExpired && subscription.status !== "EXPIRED") {
              await tx.subscription.update({ where: { id: linkedSubscriptionId }, data: { status: "EXPIRED" } });
            }
            return {
              alreadyFinalized: false,
              hasOtherPaidPeriods: true,
              shouldRevokeAccess: isAlreadyExpired,
              periodsRecalculated: false,
              subscriptionEndsAt: subscription.endsAt
            };
          }

          const isExpired = recalculated.endsAt !== null && recalculated.endsAt <= refundedAt;
          await tx.subscription.update({
            where: { id: linkedSubscriptionId },
            data: {
              status: isExpired ? "EXPIRED" : "ACTIVE",
              startsAt: recalculated.startsAt,
              endsAt: recalculated.endsAt,
              cancelledAt: null
            }
          });
          return {
            alreadyFinalized: false,
            hasOtherPaidPeriods: true,
            shouldRevokeAccess: isExpired,
            periodsRecalculated: true,
            subscriptionEndsAt: recalculated.endsAt
          };
        });
      } catch (error) {
        // Keep REFUNDING: retrying is safe because Telegram reports CHARGE_ALREADY_REFUNDED for a completed refund.
        await prisma.payment.updateMany({
          where: { id: payment.id, status: "REFUNDING", refundAttemptedAt: attemptedAt },
          data: { refundLastError: "LOCAL_FINALIZATION_FAILED" }
        }).catch(() => undefined);
        console.error("Telegram refund succeeded but local finalization needs retry:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Telegram подтвердил возврат, но SubPilot не смог завершить запись операции в базе. Платёж оставлен в состоянии сверки. Повторите эту же команду примерно через две минуты; повторный запрос будет безопасно обработан.");
        return;
      }

      const response = ["Возврат Telegram Stars подтверждён и записан в журнал операций."];
      if (finalization.alreadyFinalized) {
        response.push("Локальная запись уже была завершена ранее.");
      } else if (!linkedSubscriptionId) {
        response.push("Платёж не связан с подпиской.");
      } else if (!finalization.hasOtherPaidPeriods) {
        response.push("Других оплаченных периодов не осталось. Отключение доступа передано фоновому обработчику.");
      } else if (!finalization.periodsRecalculated) {
        response.push("Другие оплаты сохранены, но у старых записей нет снимка длительности. Даты и доступ не изменены автоматически; требуется ручная сверка.");
      } else if (finalization.shouldRevokeAccess) {
        response.push("После пересчёта других оплат срок доступа уже истёк. Отключение передано фоновому обработчику.");
      } else if (finalization.subscriptionEndsAt) {
        response.push("Остальные оплаченные периоды сохранены. Новый срок доступа: " + finalization.subscriptionEndsAt.toLocaleString("ru-RU") + ".");
      } else {
        response.push("Остальные оплаченные периоды сохранены; доступ остаётся бессрочным.");
      }
      await ctx.reply(response.join("\n\n"));
    } catch (error) {
      console.error("Control bot /refundpayment failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось завершить возврат. Проверьте состояние операции в списке платежей и повторите ту же команду, если статус остался «возврат выполняется».");
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
          status: "ACTIVE",
          project: {
            workspaceId: workspace.id,
            status: { not: "ARCHIVED" }
          }
        },
        select: { id: true, title: true, projectId: true }
      });
      const project = plan
        ? await canAccessProject(plan.projectId, user.id, MANAGER_ROLES)
        : null;

      if (!plan || !project || project.workspaceId !== workspace.id) {
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
          status: "ARCHIVED",
          project: {
            workspaceId: workspace.id,
            status: { not: "ARCHIVED" }
          }
        },
        select: { id: true, title: true, projectId: true }
      });
      const project = plan
        ? await canAccessProject(plan.projectId, user.id, MANAGER_ROLES)
        : null;

      if (!plan || !project || project.workspaceId !== workspace.id) {
        await ctx.reply("Тариф не найден в активном пространстве или у вас нет прав.");
        return;
      }

      const restored = await withWorkspaceQuotaTransaction(
        project.workspaceId,
        "plansPerProject",
        (tx) => tx.creatorPlan.updateMany({
          where: { id: plan.id, projectId: project.id, status: "ARCHIVED" },
          data: { status: "ACTIVE" }
        }),
        project.id
      );
      if (restored.count !== 1) {
        await ctx.reply("Тариф уже восстановлен или больше недоступен.");
        return;
      }

      await ctx.reply(`Тариф «${plan.title}» восстановлен.`);
    } catch (error) {
      console.error("Control bot /restoreplan failed:", error);
      await ctx.reply(formatWorkspaceQuotaError(error));
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

      setPendingBotConnection(ctx.from.id, projectId);

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
      pendingTextActions.delete(ctx.from.id);
      pendingPlatformProviderSecrets.delete(ctx.from.id);
    }
    await ctx.reply("Текущая операция отменена.");
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    if (ctx.message.text.startsWith("/")) return;

    const pendingPlatformSecret = pendingPlatformProviderSecrets.get(ctx.from.id);
    if (pendingPlatformSecret) {
      pendingPlatformProviderSecrets.delete(ctx.from.id);
      const submittedSecretText = ctx.message.text;
      await ctx.deleteMessage().catch(() => undefined);

      if (pendingPlatformSecret.expiresAt <= Date.now()) {
        await ctx.reply("Время ожидания истекло. Начните операцию подключения провайдера заново.");
        return;
      }
      if (!isPlatformAdminTelegramId(ctx.from.id, process.env.PLATFORM_ADMIN_TELEGRAM_IDS)) {
        await ctx.reply("Доступ оператора отозван. Секрет не сохранён.");
        return;
      }

      try {
        const credentials = parsePlatformProviderCredentials(submittedSecretText);
        const actor = await upsertTelegramUser(ctx);
        const connection = pendingPlatformSecret.kind === "CREATE"
          ? await createPlatformProviderConnection({
              ...pendingPlatformSecret.connection,
              credentials,
              actorUserId: actor.id
            })
          : await rotatePlatformProviderCredentials({
              connectionId: pendingPlatformSecret.connectionId,
              credentials,
              actorUserId: actor.id
            });

        await ctx.reply(
          pendingPlatformSecret.kind === "CREATE"
            ? `Подключение ${connection.provider} «${connection.label}» сохранено в зашифрованном виде. Статус: PENDING. Оно не будет принимать платежи до проверки интеграции.`
            : `Реквизиты ${connection.provider} «${connection.label}» обновлены. Статус сброшен в PENDING до повторной проверки.`
        );
      } catch (error) {
        if (error instanceof PlatformProviderConnectionError &&
            error.code === "DUPLICATE_CONNECTION") {
          await ctx.reply("Подключение с таким провайдером и меткой уже существует. Выберите другую метку.");
        } else if (error instanceof Error &&
                   /^(Отправьте JSON|Не удалось разобрать JSON|Секреты должны|JSON должен|Каждое поле)/.test(error.message)) {
          await ctx.reply(error.message);
        } else if (error instanceof PlatformProviderConnectionError &&
                   error.code === "CONNECTION_NOT_FOUND") {
          await ctx.reply("Подключение не найдено. Секрет не сохранён.");
        } else {
          console.error("Platform provider secret save failed:", error instanceof Error ? error.name : "UnknownError");
          await ctx.reply("Не удалось сохранить реквизиты провайдера. Исходное сообщение удалено по возможности.");
        }
      }
      return;
    }

    const pendingAction = pendingTextActions.get(ctx.from.id);
    if (pendingAction) {
      pendingTextActions.delete(ctx.from.id);
      if (pendingAction.expiresAt <= Date.now()) {
        await ctx.reply("Время ожидания ввода истекло. Запустите нужное действие заново.", {
          reply_markup: homeKeyboard()
        });
        return;
      }
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
          const project = await withWorkspaceQuotaTransaction(
            workspace.id,
            "projects",
            (tx) => tx.project.create({
              data: {
                workspaceId: workspace.id,
                creatorUserId: user.id,
                name: input,
                slug,
                defaultCurrency: "RUB",
                countryCode: "RU"
              }
            })
          );
          await ctx.reply(`Проект «${project.name}» создан.`, {
            reply_markup: new InlineKeyboard().text("Открыть проект", `ui:project:${project.id}`).row().text("В главное меню", "ui:home")
          });
        } catch (error) {
          console.error("Button create project failed:", error instanceof Error ? error.name : "UnknownError");
          await ctx.reply(formatWorkspaceQuotaError(error), { reply_markup: homeKeyboard() });
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
            await ctx.reply("Сначала добавьте бота проекта администратором хотя бы в один канал или группу и выдайте права приглашать пользователей и ограничивать участников.", {
              reply_markup: new InlineKeyboard().text("Подключить бота", `ui:connect:${project.id}`).row().text("К проекту", `ui:project:${project.id}`)
            });
            return;
          }
          const plan = await withWorkspaceQuotaTransaction(
            project.workspaceId,
            "plansPerProject",
            (tx) => tx.creatorPlan.create({
              data: {
                projectId: project.id,
                title,
                price,
                currency: "XTR",
                durationDays: durationDays === 0 ? null : durationDays,
                isRecurring: false,
                chats: { create: activeChats.map((chat) => ({ connectedChatId: chat.id })) }
              }
            }),
            project.id
          );
          await ctx.reply(`Тариф «${plan.title}» создан за ${plan.price.toString()} ⭐.`, {
            reply_markup: new InlineKeyboard().text("Посмотреть тарифы", `ui:plans:${project.id}`).row().text("К проекту", `ui:project:${project.id}`)
          });
        } catch (error) {
          console.error("Button create plan failed:", error instanceof Error ? error.name : "UnknownError");
          await ctx.reply(formatWorkspaceQuotaError(error), { reply_markup: homeKeyboard() });
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

      const activeProjectBot = await prisma.projectBot.findFirst({
        where: {
          projectId: project.id,
          status: "ACTIVE",
          ...(existingBot ? { id: { not: existingBot.id } } : {})
        },
        select: { username: true }
      });
      if (activeProjectBot) {
        await ctx.reply(
          "В одном проекте SubPilot используется один активный Telegram-бот. " +
          "У этого проекта уже подключён @" + (activeProjectBot.username ?? "бот") +
          ". Для обновления токена подключите того же бота из BotFather."
        );
        return;
      }

      if (existingBot?.status === "ACTIVE") {
        // Same Telegram bot identity: a token refresh must not rotate the current
        // webhook secret or mark a working bot as PENDING.
        await prisma.projectBot.update({
          where: { id: existingBot.id },
          data: {
            username: botInfo.username ?? null,
            displayName: botInfo.first_name,
            tokenEncrypted: encryptSecret(botToken),
            lastVerifiedAt: new Date()
          }
        });

        try {
          await candidateBot.api.setMyCommands([
            { command: "start", description: "Открыть меню подписок" },
            { command: "plans", description: "Посмотреть тарифы" },
            { command: "buy", description: "Оформить выбранный тариф" },
            { command: "access", description: "Получить ссылки для вступления" },
            { command: "terms", description: "Условия покупки" },
            { command: "paysupport", description: "Поддержка по оплате и возвратам" }
          ]);
        } catch (error) {
          console.warn(
            "Project bot token was updated, but Telegram command hints could not be refreshed:",
            error instanceof Error ? error.name : "UnknownError"
          );
        }

        await ctx.reply(
          "Действующий бот проекта повторно проверен. Новый токен зашифрован и сохранён. " +
          "Текущие webhook и секрет webhook оставлены без изменений; перенос webhook на другой адрес API выполняется отдельно."
        );
        return;
      }

      const publicApiUrl = (process.env.PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "");

      if (publicApiUrl) {
        let parsedApiUrl: URL;
        try {
          parsedApiUrl = new URL(publicApiUrl);
        } catch {
          await ctx.reply("PUBLIC_API_URL задан некорректно. Укажите полный публичный HTTPS-адрес API.");
          return;
        }
        if (parsedApiUrl.protocol !== "https:") {
          await ctx.reply("Для webhook Telegram требуется публичный HTTPS-адрес. Текущая конфигурация бота не изменена.");
          return;
        }
      }

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
          max_connections: 1,
          allowed_updates: ["my_chat_member", "message", "pre_checkout_query", "chat_member", "callback_query"]
        });

        if (!configured) {
          throw new Error("Telegram did not confirm webhook configuration.");
        }

        try {
          await candidateBot.api.setMyCommands([
            { command: "start", description: "Открыть меню подписок" },
            { command: "plans", description: "Посмотреть тарифы" },
            { command: "buy", description: "Оформить выбранный тариф" },
            { command: "access", description: "Получить ссылки для вступления" },
            { command: "terms", description: "Условия покупки" },
            { command: "paysupport", description: "Поддержка по оплате и возвратам" }
          ]);
        } catch (error) {
          // Command hints are optional. A valid webhook must still activate the project bot.
          console.warn(
            "Project bot webhook is configured, but Telegram command hints could not be updated:",
            error instanceof Error ? error.name : "UnknownError"
          );
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
          ? "Webhook настроен. Добавьте бота администратором в канал или группу с правами приглашать пользователей и ограничивать участников. Покупатели смогут открыть @бот, посмотреть /plans и оплатить тариф командой /buy ID."
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

  bot.command("platformrefund", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        !isPlatformAdminTelegramId(ctx.from.id, process.env.PLATFORM_ADMIN_TELEGRAM_IDS)) {
      await ctx.reply("Команда доступна только уполномоченным операторам SubPilot в личном чате.");
      return;
    }

    const paymentId = String(ctx.match ?? "").trim();
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(paymentId)) {
      await ctx.reply("Формат: /platformrefund PAYMENT_ID");
      return;
    }

    try {
      const actor = await upsertTelegramUser(ctx);
      const result = await requestPlatformPaymentRefund({
        paymentId,
        actorTelegramId: ctx.from.id,
        actorUserId: actor.id
      });
      if (result.providerStatus === "canceled") {
        await ctx.reply(
          `Провайдер отклонил возврат платежа ${result.paymentId}. Подписка не менялась. Проверьте кабинет YooKassa и причину отказа.`
        );
        return;
      }
      await ctx.reply(
        `Запрос на полный возврат отправлен в YooKassa.\nПлатёж: ${result.paymentId}\nВозврат: ${result.providerRefundId}\nСтатус провайдера: ${result.providerStatus}\nПопытка: ${result.attempt}\n\nSubPilot изменит биллинговый период только после проверенного webhook refund.succeeded. Ответ API или скриншот не снимают доступ.`
      );
    } catch (error) {
      if (error instanceof PlatformRefundError) {
        const messages: Record<string, string> = {
          INVALID_ACTOR: "Операция не разрешена для этого пользователя.",
          PAYMENT_NOT_FOUND: "Платёж не найден.",
          PAYMENT_NOT_REFUNDABLE: "Полный возврат доступен только для успешно оплаченного платежа.",
          REFUND_IN_PROGRESS: "Запрос возврата уже обрабатывается. Дождитесь webhook от YooKassa.",
          REFUND_REQUIRES_MANUAL_REVIEW: "Автоматический повтор запрещён: сначала сверить статус возврата в кабинете YooKassa. Новый запрос не отправлялся.",
          PROVIDER_CONNECTION_NOT_FOUND: "Подключение YooKassa для платежа не найдено.",
          INVALID_PROVIDER_CREDENTIALS: "Не удалось расшифровать реквизиты YooKassa.",
          PROVIDER_REQUEST_FAILED: "YooKassa не подтвердила создание возврата. Статус сохранён для повторной сверки; повторный запрос использует тот же ключ идемпотентности."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось запросить возврат.");
      } else {
        console.error("Platform payment refund request failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось запросить возврат. Секреты провайдера не записывались в журнал.");
      }
    }
  });

  bot.command("platformpaymentreviews", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        !isPlatformAdminTelegramId(ctx.from.id, process.env.PLATFORM_ADMIN_TELEGRAM_IDS)) {
      await ctx.reply("Команда доступна только уполномоченным операторам SubPilot в личном чате.");
      return;
    }

    try {
      const events = await prisma.platformPaymentWebhookEvent.findMany({
        where: { processedAt: null },
        include: {
          providerConnection: {
            select: { provider: true, label: true }
          }
        },
        orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
        take: 20
      });
      if (events.length === 0) {
        await ctx.reply("Очередь ручной сверки платежей пуста.");
        return;
      }

      const lines = events.map((event) => [
        `${event.providerConnection.provider} · ${event.eventType}`,
        `ID: ${event.id}`,
        `Подключение: ${event.providerConnection.label}`,
        `Причина: ${event.lastError ?? "Ожидает обработки"}`,
        `Попыток: ${event.attempts} · Получено: ${event.receivedAt.toISOString()}`
      ].join("\n"));

      await ctx.reply(
        "События платежей, требующие ручной сверки (первые 20):\n\n" + lines.join("\n\n") +
        "\n\nКоманда только показывает очередь. Она не подтверждает оплату и не меняет доступ."
      );
    } catch (error) {
      console.error("Platform payment review queue failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось загрузить очередь ручной сверки платежей.");
    }
  });

  bot.command("platformplans", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        !isPlatformAdminTelegramId(ctx.from.id, process.env.PLATFORM_ADMIN_TELEGRAM_IDS)) {
      await ctx.reply("Команда доступна только уполномоченным операторам SubPilot в личном чате.");
      return;
    }

    try {
      const rawPage = String(ctx.match ?? "").trim();
      const page = rawPage ? Number(rawPage) : 1;
      if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
        await ctx.reply("Формат: /platformplans [номер страницы].");
        return;
      }
      const pageSize = 10;
      const [total, plans] = await Promise.all([
        prisma.platformPlan.count(),
        prisma.platformPlan.findMany({
          include: { _count: { select: { workspaceBillings: true } } },
          orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize
        })
      ]);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));

      if (plans.length === 0) {
        await ctx.reply(
          total === 0
            ? "Каталог тарифов SubPilot пока пуст. Добавить тариф: /platformplan CODE | Название | Цена | Валюта | Дней | Проекты | Участники | Тарифы/проект | Площадки/проект | Описание"
            : `На странице ${page} тарифов нет. Последняя страница: ${totalPages}.`
        );
        return;
      }

      const lines = plans.map((plan) => {
        let limits = "лимиты невалидны";
        try {
          const parsed = parseWorkspacePlanFeatureConfig(plan.features);
          const value = (key: keyof typeof parsed.limits) =>
            parsed.limits[key] === null ? "∞" : String(parsed.limits[key]);
          limits = `проекты ${value("projects")}, участники ${value("members")}, тарифы/проект ${value("plansPerProject")}, площадки/проект ${value("connectedChatsPerProject")}`;
        } catch {
          // Do not present malformed feature data as unlimited.
        }
        return [
          `${plan.isActive ? "✅" : "⏸"} ${plan.title} (${plan.code})`,
          `Цена: ${plan.price.toString()} ${plan.currency} / ${plan.billingPeriodDays} дн.`,
          `Назначено пространствам: ${plan._count.workspaceBillings}`,
          `Лимиты: ${limits}`
        ].join("\n");
      });

      const navigation = [
        page > 1 ? `Назад: /platformplans ${page - 1}` : null,
        page < totalPages ? `Далее: /platformplans ${page + 1}` : null
      ].filter(Boolean).join(" · ");
      await ctx.reply(
        `Каталог тарифов SubPilot — ${page}/${totalPages} (всего: ${total})\n\n` +
        lines.join("\n\n") +
        (navigation ? "\n\n" + navigation : "")
      );
    } catch (error) {
      console.error("Platform plan catalogue read failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось загрузить каталог тарифов.");
    }
  });

  bot.command("platformplan", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        !isPlatformAdminTelegramId(ctx.from.id, process.env.PLATFORM_ADMIN_TELEGRAM_IDS)) {
      await ctx.reply("Команда доступна только уполномоченным операторам SubPilot в личном чате.");
      return;
    }

    try {
      const input = parsePlatformPlanUpsertInput(String(ctx.match ?? ""));
      const actor = await upsertTelegramUser(ctx);
      const plan = await upsertPlatformPlan(input, actor.id);

      await ctx.reply(
        `Тариф SubPilot «${plan.title}» (${plan.code}) сохранён.\n` +
        `Цена: ${plan.price.toString()} ${plan.currency} за ${plan.billingPeriodDays} дн.\n` +
        "Лимиты сохранены в версии схемы 1. Уже назначенный статус активности не изменён."
      );
    } catch (error) {
      if (error instanceof PlatformPlanCatalogError &&
          error.code === "PLAN_HAS_ASSIGNED_WORKSPACES") {
        await ctx.reply("Этот тариф уже назначен рабочим пространствам и защищён от изменения. Создайте новую версию с другим кодом.");
        return;
      }
      if (error instanceof Error && /^(Формат:|Код тарифа|Название тарифа|Цена должна|Валюта должна|Период оплаты|Лимит «|Описание тарифа)/.test(error.message)) {
        await ctx.reply(error.message);
        return;
      }
      console.error("Platform plan upsert failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось сохранить тариф SubPilot. Проверьте данные и повторите попытку.");
    }
  });

  bot.command("platformplanstatus", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        !isPlatformAdminTelegramId(ctx.from.id, process.env.PLATFORM_ADMIN_TELEGRAM_IDS)) {
      await ctx.reply("Команда доступна только уполномоченным операторам SubPilot в личном чате.");
      return;
    }

    const fields = String(ctx.match ?? "").trim().split(/\s+/);
    const code = fields[0];
    const requestedStatus = fields[1]?.toLowerCase();
    if (!code || !["active", "off"].includes(requestedStatus ?? "") || fields.length !== 2) {
      await ctx.reply("Формат: /platformplanstatus CODE active|off");
      return;
    }

    try {
      const actor = await upsertTelegramUser(ctx);
      const updated = await setPlatformPlanActive(
        code,
        requestedStatus === "active",
        actor.id
      );

      await ctx.reply(
        updated.isActive
          ? `Тариф «${updated.title}» активирован в каталоге.`
          : `Тариф «${updated.title}» отключён. Назначенных рабочих пространств нет.`
      );
    } catch (error) {
      if (error instanceof PlatformPlanCatalogError && error.code === "PLAN_NOT_FOUND") {
        await ctx.reply("Тариф с таким кодом не найден.");
      } else if (error instanceof PlatformPlanCatalogError && error.code === "PLAN_HAS_ASSIGNED_WORKSPACES") {
        await ctx.reply("Нельзя отключить тариф, пока он назначен хотя бы одному рабочему пространству. Сначала безопасно переведите пространства на другой тариф.");
      } else {
        console.error("Platform plan status update failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось изменить статус тарифа.");
      }
    }
  });

  bot.command("platformproviders", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        !isPlatformAdminTelegramId(ctx.from.id, process.env.PLATFORM_ADMIN_TELEGRAM_IDS)) {
      await ctx.reply("Команда доступна только уполномоченным операторам SubPilot в личном чате.");
      return;
    }

    try {
      const connections = await listPlatformProviderConnections();
      if (connections.length === 0) {
        await ctx.reply("Подключений внешних провайдеров SubPilot пока нет.");
        return;
      }
      const statusLabel: Record<string, string> = {
        PENDING: "ожидает проверки",
        ACTIVE: "активно",
        ERROR: "ошибка",
        DISABLED: "отключено"
      };
      const lines = connections.map((connection) =>
        `${connection.provider} — ${connection.label} (${connection.environment})\n` +
        `ID: ${connection.id}\nСтатус: ${statusLabel[connection.status] ?? connection.status}` +
        (connection.lastVerifiedAt
          ? `\nПоследняя проверка: ${connection.lastVerifiedAt.toISOString()}`
          : "")
      );
      await ctx.reply("Внешние подключения SubPilot:\n\n" + lines.join("\n\n"));
    } catch (error) {
      console.error("Platform provider connection list failed:", error instanceof Error ? error.name : "UnknownError");
      await ctx.reply("Не удалось получить список подключений провайдеров.");
    }
  });

  bot.command("platformprovideradd", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        !isPlatformAdminTelegramId(ctx.from.id, process.env.PLATFORM_ADMIN_TELEGRAM_IDS)) {
      await ctx.reply("Команда доступна только уполномоченным операторам SubPilot в личном чате.");
      return;
    }

    try {
      const connection = parsePlatformProviderConnectionInput(String(ctx.match ?? ""));
      pendingBotConnections.delete(ctx.from.id);
      pendingTextActions.delete(ctx.from.id);
      pendingPlatformProviderSecrets.set(ctx.from.id, {
        kind: "CREATE",
        connection,
        expiresAt: Date.now() + BOT_TOKEN_TTL_MS
      });
      await ctx.reply(
        "Теперь отправьте реквизиты подключения отдельным сообщением в формате JSON.\n" +
        'Пример структуры: {"shopId":"...","secretKey":"..."}\n' +
        "Сообщение будет удалено по возможности сразу после получения. Секрет сохранится в зашифрованном виде.\n" +
        "Новое подключение останется в PENDING до появления и успешного прохождения проверки провайдера.\n" +
        "Ожидание — 5 минут. Для отмены: /cancel"
      );
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Неверные параметры подключения.");
    }
  });

  bot.command("platformproviderrotate", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        !isPlatformAdminTelegramId(ctx.from.id, process.env.PLATFORM_ADMIN_TELEGRAM_IDS)) {
      await ctx.reply("Команда доступна только уполномоченным операторам SubPilot в личном чате.");
      return;
    }

    const connectionId = String(ctx.match ?? "").trim();
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(connectionId)) {
      await ctx.reply("Формат: /platformproviderrotate CONNECTION_ID");
      return;
    }
    const existing = await prisma.platformPaymentProviderConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, provider: true, label: true }
    });
    if (!existing) {
      await ctx.reply("Подключение не найдено.");
      return;
    }

    pendingBotConnections.delete(ctx.from.id);
    pendingTextActions.delete(ctx.from.id);
    pendingPlatformProviderSecrets.set(ctx.from.id, {
      kind: "ROTATE",
      connectionId,
      expiresAt: Date.now() + BOT_TOKEN_TTL_MS
    });
    await ctx.reply(
      `Отправьте новые реквизиты для ${existing.provider} «${existing.label}» отдельным сообщением в формате JSON.\n` +
      "Сообщение будет удалено по возможности. После ротации статус станет PENDING до повторной проверки.\n" +
      "Ожидание — 5 минут. Для отмены: /cancel"
    );
  });

  bot.command("platformprovidercheck", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        !isPlatformAdminTelegramId(ctx.from.id, process.env.PLATFORM_ADMIN_TELEGRAM_IDS)) {
      await ctx.reply("Команда доступна только уполномоченным операторам SubPilot в личном чате.");
      return;
    }

    const connectionId = String(ctx.match ?? "").trim();
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(connectionId)) {
      await ctx.reply("Формат: /platformprovidercheck CONNECTION_ID");
      return;
    }
    try {
      const actor = await upsertTelegramUser(ctx);
      const result = await verifyPlatformProviderConnection({
        connectionId,
        actorUserId: actor.id,
        verifiers: platformProviderCredentialVerifiers
      });
      await ctx.reply(
        result.verification === "VERIFIED"
          ? `Реквизиты ${result.connection.provider} «${result.connection.label}» проверены провайдером. Подключение активно.`
          : `Провайдер отклонил реквизиты ${result.connection.provider} «${result.connection.label}». Код: ${result.errorCode ?? "VERIFICATION_FAILED"}. Подключение неактивно.`
      );
    } catch (error) {
      if (error instanceof PlatformProviderConnectionError) {
        const messages: Record<string, string> = {
          CONNECTION_NOT_FOUND: "Подключение не найдено.",
          CONNECTION_DISABLED: "Подключение отключено. Сначала замените реквизиты или создайте новое подключение.",
          ADAPTER_NOT_CONFIGURED: "Для этого провайдера ещё нет реализованной проверки реквизитов. Состояние подключения не изменено.",
          CONNECTION_CHANGED_DURING_VERIFICATION: "Реквизиты или состояние подключения изменились во время проверки. Запустите проверку заново."
        };
        await ctx.reply(messages[error.code] ?? "Не удалось проверить подключение.");
      } else {
        console.error("Platform provider verification failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Проверка подключения завершилась ошибкой. Секреты не выводились в журнал.");
      }
    }
  });

  bot.command("platformproviderdisable", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        !isPlatformAdminTelegramId(ctx.from.id, process.env.PLATFORM_ADMIN_TELEGRAM_IDS)) {
      await ctx.reply("Команда доступна только уполномоченным операторам SubPilot в личном чате.");
      return;
    }

    const connectionId = String(ctx.match ?? "").trim();
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(connectionId)) {
      await ctx.reply("Формат: /platformproviderdisable CONNECTION_ID");
      return;
    }
    try {
      const actor = await upsertTelegramUser(ctx);
      const connection = await disablePlatformProviderConnection(connectionId, actor.id);
      await ctx.reply(`Подключение ${connection.provider} «${connection.label}» отключено. История платежей сохранена.`);
    } catch (error) {
      if (error instanceof PlatformProviderConnectionError &&
          error.code === "CONNECTION_NOT_FOUND") {
        await ctx.reply("Подключение не найдено.");
      } else {
        console.error("Platform provider connection disable failed:", error instanceof Error ? error.name : "UnknownError");
        await ctx.reply("Не удалось отключить подключение.");
      }
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "SubPilot — управление платными Telegram-сообществами.\n\n" +
      "/start — открыть кабинет\n" +
      "/newproject Название — создать проект\n" +
      "/projectmembers PROJECT_ID — состав проектной команды\n" +
      "/setprojectmember PROJECT_ID TELEGRAM_ID [MANAGER|VIEWER] — выдать проектный доступ\n" +
      "/removeprojectmember PROJECT_ID TELEGRAM_ID — снять проектный доступ\n" +
      "/projects — проекты активного пространства\n" +
      "/agencyportfolio — портфель агентства по авторам\n" +
      "/assigncreator PROJECT_ID TELEGRAM_ID — назначить автора проекта\n" +
      "/unassigncreator PROJECT_ID — снять автора с проекта\n" +
      "/createagency Название — создать агентство\n" +
      "/invite [ROLE] — одноразовая ссылка для участника\n" +
      "/setmemberrole TELEGRAM_ID [ADMIN|MANAGER|VIEWER] — изменить роль участника\n" +
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
      "/projectstats PROJECT_ID [DAYS] — агрегированная статистика проекта\n" +
      "/auditlog PROJECT_ID [LIMIT] — история действий проекта\n" +
      "/agencyaudit [LIMIT] — история агентства по доступным проектам\n" +
      "/agencyauditexport [DAYS] — выгрузить историю агентства в CSV\n" +
      "/grantaccess PROJECT_ID | TELEGRAM_ID | PLAN_ID | DAYS — вручную выдать доступ\n" +
      "/trialaccess PROJECT_ID | TELEGRAM_ID | PLAN_ID | DAYS — выдать пробный доступ\n" +
      "/activesubscriptions PROJECT_ID — список активных подписок\n" +
      "/revokeaccess SUBSCRIPTION_ID — досрочно отозвать доступ\n" +
      "/plans ID — посмотреть тарифы\n" +
      "/payments ID — история платежей проекта\n" +
      "/testnotifications — отправить четыре тестовых уведомления себе\n" +
      "/failednotifications — показать уведомления с исчерпанными попытками\n" +
      "/retrynotification ID — вернуть уведомление в очередь\n" +
      "/faileddeliveries — показать выдачи доступа с исчерпанными попытками\n" +
      "/retrydelivery ID — вернуть выдачу доступа в очередь\n" +
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
