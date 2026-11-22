import { prisma } from "@subpilot/database";
import { lockWorkspace } from "./workspace-quota-enforcement.js";

export class AgencyAnalyticsError extends Error {
  constructor(public readonly code:
    | "WORKSPACE_NOT_FOUND"
    | "NOT_AN_AGENCY"
    | "ACTOR_NOT_MEMBER"
    | "PERMISSION_DENIED"
    | "INVALID_RANGE"
  ) {
    super(code);
    this.name = "AgencyAnalyticsError";
  }
}

interface CurrencyRevenue {
  currency: string;
  payments: number;
  grossAmount: string;
  refundedPayments: number;
  refundedAmount: string;
  netAmount: string;
}

interface ProjectMetric {
  projectId: string;
  projectName: string;
  creatorName: string;
  activeSubscriptions: number;
  newSubscriptions: number;
  expiredSubscriptions: number;
  cancelledSubscriptions: number;
  newTrials: number;
  manualGrants: number;
  successfulPayments: number;
  renewalPayments: number;
  renewingSubscriptions: number;
  refundedPayments: number;
  revenueByCurrency: CurrencyRevenue[];
}

function amountToMinorUnits(amount: string): bigint {
  const match = /^(\\d+)(?:\\.(\\d{1,2}))?$/.exec(amount.trim());
  if (!match) throw new Error("Invalid decimal amount returned by database.");
  return BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

function minorUnitsToAmount(amount: bigint): string {
  const sign = amount < 0n ? "-" : "";
  const positive = amount < 0n ? -amount : amount;
  return sign + (positive / 100n).toString() + "." +
    (positive % 100n).toString().padStart(2, "0");
}

function displayCreator(user: {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
} | null): string {
  if (!user) return "Не назначен";
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return fullName || (user.username ? "@" + user.username : "Без имени");
}

function mapCounts(rows: Array<{ projectId: string; _count: { _all: number } }>): Map<string, number> {
  return new Map(rows.map((row) => [row.projectId, row._count._all]));
}

function mergeRevenueRows(
  payments: Array<{
    projectId: string;
    currency: string;
    _sum: { amount: { toString(): string } | null };
    _count: { _all: number };
  }>,
  refunds: Array<{
    projectId: string;
    currency: string;
    _sum: { amount: { toString(): string } | null };
    _count: { _all: number };
  }>
): Map<string, Map<string, {
  payments: number;
  gross: bigint;
  refundedPayments: number;
  refunds: bigint;
}>> {
  const result = new Map<string, Map<string, {
    payments: number;
    gross: bigint;
    refundedPayments: number;
    refunds: bigint;
  }>>();
  const get = (projectId: string, currency: string) => {
    const project = result.get(projectId) ?? new Map();
    result.set(projectId, project);
    const current = project.get(currency) ?? {
      payments: 0,
      gross: 0n,
      refundedPayments: 0,
      refunds: 0n
    };
    project.set(currency, current);
    return current;
  };

  for (const row of payments) {
    const current = get(row.projectId, row.currency);
    current.payments = row._count._all;
    current.gross = amountToMinorUnits(row._sum.amount?.toString() ?? "0");
  }
  for (const row of refunds) {
    const current = get(row.projectId, row.currency);
    current.refundedPayments = row._count._all;
    current.refunds = amountToMinorUnits(row._sum.amount?.toString() ?? "0");
  }
  return result;
}

function formatRevenue(value: Map<string, {
  payments: number;
  gross: bigint;
  refundedPayments: number;
  refunds: bigint;
}> | undefined): CurrencyRevenue[] {
  return [...(value ?? new Map()).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, item]) => ({
      currency,
      payments: item.payments,
      grossAmount: minorUnitsToAmount(item.gross),
      refundedPayments: item.refundedPayments,
      refundedAmount: minorUnitsToAmount(item.refunds),
      netAmount: minorUnitsToAmount(item.gross - item.refunds)
    }));
}

