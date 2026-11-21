import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("project analytics keep currencies separate and audit history hides raw metadata", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const { getProjectAnalytics, listProjectAuditHistory } =
    await import("./project-analytics-service.js");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  let actorId: string | undefined;
  let workspaceId: string | undefined;
  let projectId: string | undefined;

  try {
    const actor = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Analytics Owner" }
    });
    actorId = actor.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Analytics test " + suffix,
        slug: "analytics-" + suffix,
        createdById: actor.id,
        members: { create: { userId: actor.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Analytics project",
        slug: "project-" + suffix
      }
    });
    projectId = project.id;
    const plan = await prisma.creatorPlan.create({
      data: {
        projectId: project.id,
        title: "Analytics plan",
        price: "500",
        currency: "XTR",
        durationDays: 30
      }
    });
    const customerOne = await prisma.projectCustomer.create({
      data: { projectId: project.id, telegramUserId: telegramBase + 1n, firstName: "Customer One" }
    });
    const customerTwo = await prisma.projectCustomer.create({
      data: { projectId: project.id, telegramUserId: telegramBase + 2n, firstName: "Customer Two" }
    });

    const active = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customerOne.id,
        planId: plan.id,
        status: "ACTIVE",
        grantType: "PAID",
        startsAt: new Date(now.getTime() - 5 * 24 * 60 * 60_000),
        endsAt: new Date(now.getTime() + 25 * 24 * 60 * 60_000)
      }
    });
    const trial = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customerTwo.id,
        planId: plan.id,
        status: "ACTIVE",
        grantType: "TRIAL",
        startsAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000),
        endsAt: new Date(now.getTime() + 12 * 24 * 60 * 60_000)
      }
    });
    await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customerOne.id,
        planId: plan.id,
        status: "EXPIRED",
        grantType: "PAID",
        startsAt: new Date(now.getTime() - 40 * 24 * 60 * 60_000),
        endsAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000)
      }
    });
    await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customerTwo.id,
        planId: plan.id,
        status: "CANCELLED",
        grantType: "MANUAL",
        startsAt: new Date(now.getTime() - 4 * 24 * 60 * 60_000),
        endsAt: new Date(now.getTime() - 1 * 24 * 60 * 60_000),
        cancelledAt: new Date(now.getTime() - 1 * 24 * 60 * 60_000)
      }
    });

    const paymentBase = {
      projectId: project.id,
      customerId: customerOne.id,
      subscriptionId: active.id,
      provider: "TELEGRAM_STARS" as const
    };
    await prisma.payment.createMany({
      data: [
        {
          ...paymentBase, amount: "100.00", currency: "XTR",
          status: "SUCCEEDED", paidAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000)
        },
        {
          ...paymentBase, amount: "50.00", currency: "XTR",
          status: "SUCCEEDED", paidAt: new Date(now.getTime() - 1 * 24 * 60 * 60_000)
        },
        {
          ...paymentBase, amount: "20.00", currency: "RUB",
          status: "REFUNDED",
          paidAt: new Date(now.getTime() - 15 * 24 * 60 * 60_000),
          refundedAt: new Date(now.getTime() - 1 * 24 * 60 * 60_000)
        },
        {
          ...paymentBase, amount: "999.00", currency: "XTR",
          status: "FAILED"
        }
      ]
    });

    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        actorUserId: actor.id,
        action: "TEST_PLAN_UPDATED",
        resourceType: "CreatorPlan",
        resourceId: plan.id,
        metadata: { sensitiveExample: "must not be returned" }
      }
    });

    const report = await getProjectAnalytics({
      workspaceId: workspace.id,
      projectId: project.id,
      periodDays: 30,
      now
    });
    assert.equal(report.activeSubscriptions, 2);
    assert.equal(report.uniqueActiveCustomers, 2);
    assert.equal(report.newSubscriptions, 4);
    assert.equal(report.expiredSubscriptions, 1);
    assert.equal(report.cancelledSubscriptions, 1);
    assert.equal(report.newTrials, 1);
    assert.equal(report.manualGrants, 1);
    assert.equal(report.successfulPayments, 2);
    assert.equal(report.repeatPayingSubscriptions, 1);
    assert.equal(report.refundedPayments, 1);
    assert.deepEqual(report.revenueByCurrency, [
      {
        currency: "RUB",
        successfulPayments: 0,
        grossAmount: "0.00",
        refundedPayments: 1,
        refundedAmount: "20.00",
        netAmount: "-20.00"
      },
      {
        currency: "XTR",
        successfulPayments: 2,
        grossAmount: "150.00",
        refundedPayments: 0,
        refundedAmount: "0.00",
        netAmount: "150.00"
      }
    ]);
    assert.equal(report.activePlans[0]?.activeSubscriptions, 2);

    const audit = await listProjectAuditHistory({
      workspaceId: workspace.id,
      projectId: project.id,
      limit: 10
    });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, "TEST_PLAN_UPDATED");
    assert.equal(audit[0]?.actor, "Analytics Owner");
    assert.equal("metadata" in (audit[0] ?? {}), false);

    await assert.rejects(
      getProjectAnalytics({
        workspaceId: "different-workspace",
        projectId: project.id
      }),
      /Project not found/
    );
    await assert.rejects(
      listProjectAuditHistory({
        workspaceId: "different-workspace",
        projectId: project.id
      }),
      /Project not found/
    );
    assert.ok(trial.id);
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
  }
});
