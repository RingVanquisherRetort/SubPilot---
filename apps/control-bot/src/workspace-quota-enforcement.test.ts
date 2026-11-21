import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("PostgreSQL workspace quotas serialize concurrent creation and archived-resource restoration", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const {
    WorkspaceQuotaError,
    assertWorkspaceQuotaInTransaction,
    lockWorkspace,
    withWorkspaceQuotaTransaction
  } = await import("./workspace-quota-enforcement.js");

  const suffix = randomUUID();
  const telegramBase = BigInt(`9${Date.now()}${Math.floor(Math.random() * 1_000_000)}`);
  let ownerId: string | undefined;
  let firstMemberId: string | undefined;
  let secondMemberId: string | undefined;
  let workspaceId: string | undefined;
  let planId: string | undefined;

  try {
    const owner = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Quota test owner" }
    });
    ownerId = owner.id;

    const workspace = await prisma.workspace.create({
      data: {
        name: "Quota concurrency test",
        slug: `quota-${suffix}`,
        createdById: owner.id,
        members: { create: { userId: owner.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;

    const platformPlan = await prisma.platformPlan.create({
      data: {
        code: `quota-test-${suffix}`,
        title: "Quota test",
        price: "100",
        currency: "RUB",
        billingPeriodDays: 30,
        isActive: true,
        features: {
          schemaVersion: 1,
          limits: {
            projects: 1,
            members: 2,
            plansPerProject: 1,
            connectedChatsPerProject: 1
          }
        }
      }
    });
    planId = platformPlan.id;

    await prisma.workspaceBilling.create({
      data: {
        workspaceId: workspace.id,
        platformPlanId: platformPlan.id,
        status: "ACTIVE"
      }
    });

    const firstMember = await prisma.user.create({
      data: { telegramId: telegramBase + 1n, firstName: "Quota member one" }
    });
    firstMemberId = firstMember.id;
    const secondMember = await prisma.user.create({
      data: { telegramId: telegramBase + 2n, firstName: "Quota member two" }
    });
    secondMemberId = secondMember.id;

    const projectAttempts = await Promise.allSettled([0, 1].map((index) =>
      withWorkspaceQuotaTransaction(workspace.id, "projects", (tx) =>
        tx.project.create({
          data: {
            workspaceId: workspace.id,
            creatorUserId: owner.id,
            name: `Project ${index}`,
            slug: `project-${index}-${suffix.slice(0, 8)}`,
            countryCode: "RU",
            defaultCurrency: "RUB"
          }
        })
      )
    ));
    const successfulProjectAttempt = projectAttempts.find((result) => result.status === "fulfilled");
    const projectFailures = projectAttempts.filter((result) => result.status === "rejected");
    assert.equal(projectAttempts.filter((result) => result.status === "fulfilled").length, 1,
      "only one concurrent project creation should fit");
    assert.equal(projectFailures.length, 1);
    assert.ok(projectFailures[0]?.status === "rejected" && projectFailures[0].reason instanceof WorkspaceQuotaError);
    assert.equal(await prisma.project.count({
      where: { workspaceId: workspace.id, status: { not: "ARCHIVED" } }
    }), 1);
    if (successfulProjectAttempt?.status !== "fulfilled") {
      throw new Error("Expected one successful project creation.");
    }

    const projectId = successfulProjectAttempt.value.id;
    const archivedProject = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        creatorUserId: owner.id,
        name: "Archived project",
        slug: `archived-${suffix.slice(0, 8)}`,
        status: "ARCHIVED",
        countryCode: "RU",
        defaultCurrency: "RUB"
      }
    });
    await assert.rejects(
      withWorkspaceQuotaTransaction(workspace.id, "projects", (tx) =>
        tx.project.updateMany({
          where: { id: archivedProject.id, status: "ARCHIVED" },
          data: { status: "ACTIVE" }
        })
      ),
      WorkspaceQuotaError
    );

    const invites = await Promise.all([firstMember.id, secondMember.id].map((userId) =>
      prisma.workspaceInvite.create({
        data: {
          workspaceId: workspace.id,
          invitedByUserId: owner.id,
          tokenHash: randomUUID(),
          role: "MANAGER",
          expiresAt: new Date(Date.now() + 60_000)
        }
      }).then((invite) => ({ inviteId: invite.id, userId }))
    ));

    const acceptInvite = (inviteId: string, userId: string) =>
      prisma.$transaction(async (tx) => {
        const claimed = await tx.workspaceInvite.updateMany({
          where: { id: inviteId, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() }
        });
        if (claimed.count !== 1) return false;

        await lockWorkspace(tx, workspace.id);
        const existingMembership = await tx.workspaceMember.findUnique({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId }
          },
          select: { id: true }
        });
        if (!existingMembership) {
          await assertWorkspaceQuotaInTransaction(tx, workspace.id, "members");
        }
        return tx.workspaceMember.upsert({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId }
          },
          update: {},
          create: { workspaceId: workspace.id, userId, role: "MANAGER" },
          select: { role: true }
        });
      });

    const memberAttempts = await Promise.allSettled(
      invites.map(({ inviteId, userId }) => acceptInvite(inviteId, userId))
    );
    assert.equal(memberAttempts.filter((result) => result.status === "fulfilled").length, 1);
    const memberFailure = memberAttempts.find((result) => result.status === "rejected");
    assert.ok(memberFailure?.status === "rejected" && memberFailure.reason instanceof WorkspaceQuotaError);
    assert.equal(await prisma.workspaceMember.count({ where: { workspaceId: workspace.id } }), 2);
    assert.equal(await prisma.workspaceInvite.count({
      where: { workspaceId: workspace.id, usedAt: null }
    }), 1, "the invite rejected by the quota check must remain unused");

    const planAttempts = await Promise.allSettled([0, 1].map((index) =>
      withWorkspaceQuotaTransaction(workspace.id, "plansPerProject", (tx) =>
        tx.creatorPlan.create({
          data: {
            projectId,
            title: `Creator plan ${index}`,
            price: "100",
            currency: "XTR",
            durationDays: 30
          }
        }),
        projectId
      )
    ));
    assert.equal(planAttempts.filter((result) => result.status === "fulfilled").length, 1);
    const planFailure = planAttempts.find((result) => result.status === "rejected");
    assert.ok(planFailure?.status === "rejected" && planFailure.reason instanceof WorkspaceQuotaError);
    const activePlan = await prisma.creatorPlan.findFirstOrThrow({
      where: { projectId, status: "ACTIVE" }
    });
    const archivedPlan = await prisma.creatorPlan.create({
      data: {
        projectId,
        title: "Archived creator plan",
        price: "100",
        currency: "XTR",
        durationDays: 30,
        status: "ARCHIVED"
      }
    });
    await assert.rejects(
      withWorkspaceQuotaTransaction(workspace.id, "plansPerProject", (tx) =>
        tx.creatorPlan.updateMany({
          where: { id: archivedPlan.id, projectId, status: "ARCHIVED" },
          data: { status: "ACTIVE" }
        }),
        projectId
      ),
      WorkspaceQuotaError
    );

    const chatAttempts = await Promise.allSettled([0, 1].map((index) =>
      withWorkspaceQuotaTransaction(workspace.id, "connectedChatsPerProject", (tx) =>
        tx.connectedChat.create({
          data: {
            projectId,
            telegramChatId: telegramBase + BigInt(10 + index),
            type: "CHANNEL",
            title: `Connected chat ${index}`,
            isActive: true
          }
        }),
        projectId
      )
    ));
    assert.equal(chatAttempts.filter((result) => result.status === "fulfilled").length, 1);
    const chatFailure = chatAttempts.find((result) => result.status === "rejected");
    assert.ok(chatFailure?.status === "rejected" && chatFailure.reason instanceof WorkspaceQuotaError);
    assert.equal(await prisma.connectedChat.count({
      where: { projectId, isActive: true }
    }), 1);

    assert.ok(activePlan.id);
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (planId) await prisma.platformPlan.deleteMany({ where: { id: planId } });
    const userIds = [ownerId, firstMemberId, secondMemberId].filter((id): id is string => Boolean(id));
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
