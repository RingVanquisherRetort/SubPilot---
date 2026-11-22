import { prisma } from "@subpilot/database";
import { MAX_ACCESS_DELIVERY_ATTEMPTS } from "@subpilot/payments";

type Transaction = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">;

export class WorkspaceAccessDeliveryError extends Error {
  constructor(public readonly code: "ACTOR_NOT_AUTHORIZED") {
    super(code);
    this.name = "WorkspaceAccessDeliveryError";
  }
}

async function lockWorkspace(tx: Transaction, workspaceId: string): Promise<void> {
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "Workspace" WHERE "id" = $1 FOR UPDATE',
    workspaceId
  );
}

async function assertWorkspaceAdmin(
  tx: Transaction,
  workspaceId: string,
  actorUserId: string
): Promise<void> {
  const membership = await tx.workspaceMember.findFirst({
    where: {
      workspaceId,
      userId: actorUserId,
      role: { in: ["OWNER", "ADMIN"] }
    },
    select: { id: true }
  });
  if (!membership) throw new WorkspaceAccessDeliveryError("ACTOR_NOT_AUTHORIZED");
}

export async function listWorkspaceFailedAccessDeliveries(
  workspaceId: string,
  now = new Date(),
  limit = 10,
  projectId?: string
) {
  const safeLimit = Number.isSafeInteger(limit) ? Math.min(50, Math.max(1, limit)) : 10;
  return prisma.subscriptionAccessGrant.findMany({
    where: {
      deliveryAttempts: { gte: MAX_ACCESS_DELIVERY_ATTEMPTS },
      deliveryFailedAt: { not: null },
      revokedAt: null,
      subscription: {
        status: "ACTIVE",
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
        project: { workspaceId, ...(projectId ? { id: projectId } : {}) }
      }
    },
    include: {
      connectedChat: { select: { title: true, username: true, telegramChatId: true } },
      subscription: {
        select: {
          customer: { select: { telegramUserId: true } },
          plan: { select: { title: true } },
          project: { select: { id: true, name: true } }
        }
      }
    },
    orderBy: [{ deliveryFailedAt: "asc" }, { id: "asc" }],
    take: safeLimit
  });
}

export async function retryWorkspaceFailedAccessDelivery(input: {
  grantId: string;
  workspaceId: string;
  actorUserId: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const grant = await tx.subscriptionAccessGrant.findFirst({
      where: {
        id: input.grantId,
        deliveryAttempts: { gte: MAX_ACCESS_DELIVERY_ATTEMPTS },
        deliveryFailedAt: { not: null },
        revokedAt: null,
        subscription: {
          status: "ACTIVE",
          AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
          project: { workspaceId: input.workspaceId }
        }
      },
      select: {
        id: true,
        connectedChatId: true,
        subscription: { select: { projectId: true } }
      }
    });
    if (!grant) return false;

    await lockWorkspace(tx, input.workspaceId);
    await assertWorkspaceAdmin(tx, input.workspaceId, input.actorUserId);

    const restored = await tx.subscriptionAccessGrant.updateMany({
      where: {
        id: grant.id,
        deliveryAttempts: { gte: MAX_ACCESS_DELIVERY_ATTEMPTS },
        deliveryFailedAt: { not: null },
        revokedAt: null
      },
      data: {
        deliveryAttempts: 0,
        deliveryNextAttemptAt: now,
        deliveryLastError: "OPERATOR_RETRY_REQUESTED",
        deliveryFailedAt: null
      }
    });
    if (restored.count !== 1) return false;

    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: grant.subscription.projectId,
        actorUserId: input.actorUserId,
        action: "SUBSCRIPTION_ACCESS_DELIVERY_RETRIED",
        resourceType: "SubscriptionAccessGrant",
        resourceId: grant.id,
        metadata: { connectedChatId: grant.connectedChatId }
      }
    });
    return true;
  });
}
