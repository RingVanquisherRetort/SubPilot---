import { prisma } from "@subpilot/database";
import type { PlatformPlanUpsertInput } from "./platform-plan-catalog.js";

export class PlatformPlanCatalogError extends Error {
  constructor(
    public readonly code: "PLAN_NOT_FOUND" | "PLAN_HAS_ASSIGNED_WORKSPACES"
  ) {
    super(code);
    this.name = "PlatformPlanCatalogError";
  }
}

type PlatformPlanTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Assignment, editing and deactivation must all serialize on this row.
 * Future workspace-plan assignment code must lock the plan before checking
 * isActive and inserting/updating WorkspaceBilling.
 */
export async function lockPlatformPlanInTransaction(
  tx: PlatformPlanTransaction,
  platformPlanId: string
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "PlatformPlan" WHERE "id" = ${platformPlanId} FOR UPDATE`;
}

function toFeatureJson(input: PlatformPlanUpsertInput) {
  return {
    schemaVersion: input.features.schemaVersion,
    limits: {
      projects: input.features.limits.projects,
      members: input.features.limits.members,
      plansPerProject: input.features.limits.plansPerProject,
      connectedChatsPerProject: input.features.limits.connectedChatsPerProject
    }
  };
}

/**
 * Creates or edits an unassigned catalogue entry.
 * Once a plan has workspace assignments, its price and quota contract are
 * immutable: publish a new plan code for new commercial terms instead.
 */
export async function upsertPlatformPlan(
  input: PlatformPlanUpsertInput,
  actorUserId: string
) {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.platformPlan.findUnique({
      where: { code: input.code },
      select: { id: true }
    });
    if (candidate) {
      await lockPlatformPlanInTransaction(tx, candidate.id);
      const existing = await tx.platformPlan.findUnique({
        where: { code: input.code },
        include: { _count: { select: { workspaceBillings: true } } }
      });
      if (existing && existing._count.workspaceBillings > 0) {
        throw new PlatformPlanCatalogError("PLAN_HAS_ASSIGNED_WORKSPACES");
      }
    }

    const features = toFeatureJson(input);
    const plan = await tx.platformPlan.upsert({
      where: { code: input.code },
      create: {
        code: input.code,
        title: input.title,
        description: input.description,
        price: input.price,
        currency: input.currency,
        billingPeriodDays: input.billingPeriodDays,
        features,
        isActive: true
      },
      update: {
        title: input.title,
        description: input.description,
        price: input.price,
        currency: input.currency,
        billingPeriodDays: input.billingPeriodDays,
        features
      }
    });

    await tx.auditLog.create({
      data: {
        actorUserId,
        action: "PLATFORM_PLAN_UPSERT",
        resourceType: "PlatformPlan",
        resourceId: plan.id,
        metadata: {
          code: plan.code,
          title: plan.title,
          price: plan.price.toString(),
          currency: plan.currency,
          billingPeriodDays: plan.billingPeriodDays,
          features
        }
      }
    });

    return plan;
  });
}

/** Deactivation is blocked while any workspace references this plan. */
export async function setPlatformPlanActive(
  code: string,
  isActive: boolean,
  actorUserId: string
) {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.platformPlan.findUnique({
      where: { code },
      select: { id: true }
    });
    if (!candidate) throw new PlatformPlanCatalogError("PLAN_NOT_FOUND");
    await lockPlatformPlanInTransaction(tx, candidate.id);
    const plan = await tx.platformPlan.findUnique({
      where: { id: candidate.id },
      include: { _count: { select: { workspaceBillings: true } } }
    });
    if (!plan) throw new PlatformPlanCatalogError("PLAN_NOT_FOUND");
    if (!isActive && plan._count.workspaceBillings > 0) {
      throw new PlatformPlanCatalogError("PLAN_HAS_ASSIGNED_WORKSPACES");
    }
    if (plan.isActive === isActive) return plan;

    const updated = await tx.platformPlan.update({
      where: { id: plan.id },
      data: { isActive }
    });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: isActive ? "PLATFORM_PLAN_ACTIVATED" : "PLATFORM_PLAN_DEACTIVATED",
        resourceType: "PlatformPlan",
        resourceId: plan.id,
        metadata: { code: plan.code, assignedWorkspaces: plan._count.workspaceBillings }
      }
    });
    return updated;
  });
}
