import { prisma } from "@subpilot/database";
import {
  evaluateWorkspacePlanLimit,
  parseWorkspacePlanFeatureConfig,
  type WorkspacePlanFeatureConfig,
  type WorkspaceLimitDecision
} from "./workspace-plan-limits.js";

export interface WorkspaceProjectQuotaUsage {
  id: string;
  name: string;
  plans: number;
  connectedChats: number;
  plansDecision?: WorkspaceLimitDecision;
  connectedChatsDecision?: WorkspaceLimitDecision;
}

export interface WorkspaceBillingOverview {
  workspaceName: string;
  usage: {
    projects: number;
    members: number;
    projectsDecision?: WorkspaceLimitDecision;
    membersDecision?: WorkspaceLimitDecision;
    projectUsage: WorkspaceProjectQuotaUsage[];
  };
  billing: null | {
    status: string;
    currentPeriodEnd: Date | null;
    plan: {
      code: string;
      title: string;
      price: string;
      currency: string;
      billingPeriodDays: number;
      isActive: boolean;
    };
    configuration: "valid" | "invalid";
    featureConfig?: WorkspacePlanFeatureConfig;
  };
}

const BILLING_STATUS_LABELS: Record<string, string> = {
  TRIALING: "пробный период",
  ACTIVE: "активен",
  PAST_DUE: "есть задолженность",
  CANCELLED: "отменён",
  EXPIRED: "истёк"
};

function usageLabel(usage: number, limit: number | null): string {
  if (limit === null) return `${usage} / без ограничений`;
  if (limit === 0) return `${usage} / отключено (0)`;
  return `${usage} / ${limit}`;
}

/**
 * Loads the currently assigned platform plan and live usage for one workspace.
 * Projects count only non-archived projects; plan and chat quotas are evaluated
 * separately for every project, never summed across the workspace.
 */
export async function getWorkspaceBillingOverview(
  workspaceId: string
): Promise<WorkspaceBillingOverview | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      name: true,
      _count: { select: { members: true } },
      projects: {
        where: { status: { not: "ARCHIVED" } },
        select: {
          id: true,
          name: true,
          plans: {
            where: { status: "ACTIVE" },
            select: { id: true }
          },
          chats: {
            where: { isActive: true },
            select: { id: true }
          }
        }
      },
      billing: {
        include: { platformPlan: true }
      }
    }
  });

  if (!workspace) return null;

  const projectUsage: WorkspaceProjectQuotaUsage[] = workspace.projects.map((project) => ({
    id: project.id,
    name: project.name,
    plans: project.plans.length,
    connectedChats: project.chats.length
  }));

  const usage: WorkspaceBillingOverview["usage"] = {
    projects: workspace.projects.length,
    members: workspace._count.members,
    projectUsage
  };

  if (!workspace.billing) {
    return {
      workspaceName: workspace.name,
      usage,
      billing: null
    };
  }

  let featureConfig: WorkspacePlanFeatureConfig | undefined;
  let configuration: "valid" | "invalid" = "valid";
  try {
    featureConfig = parseWorkspacePlanFeatureConfig(workspace.billing.platformPlan.features);
  } catch {
    configuration = "invalid";
  }

  if (featureConfig) {
    usage.projectsDecision = evaluateWorkspacePlanLimit(
      featureConfig,
      "projects",
      usage.projects
    );
    usage.membersDecision = evaluateWorkspacePlanLimit(
      featureConfig,
      "members",
      usage.members
    );
    for (const project of projectUsage) {
      project.plansDecision = evaluateWorkspacePlanLimit(
        featureConfig,
        "plansPerProject",
        project.plans
      );
      project.connectedChatsDecision = evaluateWorkspacePlanLimit(
        featureConfig,
        "connectedChatsPerProject",
        project.connectedChats
      );
    }
  }

  return {
    workspaceName: workspace.name,
    usage,
    billing: {
      status: workspace.billing.status,
      currentPeriodEnd: workspace.billing.currentPeriodEnd,
      plan: {
        code: workspace.billing.platformPlan.code,
        title: workspace.billing.platformPlan.title,
        price: workspace.billing.platformPlan.price.toString(),
        currency: workspace.billing.platformPlan.currency,
        billingPeriodDays: workspace.billing.platformPlan.billingPeriodDays,
        isActive: workspace.billing.platformPlan.isActive
      },
      configuration,
      ...(featureConfig ? { featureConfig } : {})
    }
  };
}

function quotaDisplay(
  usage: number,
  decision: WorkspaceLimitDecision | undefined
): string {
  return decision ? usageLabel(usage, decision.limit) : String(usage);
}

/** Formats a billing overview for the private control-bot workspace screen. */
export function formatWorkspaceBillingOverview(
  overview: WorkspaceBillingOverview
): string {
  const lines = [
    `💳 Тариф пространства «${overview.workspaceName}»`,
    ""
  ];

  if (!overview.billing) {
    lines.push(
      "Тариф платформы пока не назначен.",
      "Текущее использование ресурсов отображается справочно; лимиты тарифа ещё не применяются.",
      ""
    );
  } else {
    const billing = overview.billing;
    lines.push(
      `План: ${billing.plan.title} (${billing.plan.code})`,
      `Стоимость: ${billing.plan.price} ${billing.plan.currency} за ${billing.plan.billingPeriodDays} дн.`,
      `Статус подписки: ${BILLING_STATUS_LABELS[billing.status] ?? billing.status.toLowerCase()}`
    );
    if (!billing.plan.isActive) lines.push("⚠️ План выключен в каталоге.");
    if (billing.currentPeriodEnd) {
      lines.push(
        `Окончание периода: ${billing.currentPeriodEnd.toLocaleDateString("ru-RU", { timeZone: "UTC" })}`
      );
    }
    if (billing.configuration === "invalid") {
      lines.push(
        "",
        "⚠️ Конфигурация лимитов тарифа некорректна. Показать лимиты невозможно; обратитесь к поддержке."
      );
    }
    lines.push("");
  }

  lines.push(
    "Использование пространства:",
    `• Проекты: ${quotaDisplay(overview.usage.projects, overview.usage.projectsDecision)}`,
    `• Участники (включая владельца): ${quotaDisplay(overview.usage.members, overview.usage.membersDecision)}`,
    "",
    "Использование по проектам:"
  );

  if (overview.usage.projectUsage.length === 0) {
    lines.push("• Активных проектов пока нет.");
  } else {
    for (const project of overview.usage.projectUsage) {
      lines.push(
        `• ${project.name}`,
        `  Тарифы авторов: ${quotaDisplay(project.plans, project.plansDecision)}`,
        `  Активные площадки: ${quotaDisplay(project.connectedChats, project.connectedChatsDecision)}`
      );
    }
  }

  return lines.join("\n");
}
