import { prisma } from "@subpilot/database";

export interface CurrencyRevenue {
  currency: string;
  successfulPayments: number;
  grossAmount: string;
  refundedPayments: number;
  refundedAmount: string;
  netAmount: string;
}

export interface ProjectAnalytics {
  projectId: string;
  projectName: string;
  periodDays: number;
  from: Date;
  to: Date;
  activeSubscriptions: number;
  uniqueActiveCustomers: number;
  newSubscriptions: number;
  expiredSubscriptions: number;
  cancelledSubscriptions: number;
  newTrials: number;
  manualGrants: number;
  successfulPayments: number;
  repeatPayingSubscriptions: number;
  refundedPayments: number;
  revenueByCurrency: CurrencyRevenue[];
  activePlans: Array<{ planId: string; title: string; activeSubscriptions: number }>;
}

function amountToMinorUnits(amount: string): bigint {
  const normalized = amount.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) throw new Error("Invalid decimal amount returned by database.");
  const major = BigInt(match[1] ?? "0");
  const minor = BigInt((match[2] ?? "").padEnd(2, "0"));
  return major * 100n + minor;
}

function minorUnitsToAmount(amount: bigint): string {
  const sign = amount < 0n ? "-" : "";
  const positive = amount < 0n ? -amount : amount;
  return sign + (positive / 100n).toString() + "." + (positive % 100n).toString().padStart(2, "0");
}

