import { prisma } from "@subpilot/database";
import { Bot } from "grammy";
import { decryptSecret } from "@subpilot/security";

type Transaction = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">;

export class ManualSubscriptionAccessError extends Error {
  constructor(public readonly code:
    | "INVALID_TELEGRAM_USER_ID"
    | "INVALID_DURATION"
    | "ACTOR_NOT_AUTHORIZED"
    | "PROJECT_NOT_FOUND"
    | "PLAN_NOT_AVAILABLE"
    | "NO_PLAN_DESTINATIONS"
    | "TRIAL_NOT_CONFIGURED"
    | "TRIAL_ALREADY_USED"
    | "SUBSCRIPTION_NOT_FOUND"
    | "SUBSCRIPTION_NOT_ACTIVE"
    | "TELEGRAM_RENEWAL_CANCEL_FAILED"
  ) {
    super(code);
    this.name = "ManualSubscriptionAccessError";
  }
}

interface AccessOperationInput {
  workspaceId: string;
  projectId: string;
  planId: string;
  telegramUserId: string;
  actorUserId: string;
}

function parseTelegramUserId(value: string): bigint {
  if (!/^\d{1,20}$/.test(value)) {
    throw new ManualSubscriptionAccessError("INVALID_TELEGRAM_USER_ID");
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new ManualSubscriptionAccessError("INVALID_TELEGRAM_USER_ID");
  return parsed;
}

function validateDuration(days: number | null): void {
  if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > 3650)) {
    throw new ManualSubscriptionAccessError("INVALID_DURATION");
  }
}

interface TelegramStarRenewalCancellationInput {
  telegramUserId: bigint;
  telegramPaymentChargeId: string;
  encryptedBotToken: string;
}

type TelegramStarRenewalCanceller = (
  input: TelegramStarRenewalCancellationInput
) => Promise<boolean>;

async function cancelTelegramStarRenewal(
  input: TelegramStarRenewalCancellationInput
): Promise<boolean> {
  const telegramUserId = Number(input.telegramUserId);
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return false;

  const bot = new Bot(decryptSecret(input.encryptedBotToken));
  const rawApi = bot.api.raw as unknown as {
    editUserStarSubscription: (args: {
      user_id: number;
      telegram_payment_charge_id: string;
      is_canceled: boolean;
    }) => Promise<boolean>;
  };

  return rawApi.editUserStarSubscription({
    user_id: telegramUserId,
    telegram_payment_charge_id: input.telegramPaymentChargeId,
    is_canceled: true
  });
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
  if (!membership) throw new ManualSubscriptionAccessError("ACTOR_NOT_AUTHORIZED");
}

async function validateProjectAndPlan(
  tx: Transaction,
  input: AccessOperationInput
) {
  const project = await tx.project.findFirst({
    where: {
      id: input.projectId,
      workspaceId: input.workspaceId,
      status: "ACTIVE"
    },
    select: { id: true, name: true }
  });
  if (!project) throw new ManualSubscriptionAccessError("PROJECT_NOT_FOUND");

  const plan = await tx.creatorPlan.findFirst({
    where: {
      id: input.planId,
      projectId: project.id,
      status: "ACTIVE"
    },
    include: {
      chats: { select: { connectedChatId: true } }
    }
  });
  if (!plan) throw new ManualSubscriptionAccessError("PLAN_NOT_AVAILABLE");
  if (plan.chats.length === 0) throw new ManualSubscriptionAccessError("NO_PLAN_DESTINATIONS");
  return { project, plan };
}

async function ensureCustomer(
  tx: Transaction,
  projectId: string,
  telegramUserId: bigint
) {
  return tx.projectCustomer.upsert({
    where: {
      projectId_telegramUserId: { projectId, telegramUserId }
    },
    update: {},
    create: { projectId, telegramUserId }
  });
}