export async function getAgencyAnalytics(input: {
  workspaceId: string;
  actorUserId: string;
  periodDays?: number;
  now?: Date;
}): Promise<{
  workspaceName: string;
  periodDays: number;
  from: Date;
  to: Date;
  activeSubscriptions: number;
  uniqueActiveSubscribers: number;
  newSubscriptions: number;
  newSubscribers: number;
  expiredSubscriptions: number;
  cancelledSubscriptions: number;
  churnEvents: number;
  activeAtPeriodStart: number;
  churnRatePercent: number;
  newTrials: number;
  manualGrants: number;
  successfulPayments: number;
  renewalPayments: number;
  renewingSubscriptions: number;
  refundedPayments: number;
  revenueByCurrency: CurrencyRevenue[];
  projects: ProjectMetric[];
}> {
  const periodDays = input.periodDays ?? 30;
  if (!Number.isSafeInteger(periodDays) || periodDays < 1 || periodDays > 365) {
    throw new AgencyAnalyticsError("INVALID_RANGE");
  }
  const to = input.now ?? new Date();
  const from = new Date(to.getTime() - periodDays * 24 * 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    const workspace = await tx.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { name: true, type: true }
    });
    if (!workspace) throw new AgencyAnalyticsError("WORKSPACE_NOT_FOUND");
    if (workspace.type !== "AGENCY") throw new AgencyAnalyticsError("NOT_AN_AGENCY");

    const membership = await tx.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.actorUserId
        }
      },
      select: { role: true }
    });
    if (!membership) throw new AgencyAnalyticsError("ACTOR_NOT_MEMBER");

    const hasWorkspaceWideAccess = membership.role === "OWNER" || membership.role === "ADMIN";
    const projects = await tx.project.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(!hasWorkspaceWideAccess ? {
          status: { not: "ARCHIVED" },
          OR: [
            { creatorUserId: input.actorUserId },
            { members: { some: { userId: input.actorUserId, role: "MANAGER" } } }
          ]
        } : {})
      },
      select: {
        id: true,
        name: true,
        creatorUser: { select: { firstName: true, lastName: true, username: true } }
      },
      orderBy: [{ name: "asc" }, { id: "asc" }]
    });
    if (!hasWorkspaceWideAccess && projects.length === 0) {
      throw new AgencyAnalyticsError("PERMISSION_DENIED");
    }

    const projectIds = projects.map((project) => project.id);
    const paymentStatuses = ["SUCCEEDED", "REFUNDING", "REFUNDED"] as const;
    const renewalStatuses = ["SUCCEEDED", "REFUNDING"] as const;
    const activeNowWhere = {
      projectId: { in: projectIds },
      status: "ACTIVE" as const,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: to } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: to } }] }
      ]
    };
    const inPeriod = { gte: from, lte: to };

    const [
      activeGroups,
      activeCustomers,
      newGroups,
      newCustomers,
      expiredGroups,
      cancelledGroups,
      trialGroups,
      manualGroups,
      activeAtStart,
      paidGroups,
      refundGroups,
      paymentsInPeriod,
      priorPaymentGroups
    ] = await Promise.all([
      tx.subscription.groupBy({
        by: ["projectId"],
        where: activeNowWhere,
        _count: { _all: true }
      }),
      tx.projectCustomer.findMany({
        where: {
          projectId: { in: projectIds },
          subscriptions: { some: activeNowWhere }
        },
        select: { telegramUserId: true }
      }),
      tx.subscription.groupBy({
        by: ["projectId"],
        where: { projectId: { in: projectIds }, createdAt: inPeriod },
        _count: { _all: true }
      }),
      tx.projectCustomer.findMany({
        where: {
          projectId: { in: projectIds },
          subscriptions: { some: { projectId: { in: projectIds }, createdAt: inPeriod } }
        },
        select: { telegramUserId: true }
      }),
      tx.subscription.groupBy({
        by: ["projectId"],
        where: { projectId: { in: projectIds }, status: "EXPIRED", endsAt: inPeriod },
        _count: { _all: true }
      }),
      tx.subscription.groupBy({
        by: ["projectId"],
        where: { projectId: { in: projectIds }, status: "CANCELLED", cancelledAt: inPeriod },
        _count: { _all: true }
      }),
      tx.subscription.groupBy({
        by: ["projectId"],
        where: { projectId: { in: projectIds }, grantType: "TRIAL", createdAt: inPeriod },
        _count: { _all: true }
      }),
      tx.subscription.groupBy({
        by: ["projectId"],
        where: { projectId: { in: projectIds }, grantType: "MANUAL", createdAt: inPeriod },
        _count: { _all: true }
      }),
      tx.subscription.count({
        where: {
          projectId: { in: projectIds },
          status: { in: ["ACTIVE", "EXPIRED", "CANCELLED"] },
          createdAt: { lte: from },
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: from } }] },
            { OR: [{ endsAt: null }, { endsAt: { gt: from } }] },
            { OR: [{ cancelledAt: null }, { cancelledAt: { gt: from } }] }
          ]
        }
      }),
      tx.payment.groupBy({
        by: ["projectId", "currency"],
        where: {
          projectId: { in: projectIds },
          status: { in: [...paymentStatuses] },
          paidAt: inPeriod
        },
        _sum: { amount: true },
        _count: { _all: true }
      }),
      tx.payment.groupBy({
        by: ["projectId", "currency"],
        where: {
          projectId: { in: projectIds },
          status: "REFUNDED",
          refundedAt: inPeriod
        },
        _sum: { amount: true },
        _count: { _all: true }
      }),
      tx.payment.groupBy({
        by: ["projectId", "subscriptionId"],
        where: {
          projectId: { in: projectIds },
          status: { in: [...renewalStatuses] },
          paidAt: inPeriod,
          subscriptionId: { not: null }
        },
        _count: { _all: true }
      }),
      tx.payment.groupBy({
        by: ["projectId", "subscriptionId"],
        where: {
          projectId: { in: projectIds },
          status: { in: [...renewalStatuses] },
          paidAt: { lt: from },
          subscriptionId: { not: null }
        },
        _count: { _all: true }
      })
    ]);

    const activeByProject = mapCounts(activeGroups);
    const newByProject = mapCounts(newGroups);
    const expiredByProject = mapCounts(expiredGroups);
    const cancelledByProject = mapCounts(cancelledGroups);
    const trialsByProject = mapCounts(trialGroups);
    const manualByProject = mapCounts(manualGroups);
    const priorCounts = new Map(
      priorPaymentGroups.map((row) => [
        row.projectId + ":" + row.subscriptionId,
        row._count._all
      ])
    );
    const renewalByProject = new Map<string, number>();
    const renewingSubsByProject = new Map<string, number>();
    for (const row of paymentsInPeriod) {
      const key = row.projectId + ":" + row.subscriptionId;
      const periodCount = row._count._all;
      const priorCount = priorCounts.get(key) ?? 0;
      const renewals = Math.max(0, periodCount - (priorCount > 0 ? 0 : 1));
      renewalByProject.set(row.projectId, (renewalByProject.get(row.projectId) ?? 0) + renewals);
      if (renewals > 0) {
        renewingSubsByProject.set(
          row.projectId,
          (renewingSubsByProject.get(row.projectId) ?? 0) + 1
        );
      }
    }

    const revenueByProject = mergeRevenueRows(paidGroups, refundGroups);
    const revenueTotals = new Map<string, {
      payments: number;
      gross: bigint;
      refundedPayments: number;
      refunds: bigint;
    }>();
    for (const projectRevenue of revenueByProject.values()) {
      for (const [currency, item] of projectRevenue) {
        const total = revenueTotals.get(currency) ?? {
          payments: 0,
          gross: 0n,
          refundedPayments: 0,
          refunds: 0n
        };
        total.payments += item.payments;
        total.gross += item.gross;
        total.refundedPayments += item.refundedPayments;
        total.refunds += item.refunds;
        revenueTotals.set(currency, total);
      }
    }

    const projectsReport = projects.map((project) => {
      const revenue = formatRevenue(revenueByProject.get(project.id));
      return {
        projectId: project.id,
        projectName: project.name,
        creatorName: displayCreator(project.creatorUser),
        activeSubscriptions: activeByProject.get(project.id) ?? 0,
        newSubscriptions: newByProject.get(project.id) ?? 0,
        expiredSubscriptions: expiredByProject.get(project.id) ?? 0,
        cancelledSubscriptions: cancelledByProject.get(project.id) ?? 0,
        newTrials: trialsByProject.get(project.id) ?? 0,
        manualGrants: manualByProject.get(project.id) ?? 0,
        successfulPayments: revenue.reduce((sum, item) => sum + item.payments, 0),
        renewalPayments: renewalByProject.get(project.id) ?? 0,
        renewingSubscriptions: renewingSubsByProject.get(project.id) ?? 0,
        refundedPayments: revenue.reduce((sum, item) => sum + item.refundedPayments, 0),
        revenueByCurrency: revenue
      };
    }).sort((a, b) =>
      b.activeSubscriptions - a.activeSubscriptions ||
      b.newSubscriptions - a.newSubscriptions ||
      a.projectName.localeCompare(b.projectName, "ru")
    );

    const activeSubscribers = new Set(activeCustomers.map((customer) => customer.telegramUserId.toString()));
    const newSubscribers = new Set(newCustomers.map((customer) => customer.telegramUserId.toString()));
    const newSubscriptions = projectsReport.reduce((sum, project) => sum + project.newSubscriptions, 0);
    const expiredSubscriptions = projectsReport.reduce((sum, project) => sum + project.expiredSubscriptions, 0);
    const cancelledSubscriptions = projectsReport.reduce((sum, project) => sum + project.cancelledSubscriptions, 0);
    const successfulPayments = projectsReport.reduce((sum, project) => sum + project.successfulPayments, 0);
    const renewalPayments = projectsReport.reduce((sum, project) => sum + project.renewalPayments, 0);
    const renewingSubscriptions = projectsReport.reduce((sum, project) => sum + project.renewingSubscriptions, 0);
    const refundedPayments = projectsReport.reduce((sum, project) => sum + project.refundedPayments, 0);
    const churnEvents = expiredSubscriptions + cancelledSubscriptions;
    const activeSubscriptions = projectsReport.reduce((sum, project) => sum + project.activeSubscriptions, 0);

    return {
      workspaceName: workspace.name,
      periodDays,
      from,
      to,
      activeSubscriptions,
      uniqueActiveSubscribers: activeSubscribers.size,
      newSubscriptions,
      newSubscribers: newSubscribers.size,
      expiredSubscriptions,
      cancelledSubscriptions,
      churnEvents,
      activeAtPeriodStart: activeAtStart,
      churnRatePercent: activeAtPeriodStart > 0
        ? Math.round((churnEvents / activeAtPeriodStart) * 10_000) / 100
        : 0,
      newTrials: projectsReport.reduce((sum, project) => sum + project.newTrials, 0),
      manualGrants: projectsReport.reduce((sum, project) => sum + project.manualGrants, 0),
      successfulPayments,
      renewalPayments,
      renewingSubscriptions,
      refundedPayments,
      revenueByCurrency: formatRevenue(revenueTotals),
      projects: projectsReport
    };
  }, { isolationLevel: "ReadCommitted" });
}