export async function getProjectAnalytics(input: {
  workspaceId: string;
  projectId: string;
  periodDays?: number;
  now?: Date;
}): Promise<ProjectAnalytics> {
  const periodDays = input.periodDays ?? 30;
  if (!Number.isSafeInteger(periodDays) || periodDays < 1 || periodDays > 365) {
    throw new Error("Analytics period must be between 1 and 365 days.");
  }
  const to = input.now ?? new Date();
  const from = new Date(to.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const project = await prisma.project.findFirst({
    where: { id: input.projectId, workspaceId: input.workspaceId, status: "ACTIVE" },
    select: { id: true, name: true }
  });
  if (!project) throw new Error("Project not found in the active workspace.");

  const activeSubscriptionWhere = {
    projectId: project.id,
    status: "ACTIVE" as const,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: to } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: to } }] }
    ]
  };
  const [
    activeSubscriptions,
    activeCustomerGroups,
    newSubscriptions,
    expiredSubscriptions,
    cancelledSubscriptions,
    newTrials,
    manualGrants,
    paidByCurrency,
    refundsByCurrency,
    successfulPaymentCount,
    paidSubscriptionGroups,
    activePlanGroups
  ] = await Promise.all([
    prisma.subscription.count({ where: activeSubscriptionWhere }),
    prisma.subscription.groupBy({
      by: ["customerId"],
      where: activeSubscriptionWhere
    }),
    prisma.subscription.count({
      where: { projectId: project.id, createdAt: { gte: from, lte: to } }
    }),
    prisma.subscription.count({
      where: { projectId: project.id, status: "EXPIRED", endsAt: { gte: from, lte: to } }
    }),
    prisma.subscription.count({
      where: { projectId: project.id, status: "CANCELLED", cancelledAt: { gte: from, lte: to } }
    }),
    prisma.subscription.count({
      where: { projectId: project.id, grantType: "TRIAL", createdAt: { gte: from, lte: to } }
    }),
    prisma.subscription.count({
      where: { projectId: project.id, grantType: "MANUAL", createdAt: { gte: from, lte: to } }
    }),
    prisma.payment.groupBy({
      by: ["currency"],
      where: { projectId: project.id, status: "SUCCEEDED", paidAt: { gte: from, lte: to } },
      _sum: { amount: true },
      _count: { _all: true }
    }),
    prisma.payment.groupBy({
      by: ["currency"],
      where: { projectId: project.id, status: "REFUNDED", refundedAt: { gte: from, lte: to } },
      _sum: { amount: true },
      _count: { _all: true }
    }),
    prisma.payment.count({
      where: { projectId: project.id, status: "SUCCEEDED", paidAt: { gte: from, lte: to } }
    }),
    prisma.payment.groupBy({
      by: ["subscriptionId"],
      where: {
        projectId: project.id,
        status: "SUCCEEDED",
        paidAt: { gte: from, lte: to },
        subscriptionId: { not: null }
      },
      _count: { _all: true }
    }),
    prisma.subscription.groupBy({
      by: ["planId"],
      where: activeSubscriptionWhere,
      _count: { _all: true }
    })
  ]);

  const revenue = new Map<string, {
    successfulPayments: number;
    gross: bigint;
    refundedPayments: number;
    refunds: bigint;
  }>();
  for (const row of paidByCurrency) {
    revenue.set(row.currency, {
      successfulPayments: row._count._all,
      gross: amountToMinorUnits(row._sum.amount?.toString() ?? "0"),
      refundedPayments: 0,
      refunds: 0n
    });
  }
  for (const row of refundsByCurrency) {
    const current = revenue.get(row.currency) ?? {
      successfulPayments: 0,
      gross: 0n,
      refundedPayments: 0,
      refunds: 0n
    };
    current.refundedPayments = row._count._all;
    current.refunds = amountToMinorUnits(row._sum.amount?.toString() ?? "0");
    revenue.set(row.currency, current);
  }
  const revenueByCurrency = [...revenue.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, value]) => ({
      currency,
      successfulPayments: value.successfulPayments,
      grossAmount: minorUnitsToAmount(value.gross),
      refundedPayments: value.refundedPayments,
      refundedAmount: minorUnitsToAmount(value.refunds),
      netAmount: minorUnitsToAmount(value.gross - value.refunds)
    }));

  const activePlanIds = activePlanGroups.map((item) => item.planId);
  const plans = activePlanIds.length
    ? await prisma.creatorPlan.findMany({
        where: { id: { in: activePlanIds } },
        select: { id: true, title: true }
      })
    : [];
  const planTitleById = new Map(plans.map((plan) => [plan.id, plan.title]));
  const activePlans = activePlanGroups
    .map((item) => ({
      planId: item.planId,
      title: planTitleById.get(item.planId) ?? "Tariff",
      activeSubscriptions: item._count._all
    }))
    .sort((left, right) =>
      right.activeSubscriptions - left.activeSubscriptions || left.title.localeCompare(right.title)
    )
    .slice(0, 10);

  return {
    projectId: project.id,
    projectName: project.name,
    periodDays,
    from,
    to,
    activeSubscriptions,
    uniqueActiveCustomers: activeCustomerGroups.length,
    newSubscriptions,
    expiredSubscriptions,
    cancelledSubscriptions,
    newTrials,
    manualGrants,
    successfulPayments: successfulPaymentCount,
    repeatPayingSubscriptions: paidSubscriptionGroups.filter((row) => row._count._all > 1).length,
    refundedPayments: refundsByCurrency.reduce((sum, row) => sum + row._count._all, 0),
    revenueByCurrency,
    activePlans
  };
}

export async function listProjectAuditHistory(input: {
  workspaceId: string;
  projectId: string;
  limit?: number;
}) {
  const limit = Number.isSafeInteger(input.limit) ? Math.min(25, Math.max(1, input.limit ?? 10)) : 10;
  const project = await prisma.project.findFirst({
    where: { id: input.projectId, workspaceId: input.workspaceId },
    select: { id: true }
  });
  if (!project) throw new Error("Project not found in the active workspace.");

  const events = await prisma.auditLog.findMany({
    where: { workspaceId: input.workspaceId, projectId: project.id },
    include: {
      actor: { select: { firstName: true, username: true } }
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit
  });

  // Keep the audit feed operational: expose action/resource/time only, never raw
  // metadata which can contain IDs, payment references or other personal details.
  return events.map((event) => ({
    id: event.id,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    actor: event.actor?.firstName ?? event.actor?.username ?? "System",
    createdAt: event.createdAt
  }));
}