async function ensureAccessGrantRows(
  tx: Transaction,
  subscriptionId: string,
  connectedChatIds: string[],
  now: Date
): Promise<void> {
  // Explicit manual re-grant is an authorization change. Serialize it with any
  // in-flight invite delivery for this subscription before clearing grant revokes.
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
    subscriptionId
  );
  await tx.subscriptionAccessGrant.createMany({
    data: connectedChatIds.map((connectedChatId) => ({
      subscriptionId,
      connectedChatId,
      inviteLink: "",
      expiresAt: new Date(0),
      deliveryNextAttemptAt: now
    })),
    skipDuplicates: true
  });
  await tx.subscriptionAccessGrant.updateMany({
    where: {
      subscriptionId,
      connectedChatId: { in: connectedChatIds },
      revokedAt: { not: null }
    },
    data: {
      inviteLink: "",
      expiresAt: new Date(0),
      joinedAt: null,
      revokedAt: null,
      deliveryAttempts: 0,
      deliveryNextAttemptAt: now,
      deliveryLastError: null,
      deliveryFailedAt: null
    }
  });
}

export async function grantManualSubscriptionAccess(input: AccessOperationInput & {
  durationDays?: number | null;
}): Promise<{
  subscriptionId: string;
  projectName: string;
  planTitle: string;
  telegramUserId: string;
  endsAt: Date | null;
  renewedExistingGrant: boolean;
  destinations: number;
}> {
  const telegramUserId = parseTelegramUserId(input.telegramUserId);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    await assertWorkspaceAdmin(tx, input.workspaceId, input.actorUserId);
    const { project, plan } = await validateProjectAndPlan(tx, input);
    const durationDays = input.durationDays === undefined ? plan.durationDays : input.durationDays;
    validateDuration(durationDays);

    const customer = await ensureCustomer(tx, project.id, telegramUserId);
    const existing = await tx.subscription.findFirst({
      where: {
        projectId: project.id,
        customerId: customer.id,
        planId: plan.id,
        grantType: "MANUAL",
        status: "ACTIVE",
        OR: [{ endsAt: null }, { endsAt: { gt: now } }]
      },
      orderBy: [{ endsAt: "desc" }, { createdAt: "desc" }]
    });

    let subscriptionId: string;
    let endsAt: Date | null;
    if (existing) {
      endsAt = durationDays === null || existing.endsAt === null
        ? null
        : new Date(Math.max(now.getTime(), existing.endsAt.getTime()) +
            durationDays * 24 * 60 * 60 * 1000);
      const updated = await tx.subscription.update({
        where: { id: existing.id },
        data: { endsAt }
      });
      subscriptionId = updated.id;
    } else {
      endsAt = durationDays === null
        ? null
        : new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
      const created = await tx.subscription.create({
        data: {
          projectId: project.id,
          customerId: customer.id,
          planId: plan.id,
          status: "ACTIVE",
          grantType: "MANUAL",
          startsAt: now,
          endsAt
        }
      });
      subscriptionId = created.id;
    }

    const connectedChatIds = plan.chats.map((chat) => chat.connectedChatId);
    await ensureAccessGrantRows(tx, subscriptionId, connectedChatIds, now);
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: project.id,
        actorUserId: input.actorUserId,
        action: "SUBSCRIPTION_ACCESS_GRANTED_MANUALLY",
        resourceType: "Subscription",
        resourceId: subscriptionId,
        metadata: {
          telegramUserId: telegramUserId.toString(),
          planId: plan.id,
          durationDays,
          endsAt: endsAt?.toISOString() ?? null,
          destinations: connectedChatIds.length,
          extendedExistingManualGrant: Boolean(existing)
        }
      }
    });

    return {
      subscriptionId,
      projectName: project.name,
      planTitle: plan.title,
      telegramUserId: telegramUserId.toString(),
      endsAt,
      renewedExistingGrant: Boolean(existing),
      destinations: connectedChatIds.length
    };
  }, { isolationLevel: "ReadCommitted" });
}

