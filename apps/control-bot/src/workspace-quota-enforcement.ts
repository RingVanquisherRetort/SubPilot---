import { prisma } from "@subpilot/database";
import {
  evaluateWorkspacePlanLimit,
  parseWorkspacePlanFeatureConfig,
  type WorkspacePlanLimitKey
} from "./workspace-plan-limits.js";

export class WorkspaceQuotaError extends Error {
  constructor(
    public readonly resource: WorkspacePlanLimitKey,
    public readonly limit: number,
    public readonly currentUsage: number
  ) {
    super(`Workspace quota exceeded: ${resource} (${currentUsage}/${limit}).`);
    this.name = "WorkspaceQuotaError";
  }
}

type QuotaTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function lockWorkspace(tx: QuotaTransaction, workspaceId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
}

export async function assertWorkspaceQuotaInTransaction(
  tx: QuotaTransaction,
  workspaceId: string,
  resource: WorkspacePlanLimitKey,
  projectId?: string
): Promise<void> {
  const billing = await tx.workspaceBilling.findUnique({
    where: { workspaceId },
    include: { platformPlan: true }
  });

  // Existing workspaces without a platform subscription remain unaffected until
  // an explicit plan is assigned. This is transitional, not an unlimited plan.
  if (!billing) return;

  if (!["ACTIVE", "TRIALING"].includes(billing.status)) {
    throw new Error("Подписка рабочего пространства не активна. Управление ресурсами временно ограничено.");
  }
  if (!billing.platformPlan.isActive) {
    throw new Error("Тариф рабочего пространства отключён. Обратитесь к владельцу пространства.");
  }

  let config;
  try {
    config = parseWorkspacePlanFeatureConfig(billing.platformPlan.features);
  } catch {
    throw new Error("Не удалось проверить лимиты тарифа. Изменение не выполнено; обратитесь в поддержку.");
  }

  let currentUsage: number;
  switch (resource) {
    case "projects":
      currentUsage = await tx.project.count({
        where: { workspaceId, status: { not: "ARCHIVED" } }
      });
      break;
    case "members":
      currentUsage = await tx.workspaceMember.count({ where: { workspaceId } });
      break;
    case "plansPerProject":
      if (!projectId) throw new Error("Project ID is required for per-project plan quota.");
      currentUsage = await tx.creatorPlan.count({
        where: { projectId, status: "ACTIVE" }
      });
      break;
    case "connectedChatsPerProject":
      if (!projectId) throw new Error("Project ID is required for per-project chat quota.");
      currentUsage = await tx.connectedChat.count({
        where: { projectId, isActive: true }
      });
      break;
  }

  const decision = evaluateWorkspacePlanLimit(config, resource, currentUsage, 1);
  if (!decision.allowed && decision.limit !== null) {
    throw new WorkspaceQuotaError(resource, decision.limit, currentUsage);
  }
}

/**
 * Serializes quota-sensitive mutations on the workspace row. All callers must
 * perform their usage check and mutation inside this callback/transaction.
 */
export async function withWorkspaceQuotaTransaction<T>(
  workspaceId: string,
  resource: WorkspacePlanLimitKey,
  operation: (tx: QuotaTransaction) => Promise<T>,
  projectId?: string
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    await assertWorkspaceQuotaInTransaction(tx, workspaceId, resource, projectId);
    return operation(tx);
  }, { isolationLevel: "Serializable" });
}

export function formatWorkspaceQuotaError(error: unknown): string {
  if (error instanceof WorkspaceQuotaError) {
    const labels: Record<WorkspacePlanLimitKey, string> = {
      projects: "проектов",
      members: "участников",
      plansPerProject: "тарифов автора в проекте",
      connectedChatsPerProject: "активных каналов и групп в проекте"
    };
    return `Достигнут лимит тарифа: ${labels[error.resource]} — ${error.currentUsage} из ${error.limit}. Увеличьте тариф или освободите место.`;
  }
  if (error instanceof Error && /Подписка рабочего пространства|Тариф рабочего пространства|лимиты тарифа/.test(error.message)) {
    return error.message;
  }
  return "Не удалось проверить лимит тарифа. Попробуйте ещё раз или обратитесь в поддержку.";
}
