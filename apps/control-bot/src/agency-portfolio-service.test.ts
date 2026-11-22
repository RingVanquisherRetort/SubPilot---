import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("agency portfolio assigns projects to workspace creators and clears stale assignments on member removal", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const {
    AgencyPortfolioError,
    assignAgencyProjectCreator,
    getAgencyPortfolio,
    unassignAgencyProjectCreator
  } = await import("./agency-portfolio-service.js");
  const { removeWorkspaceMember } = await import("./workspace-membership-service.js");

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  try {
    const makeUser = async (offset: number, firstName: string) => {
      const user = await prisma.user.create({
        data: { telegramId: telegramBase + BigInt(offset), firstName }
      });
      userIds.push(user.id);
      return user;
    };
    const owner = await makeUser(1, "Agency Owner");
    const admin = await makeUser(2, "Agency Admin");
    const manager = await makeUser(3, "Agency Manager");
    const creatorOne = await makeUser(4, "Creator One");
    const creatorTwo = await makeUser(5, "Creator Two");
    const outsider = await makeUser(6, "Outside User");

    const workspace = await prisma.workspace.create({
      data: {
        name: "Agency portfolio " + suffix,
        slug: "agency-portfolio-" + suffix,
        type: "AGENCY",
        createdById: owner.id,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: admin.id, role: "ADMIN" },
            { userId: manager.id, role: "MANAGER" },
            { userId: creatorOne.id, role: "VIEWER" },
            { userId: creatorTwo.id, role: "MANAGER" }
          ]
        }
      }
    });
    workspaceIds.push(workspace.id);

    const personalWorkspace = await prisma.workspace.create({
      data: {
        name: "Personal " + suffix,
        slug: "personal-agency-test-" + suffix,
        type: "PERSONAL",
        createdById: outsider.id,
        members: { create: { userId: outsider.id, role: "OWNER" } }
      }
    });
    workspaceIds.push(personalWorkspace.id);

    const projectOne = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Creator One — Main",
        slug: "creator-one-main-" + suffix,
        creatorUserId: manager.id
      }
    });
    const projectTwo = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Creator Two — Main",
        slug: "creator-two-main-" + suffix
      }
    });
    const projectThree = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Creator Two — Secondary",
        slug: "creator-two-secondary-" + suffix,
        creatorUserId: creatorTwo.id
      }
    });
    const foreignProject = await prisma.project.create({
      data: {
        workspaceId: personalWorkspace.id,
        name: "Outside project",
        slug: "outside-project-" + suffix
      }
    });

    const assigned = await assignAgencyProjectCreator({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      projectId: projectOne.id,
      creatorTelegramId: String(telegramBase + 4n)
    });
    assert.equal(assigned.changed, true);
    assert.equal(assigned.previousCreatorName, "Agency Manager");
    assert.equal(assigned.creatorName, "Creator One");

    const repeatedAssignment = await assignAgencyProjectCreator({
      workspaceId: workspace.id,
      actorUserId: admin.id,
      projectId: projectOne.id,
      creatorTelegramId: String(telegramBase + 4n)
    });
    assert.equal(repeatedAssignment.changed, false);
    await prisma.projectMember.create({
      data: { projectId: projectTwo.id, userId: manager.id, role: "VIEWER" }
    });
    const managerPortfolio = await getAgencyPortfolio({
      workspaceId: workspace.id,
      actorUserId: manager.id
    });
    assert.equal(managerPortfolio.totalProjects, 1);
    assert.equal(managerPortfolio.unassignedProjects[0]?.id, projectTwo.id);

    await assert.rejects(
      assignAgencyProjectCreator({
        workspaceId: workspace.id,
        actorUserId: manager.id,
        projectId: projectTwo.id,
        creatorTelegramId: String(telegramBase + 5n)
      }),
      (error: unknown) => error instanceof AgencyPortfolioError && error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
      assignAgencyProjectCreator({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        projectId: projectTwo.id,
        creatorTelegramId: String(telegramBase + 6n)
      }),
      (error: unknown) => error instanceof AgencyPortfolioError && error.code === "CREATOR_NOT_MEMBER"
    );
    await assert.rejects(
      assignAgencyProjectCreator({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        projectId: foreignProject.id,
        creatorTelegramId: String(telegramBase + 4n)
      }),
      (error: unknown) => error instanceof AgencyPortfolioError && error.code === "PROJECT_NOT_FOUND"
    );
    await assert.rejects(
      assignAgencyProjectCreator({
        workspaceId: personalWorkspace.id,
        actorUserId: outsider.id,
        projectId: foreignProject.id,
        creatorTelegramId: String(telegramBase + 6n)
      }),
      (error: unknown) => error instanceof AgencyPortfolioError && error.code === "NOT_AN_AGENCY"
    );

    const portfolio = await getAgencyPortfolio({
      workspaceId: workspace.id,
      actorUserId: owner.id
    });
    assert.equal(portfolio.workspaceName, workspace.name);
    assert.equal(portfolio.totalProjects, 3);
    assert.equal(portfolio.assignedProjects, 2);
    assert.equal(portfolio.unassignedProjects.length, 1);
    assert.equal(portfolio.creators.find((creator) => creator.userId === creatorOne.id)?.projects.length, 1);
    assert.equal(portfolio.creators.find((creator) => creator.userId === creatorTwo.id)?.projects.length, 1);
    await assert.rejects(
      getAgencyPortfolio({ workspaceId: workspace.id, actorUserId: creatorOne.id }),
      (error: unknown) => error instanceof AgencyPortfolioError && error.code === "PERMISSION_DENIED"
    );

    const unassigned = await unassignAgencyProjectCreator({
      workspaceId: workspace.id,
      actorUserId: admin.id,
      projectId: projectOne.id
    });
    assert.equal(unassigned.changed, true);
    assert.equal(unassigned.previousCreatorName, "Creator One");
    assert.equal((await unassignAgencyProjectCreator({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      projectId: projectOne.id
    })).changed, false);

    const projectAssignedToRemovedMember = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Project to clean up",
        slug: "project-cleanup-" + suffix,
        creatorUserId: creatorTwo.id
      }
    });
    await prisma.user.update({
      where: { id: creatorTwo.id },
      data: { activeWorkspaceId: workspace.id }
    });
    await removeWorkspaceMember({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      targetTelegramId: String(telegramBase + 5n)
    });
    const cleanedProject = await prisma.project.findUniqueOrThrow({
      where: { id: projectAssignedToRemovedMember.id },
      select: { creatorUserId: true }
    });
    assert.equal(cleanedProject.creatorUserId, null);
    const removedCreator = await prisma.user.findUniqueOrThrow({
      where: { id: creatorTwo.id },
      select: { activeWorkspaceId: true }
    });
    assert.equal(removedCreator.activeWorkspaceId, null);

    const events = await prisma.auditLog.findMany({
      where: {
        workspaceId: workspace.id,
        action: {
          in: [
            "AGENCY_PROJECT_CREATOR_ASSIGNED",
            "AGENCY_PROJECT_CREATOR_UNASSIGNED",
            "AGENCY_PROJECT_CREATOR_CLEARED_MEMBER_REMOVED"
          ]
        }
      }
    });
    assert.equal(events.filter((event) => event.action === "AGENCY_PROJECT_CREATOR_ASSIGNED").length, 1);
    assert.equal(events.filter((event) => event.action === "AGENCY_PROJECT_CREATOR_UNASSIGNED").length, 1);
    assert.equal(events.filter((event) => event.action === "AGENCY_PROJECT_CREATOR_CLEARED_MEMBER_REMOVED").length, 1);
    assert.equal(events.some((event) => JSON.stringify(event.metadata).includes(String(telegramBase + 4n))), false);
  } finally {
    for (const workspaceId of workspaceIds) {
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  }
});