export async function grantTrialSubscriptionAccess(input: AccessOperationInput & {
  durationDays?: number;
}): Promise<{
  subscriptionId: string;
  projectName: string;
  planTitle: string;
  telegramUserId: string;
  endsAt: Date;
  destinations: number;
}> {
  const telegramUserId = parseTelegramUserId(input.telegramUserId);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    await assertWorkspaceAdmin(tx, input.workspaceId, input.actorUserId);
    const { project, plan } = await validateProjectAndPlan(tx, input);
    const durationDays = input.durationDays ?? plan.trialDays;
    if (durationDays <= 0) throw new ManualSubscriptionAccessError("TRIAL_NOT_CONFIGURED");
    validateDuration(durationDays);

    const customer = await ensureCustomer(tx, project.id, telegramUserId);
    const priorTrial = await tx.subscription.findFirst({
      where: {
        customerId: customer.id,
        planId: plan.id,
        grantType: "TRIAL"
      },
      select: { id: true }
    });
    const activeSubscription = await tx.subscription.findFirst({
      where: {
        customerId: customer.id,
        planId: plan.id,
        status: "ACTIVE",
        OR: [{ endsAt: null }, { endsAt: { gt: now } }]
      },
      select: { id: true }
    });
    if (priorTrial || activeSubscription) {
      throw new ManualSubscriptionAccessError("TRIAL_ALREADY_USED");
    }

    const endsAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    const created = await tx.subscription.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        planId: plan.id,
        status: "ACTIVE",
        grantType: "TRIAL",
        startsAt: now,
        endsAt
      }
    });
    const connectedChatIds = plan.chats.map((chat) => chat.connectedChatId);
    await ensureAccessGrantRows(tx, created.id, connectedChatIds, now);
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: project.id,
        actorUserId: input.actorUserId,
        action: "SUBSCRIPTION_TRIAL_GRANTED",
        resourceType: "Subscription",
        resourceId: created.id,
        metadata: {
          telegramUserId: telegramUserId.toString(),
          planId: plan.id,
          trialDays: durationDays,
          endsAt: endsAt.toISOString(),
          destinations: connectedChatIds.length
        }
      }
    });

    return {
      subscriptionId: created.id,
      projectName: project.name,
      planTitle: plan.title,
      telegramUserId: telegramUserId.toString(),
      endsAt,
      destinations: connectedChatIds.length
    };
  }, { isolationLevel: "ReadCommitted" });
}

