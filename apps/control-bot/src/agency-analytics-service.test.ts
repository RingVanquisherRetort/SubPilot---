import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("agency analytics aggregate subscribers, churn, renewals and revenue by currency with project scoping", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const { AgencyAnalyticsError, getAgencyAnalytics } =
    await import("./agency-analytics-service.js");

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  const userIds: string[] = [];
  let workspaceId: string | undefined;
  let foreignWorkspaceId: string | undefined;

  try {
    const makeUser = async (offset: number, firstName: string) => {
      const user = await prisma.user.create({
        data: { telegramId: telegramBase + BigInt(offset), firstName }
      });
      userIds.push(user.id);
      return user;
    };
    const owner = await makeUser(1, "Agency Analytics Owner");
    const manager = await makeUser(2, "Agency Analytics Manager");
    const viewer = await makeUser(3, "Agency Analytics Viewer");
    const scopedViewer = await makeUser(4, "Agency Analytics Scoped Viewer");

    const workspace = await prisma.workspace.create({
      data: {
        name: "Agency analytics " + suffix,
        slug: "agency-analytics-" + suffix,
        type: "AGENCY",
        createdById: owner.id,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: manager.id, role: "MANAGER" },
            { userId: viewer.id, role: "VIEWER" },
            { userId: scopedViewer.id, role: "VIEWER" }
          ]
        }
      }
    });
    workspaceId = workspace.id;

    const foreignOwner = await makeUser(5, "Foreign Agency Owner");
    const foreignWorkspace = await prisma.workspace.create({
      data: {
        name: "Foreign agency", slug: "foreign-agency-" + suffix,
        type: "AGENCY", createdById: foreignOwner.id,
        members: { create: { userId: foreignOwner.id, role: "OWNER" } }
      }
    });
    foreignWorkspaceId = foreignWorkspace.id;
    const foreignProject = await prisma.project.create({
      data: { workspaceId: foreignWorkspace.id, name: "Foreign project", slug: "foreign-project-" + suffix }
    });
    const foreignCustomer = await prisma.projectCustomer.create({
      data: { projectId: foreignProject.id, telegramUserId: telegramBase + 999n }
    });
    await prisma.payment.create({
      data: { projectId: foreignProject.id, customerId: foreignCustomer.id,
        provider: "TELEGRAM_STARS", amount: "9999.00", currency: "XTR",
        status: "SUCCEEDED", paidAt: new Date(now.getTime() - 1000) }
    });
    await assert.rejects(
      getAgencyAnalytics({ workspaceId: foreignWorkspace.id, actorUserId: owner.id, now }),
      (error: unknown) => error instanceof AgencyAnalyticsError && error.code === "ACTOR_NOT_MEMBER"
    );

    const projectA = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Agency project A",
        slug: "agency-project-a-" + suffix,
        creatorUserId: manager.id
      }
    });
    const projectB = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Agency project B",
        slug: "agency-project-b-" + suffix
      }
    });
    await prisma.projectMember.create({
      data: { projectId: projectB.id, userId: scopedViewer.id, role: "MANAGER" }
    });

    const planA = await prisma.creatorPlan.create({
      data: {
        projectId: projectA.id,
        title: "Plan A",
        price: "500",
        currency: "XTR",
        durationDays: 30
      }
    });
    const planB = await prisma.creatorPlan.create({
      data: {
        projectId: projectB.id,
        title: "Plan B",
        price: "400",
        currency: "XTR",
        durationDays: 30
      }
    });

    const customerA = await prisma.projectCustomer.create({
      data: { projectId: projectA.id, telegramUserId: telegramBase + 100n }
    });
    const customerB = await prisma.projectCustomer.create({
      data: { projectId: projectB.id, telegramUserId: telegramBase + 100n }
    });
    const customerC = await prisma.projectCustomer.create({
      data: { projectId: projectA.id, telegramUserId: telegramBase + 102n }
    });
    const customerD = await prisma.projectCustomer.create({
      data: { projectId: projectB.id, telegramUserId: telegramBase + 103n }
    });
    const expiredCustomer = await prisma.projectCustomer.create({
      data: { projectId: projectA.id, telegramUserId: telegramBase + 104n }
    });
    const cancelledCustomer = await prisma.projectCustomer.create({
      data: { projectId: projectB.id, telegramUserId: telegramBase + 105n }
    });
    const expiredDuringPeriodCustomer = await prisma.projectCustomer.create({
      data: { projectId: projectA.id, telegramUserId: telegramBase + 106n }
    });

    const createSubscription = async (input: {
      projectId: string;
      customerId: string;
      planId: string;
      status: "ACTIVE" | "EXPIRED" | "CANCELLED";
      grantType: "PAID" | "MANUAL" | "TRIAL";
      createdAt: Date;
      startsAt: Date;
      endsAt: Date;
      cancelledAt?: Date;
    }) => prisma.subscription.create({
      data: {
        ...input,
        ...(input.cancelledAt ? { cancelledAt: input.cancelledAt } : {})
      }
    });

    const activePaidA = await createSubscription({
      projectId: projectA.id,
      customerId: customerA.id,
      planId: planA.id,
      status: "ACTIVE",
      grantType: "PAID",
      createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60_000),
      startsAt: new Date(now.getTime() - 10 * 24 * 60 * 60_000),
      endsAt: new Date(now.getTime() + 20 * 24 * 60 * 60_000)
    });
    await createSubscription({
      projectId: projectB.id,
      customerId: customerB.id,
      planId: planB.id,
      status: "ACTIVE",
      grantType: "TRIAL",
      createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60_000),
      startsAt: new Date(now.getTime() - 8 * 24 * 60 * 60_000),
      endsAt: new Date(now.getTime() + 22 * 24 * 60 * 60_000)
    });
    await createSubscription({
      projectId: projectA.id,
      customerId: customerC.id,
      planId: planA.id,
      status: "ACTIVE",
      grantType: "MANUAL",
      createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000),
      startsAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000),
      endsAt: new Date(now.getTime() + 28 * 24 * 60 * 60_000)
    });
    const activePaidB = await createSubscription({
      projectId: projectB.id,
      customerId: customerD.id,
      planId: planB.id,
      status: "ACTIVE",
      grantType: "PAID",
      createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60_000),
      startsAt: new Date(now.getTime() - 3 * 24 * 60 * 60_000),
      endsAt: new Date(now.getTime() + 27 * 24 * 60 * 60_000)
    });
    await createSubscription({
      projectId: projectA.id,
      customerId: expiredCustomer.id,
      planId: planA.id,
      status: "EXPIRED",
      grantType: "PAID",
      createdAt: new Date(from.getTime() - 10 * 24 * 60 * 60_000),
      startsAt: new Date(from.getTime() - 10 * 24 * 60 * 60_000),
      endsAt: new Date(from.getTime() + 5 * 24 * 60 * 60_000)
    });
    await createSubscription({
      projectId: projectB.id,
      customerId: cancelledCustomer.id,
      planId: planB.id,
      status: "CANCELLED",
      grantType: "MANUAL",
      createdAt: new Date(from.getTime() - 12 * 24 * 60 * 60_000),
      startsAt: new Date(from.getTime() - 12 * 24 * 60 * 60_000),
      endsAt: new Date(from.getTime() + 20 * 24 * 60 * 60_000),
      cancelledAt: new Date(from.getTime() + 7 * 24 * 60 * 60_000)
    });
    await createSubscription({
      projectId: projectA.id,
      customerId: expiredDuringPeriodCustomer.id,
      planId: planA.id,
      status: "EXPIRED",
      grantType: "PAID",
      createdAt: new Date(from.getTime() + 2 * 24 * 60 * 60_000),
      startsAt: new Date(from.getTime() + 2 * 24 * 60 * 60_000),
      endsAt: new Date(from.getTime() + 6 * 24 * 60 * 60_000)
    });

    await prisma.payment.createMany({
      data: [
        {
          projectId: projectA.id,
          customerId: customerA.id,
          subscriptionId: activePaidA.id,
          provider: "TELEGRAM_STARS",
          amount: "100.00",
          currency: "XTR",
          status: "SUCCEEDED",
          paidAt: new Date(from.getTime() - 2 * 24 * 60 * 60_000)
        },
        {
          projectId: projectA.id,
          customerId: customerA.id,
          subscriptionId: activePaidA.id,
          provider: "TELEGRAM_STARS",
          amount: "80.00",
          currency: "XTR",
          status: "SUCCEEDED",
          paidAt: new Date(from.getTime() + 2 * 24 * 60 * 60_000)
        },
        {
          projectId: projectA.id,
          customerId: customerA.id,
          subscriptionId: activePaidA.id,
          provider: "TELEGRAM_STARS",
          amount: "10.00",
          currency: "RUB",
          status: "REFUNDED",
          paidAt: new Date(from.getTime() + 3 * 24 * 60 * 60_000),
          refundedAt: new Date(from.getTime() + 5 * 24 * 60 * 60_000)
        },
        {
          projectId: projectB.id,
          customerId: customerD.id,
          subscriptionId: activePaidB.id,
          provider: "TELEGRAM_STARS",
          amount: "20.00",
          currency: "XTR",
          status: "SUCCEEDED",
          paidAt: new Date(from.getTime() + 4 * 24 * 60 * 60_000)
        }
      ]
    });

    const report = await getAgencyAnalytics({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      periodDays: 30,
      now
    });
    assert.equal(report.projects.length, 2);
    assert.equal(report.projects.some((project) => project.projectId === foreignProject.id), false);
    assert.equal(report.activeSubscriptions, 4);
    assert.equal(report.uniqueActiveSubscribers, 3);
    assert.equal(report.newSubscriptions, 5);
    assert.equal(report.newSubscribers, 4);
    assert.equal(report.expiredSubscriptions, 2);
    assert.equal(report.cancelledSubscriptions, 1);
    assert.equal(report.churnEvents, 3);
    assert.equal(report.openingBaseChurnEvents, 2);
    assert.equal(report.activeAtPeriodStart, 2);
    assert.equal(report.churnRatePercent, 100);
    assert.equal(report.newTrials, 1);
    assert.equal(report.manualGrants, 1);
    assert.equal(report.successfulPayments, 3);
    assert.equal(report.renewalPayments, 1);
    assert.equal(report.renewingSubscriptions, 1);
    assert.equal(report.refundedPayments, 1);
    assert.deepEqual(report.revenueByCurrency, [
      {
        currency: "RUB",
        payments: 1,
        grossAmount: "10.00",
        refundedPayments: 1,
        refundedAmount: "10.00",
        netAmount: "0.00"
      },
      {
        currency: "XTR",
        payments: 2,
        grossAmount: "100.00",
        refundedPayments: 0,
        refundedAmount: "0.00",
        netAmount: "100.00"
      }
    ]);

    const projectAReport = report.projects.find((project) => project.projectId === projectA.id);
    assert.equal(projectAReport?.activeSubscriptions, 2);
    assert.equal(projectAReport?.renewalPayments, 1);
    assert.equal(projectAReport?.creatorName, "Agency Analytics Manager");
    const projectBReport = report.projects.find((project) => project.projectId === projectB.id);
    assert.equal(projectBReport?.activeSubscriptions, 2);

    const managerReport = await getAgencyAnalytics({
      workspaceId: workspace.id,
      actorUserId: manager.id,
      periodDays: 30,
      now
    });
    assert.equal(managerReport.projects.length, 1);
    assert.equal(managerReport.projects[0]?.projectId, projectA.id);
    assert.equal(managerReport.activeSubscriptions, 2);

    const scopedViewerReport = await getAgencyAnalytics({
      workspaceId: workspace.id,
      actorUserId: scopedViewer.id,
      periodDays: 30,
      now
    });
    assert.equal(scopedViewerReport.projects.length, 1);
    assert.equal(scopedViewerReport.projects[0]?.projectId, projectB.id);
    assert.equal(scopedViewerReport.activeSubscriptions, 2);

    await assert.rejects(
      getAgencyAnalytics({
        workspaceId: workspace.id,
        actorUserId: viewer.id,
        periodDays: 30,
        now
      }),
      (error: unknown) => error instanceof AgencyAnalyticsError && error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
      getAgencyAnalytics({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        periodDays: 366,
        now
      }),
      (error: unknown) => error instanceof AgencyAnalyticsError && error.code === "INVALID_RANGE"
    );
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: projectB.id, userId: scopedViewer.id } },
      data: { role: "VIEWER" }
    });
    await assert.rejects(
      getAgencyAnalytics({ workspaceId: workspace.id, actorUserId: scopedViewer.id, now }),
      (error: unknown) => error instanceof AgencyAnalyticsError && error.code === "PERMISSION_DENIED"
    );
    await prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: manager.id } }
    });
    await assert.rejects(
      getAgencyAnalytics({ workspaceId: workspace.id, actorUserId: manager.id, now }),
      (error: unknown) => error instanceof AgencyAnalyticsError && error.code === "ACTOR_NOT_MEMBER"
    );
  } finally {
    if (foreignWorkspaceId) await prisma.workspace.deleteMany({ where: { id: foreignWorkspaceId } });
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});
