import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("PostgreSQL workspace billing overview reads assigned plans and live non-archived usage", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const { getWorkspaceBillingOverview } = await import("./workspace-billing-service.js");

  const suffix = randomUUID();
  const telegramId = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let userId: string | undefined;
  let platformPlanId: string | undefined;
  const workspaceIds: string[] = [];

  try {
    const owner = await prisma.user.create({
      data: { telegramId, firstName: "Billing overview test owner" }
    });
    userId = owner.id;

    const unassigned = await prisma.workspace.create({
      data: {
        name: "Unassigned billing overview",
        slug: `billing-unassigned-${suffix}`,
        createdById: owner.id,
        members: { create: { userId: owner.id, role: "OWNER" } }
      }
    });
    workspaceIds.push(unassigned.id);

    const unassignedOverview = await getWorkspaceBillingOverview(unassigned.id);
    assert.ok(unassignedOverview);
    assert.equal(unassignedOverview.billing, null);
    assert.equal(unassignedOverview.usage.members, 1);
    assert.equal(unassignedOverview.usage.projects, 0);
    assert.deepEqual(unassignedOverview.usage.projectUsage, []);

    const plan = await prisma.platformPlan.create({
      data: {
        code: `billing-overview-${suffix}`,
        title: "Billing overview plan",
        price: "490",
        currency: "RUB",
        billingPeriodDays: 30,
        isActive: true,
        features: {
          schemaVersion: 1,
          limits: {
            projects: 2,
            members: 3,
            plansPerProject: 4,
            connectedChatsPerProject: 5
          }
        }
      }
    });
    platformPlanId = plan.id;

    const assigned = await prisma.workspace.create({
      data: {
        name: "Assigned billing overview",
        slug: `billing-assigned-${suffix}`,
        createdById: owner.id,
        members: { create: { userId: owner.id, role: "OWNER" } },
        billing: {
          create: {
            platformPlanId: plan.id,
            status: "ACTIVE",
            currentPeriodStart: new Date("2026-11-01T00:00:00.000Z"),
            currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z")
          }
        },
        projects: {
          create: [
            {
              name: "Active project",
              slug: `billing-active-${suffix}`,
              creatorUserId: owner.id,
              countryCode: "RU",
              defaultCurrency: "RUB"
            },
            {
              name: "Archived project",
              slug: `billing-archived-${suffix}`,
              creatorUserId: owner.id,
              status: "ARCHIVED",
              countryCode: "RU",
              defaultCurrency: "RUB"
            }
          ]
        }
      },
      include: { projects: true }
    });
    workspaceIds.push(assigned.id);

    const overview = await getWorkspaceBillingOverview(assigned.id);
    assert.ok(overview);
    assert.equal(overview.workspaceName, "Assigned billing overview");
    assert.equal(overview.billing?.status, "ACTIVE");
    assert.equal(overview.billing?.plan.code, plan.code);
    assert.equal(overview.billing?.plan.price, "490");
    assert.equal(overview.billing?.plan.currency, "RUB");
    assert.equal(overview.billing?.currentPeriodEnd?.toISOString(), "2026-12-01T00:00:00.000Z");
    assert.equal(overview.billing?.configuration, "valid");
    assert.equal(overview.usage.projects, 1, "archived projects must not consume project quota");
    assert.equal(overview.usage.members, 1);
    assert.deepEqual(overview.usage.projectUsage.map((project) => project.name), ["Active project"]);
    assert.deepEqual(overview.usage.projectsDecision, {
      allowed: true,
      limit: 2,
      currentUsage: 1,
      requested: 1,
      remaining: 1
    });
    assert.deepEqual(overview.usage.membersDecision, {
      allowed: true,
      limit: 3,
      currentUsage: 1,
      requested: 1,
      remaining: 2
    });
  } finally {
    if (workspaceIds.length) {
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    }
    if (platformPlanId) {
      await prisma.platformPlan.deleteMany({ where: { id: platformPlanId } });
    }
    if (userId) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma.$disconnect();
  }
});