export async function revokeSubscriptionAccessManually(
  input: {
    subscriptionId: string;
    workspaceId: string;
    actorUserId: string;
  },
  dependencies: { cancelTelegramRenewal?: TelegramStarRenewalCanceller } = {}
): Promise<{
  subscriptionId: string;
  projectName: string;
  planTitle: string;
  recurringRenewalCancelled: boolean;
}> {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // Keep one subscription-row lock across the Telegram cancellation request and
    // local state transition. Buyer cancel/resume and payment webhooks use the same
    // lock, so none can re-enable renewal or access between these two operations.
    await lockWorkspace(tx, input.workspaceId);
    await assertWorkspaceAdmin(tx, input.workspaceId, input.actorUserId);
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
      input.subscriptionId
    );

    const target = await tx.subscription.findUnique({
      where: { id: input.subscriptionId },
      select: {
        id: true,
        projectId: true,
        project: { select: { workspaceId: true, name: true } },
        plan: { select: { title: true } },
        customer: { select: { telegramUserId: true } },
        status: true,
        telegramStarInitialChargeId: true,
        telegramStarSubscriptionState: true
      }
    });
    if (!target || target.project.workspaceId !== input.workspaceId) {
      throw new ManualSubscriptionAccessError("SUBSCRIPTION_NOT_FOUND");
    }
    if (target.status !== "ACTIVE") {
      throw new ManualSubscriptionAccessError("SUBSCRIPTION_NOT_ACTIVE");
    }

    const hasRecurringAnchor = Boolean(target.telegramStarInitialChargeId);
    if (target.telegramStarInitialChargeId && target.telegramStarSubscriptionState !== "CANCELED") {
      const initialPayment = await tx.payment.findFirst({
        where: {
          subscriptionId: target.id,
          provider: "TELEGRAM_STARS",
          providerPaymentId: target.telegramStarInitialChargeId,
          status: { in: ["SUCCEEDED", "REFUNDING", "REFUNDED"] }
        },
        select: { metadata: true }
      });
      const metadata = initialPayment?.metadata && typeof initialPayment.metadata === "object" && !Array.isArray(initialPayment.metadata)
        ? initialPayment.metadata as Record<string, unknown>
        : null;
      const projectBotId = typeof metadata?.projectBotId === "string"
        ? metadata.projectBotId
        : null;
      if (!initialPayment || !projectBotId) {
        throw new ManualSubscriptionAccessError("TELEGRAM_RENEWAL_CANCEL_FAILED");
      }
      const projectBot = await tx.projectBot.findFirst({
        where: { id: projectBotId, projectId: target.projectId },
        select: { tokenEncrypted: true }
      });
      if (!projectBot) {
        throw new ManualSubscriptionAccessError("TELEGRAM_RENEWAL_CANCEL_FAILED");
      }

      let cancelled = false;
      try {
        cancelled = await (dependencies.cancelTelegramRenewal ?? cancelTelegramStarRenewal)({
          telegramUserId: target.customer.telegramUserId,
          telegramPaymentChargeId: target.telegramStarInitialChargeId,
          encryptedBotToken: projectBot.tokenEncrypted
        });
      } catch {
        cancelled = false;
      }
      if (!cancelled) {
        // Fail closed: never revoke a paid entitlement while Telegram may still renew it.
        throw new ManualSubscriptionAccessError("TELEGRAM_RENEWAL_CANCEL_FAILED");
      }
    }

    const updated = await tx.subscription.updateMany({
      where: { id: target.id, status: "ACTIVE" },
      data: {
        status: "CANCELLED",
        endsAt: now,
        cancelledAt: now,
        ...(hasRecurringAnchor ? { telegramStarSubscriptionState: "CANCELED" as const } : {})
      }
    });
    if (updated.count !== 1) throw new ManualSubscriptionAccessError("SUBSCRIPTION_NOT_ACTIVE");

    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: target.projectId,
        actorUserId: input.actorUserId,
        action: "SUBSCRIPTION_ACCESS_REVOKE_REQUESTED",
        resourceType: "Subscription",
        resourceId: target.id,
        metadata: {
          previousStatus: target.status,
          revokedAt: now.toISOString(),
          recurringRenewalCancelled: hasRecurringAnchor
        }
      }
    });

    return {
      subscriptionId: target.id,
      projectName: target.project.name,
      planTitle: target.plan.title,
      recurringRenewalCancelled: hasRecurringAnchor
    };
  }, { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 30_000 });
}
export async function listActiveProjectSubscriptions(input: {
  workspaceId: string;
  projectId: string;
  now?: Date;
  limit?: number;
}) {
  const now = input.now ?? new Date();
  const limit = Number.isSafeInteger(input.limit) ? Math.min(50, Math.max(1, input.limit ?? 20)) : 20;
  return prisma.subscription.findMany({
    where: {
      projectId: input.projectId,
      status: "ACTIVE",
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      project: { workspaceId: input.workspaceId, status: "ACTIVE" }
    },
    include: {
      customer: { select: { telegramUserId: true, username: true, firstName: true } },
      plan: { select: { title: true } }
    },
    orderBy: [{ endsAt: "asc" }, { createdAt: "desc" }],
    take: limit
  });
}
