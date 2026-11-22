import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("agency project access is isolated by responsible creator and explicit project roles", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const { getAccessibleProject } = await import("./project-access-service.js");
  const {
    ProjectMembershipError,
    removeProjectMemberAccess,
    setProjectMemberAccess
  } = await import("./project-membership-service.js");
  const { removeWorkspaceMember } = await import("./workspace-membership-service.js");

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const makeUser = async (offset: number, firstName: string) => {
    const user = await prisma.user.create({
      data: { telegramId: telegramBase + BigInt(offset), firstName }
    });
    userIds.push(user.id);
    return user;
  };

  try {
    const owner = await makeUser(1, "Project Scope Owner");
    const admin = await makeUser(2, "Project Scope Admin");
    const managerOne = await makeUser(3, "Manager One");
    const managerTwo = await makeUser(4, "Manager Two");
    const viewer = await makeUser(5, "Project Viewer");
    const spare = await makeUser(6, "Spare Member");
    const outsider = await makeUser(7, "Project Scope Outsider");

    const agency = await prisma.workspace.create({
      data: {
        name: "Scoped Agency " + suffix,
        slug: "scoped-agency-" + suffix,
        type: "AGENCY",
        createdById: owner.id,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: admin.id, role: "ADMIN" },
            { userId: managerOne.id, role: "MANAGER" },
            { userId: managerTwo.id, role: "MANAGER" },
            { userId: viewer.id, role: "VIEWER" },
            { userId: spare.id, role: "MANAGER" }
          ]
        }
      }
    });
    workspaceIds.push(agency.id);

    const otherAgency = await prisma.workspace.create({
      data: {
        name: "Other Scoped Agency " + suffix,
        slug: "other-scoped-agency-" + suffix,
        type: "AGENCY",
        createdById: outsider.id,
        members: { create: { userId: outsider.id, role: "OWNER" } }
      }
    });
    workspaceIds.push(otherAgency.id);

    const personal = await prisma.workspace.create({
      data: {
        name: "Personal Scope " + suffix,
        slug: "personal-scope-" + suffix,
        type: "PERSONAL",
        createdById: outsider.id,
        members: { create: { userId: outsider.id, role: "OWNER" } }
      }
    });
    workspaceIds.push(personal.id);

    const creatorProject = await prisma.project.create({
      data: {
        workspaceId: agency.id,
        name: "Creator project",
        slug: "creator-project-" + suffix,
        creatorUserId: managerOne.id
      }
    });
    const managerProject = await prisma.project.create({
      data: { workspaceId: agency.id, name: "Manager project", slug: "manager-project-" + suffix }
    });
    const viewerProject = await prisma.project.create({
      data: { workspaceId: agency.id, name: "Viewer project", slug: "viewer-project-" + suffix }
    });
    const unassignedProject = await prisma.project.create({
      data: { workspaceId: agency.id, name: "Unassigned project", slug: "unassigned-project-" + suffix }
    });
    const foreignProject = await prisma.project.create({
      data: { workspaceId: otherAgency.id, name: "Foreign project", slug: "foreign-project-" + suffix }
    });
    const personalProject = await prisma.project.create({
      data: { workspaceId: personal.id, name: "Personal project", slug: "personal-project-" + suffix }
    });

    await prisma.projectMember.createMany({
      data: [
        { projectId: managerProject.id, userId: managerTwo.id, role: "MANAGER" },
        { projectId: viewerProject.id, userId: viewer.id, role: "VIEWER" }
      ]
    });

    assert.ok(await getAccessibleProject(creatorProject.id, managerOne.id, ["MANAGER"]));
    assert.equal(await getAccessibleProject(creatorProject.id, managerTwo.id, ["MANAGER", "VIEWER"]), null);
    assert.ok(await getAccessibleProject(managerProject.id, managerTwo.id, ["MANAGER"]));
    assert.equal(await getAccessibleProject(managerProject.id, managerOne.id, ["MANAGER", "VIEWER"]), null);
    assert.ok(await getAccessibleProject(viewerProject.id, viewer.id, ["VIEWER"]));
    assert.equal(await getAccessibleProject(viewerProject.id, viewer.id, ["MANAGER"]), null);
    assert.equal(await getAccessibleProject(unassignedProject.id, managerOne.id, ["MANAGER", "VIEWER"]), null);

    // Workspace owners/admins retain complete control over every project in the agency.
    assert.ok(await getAccessibleProject(unassignedProject.id, owner.id, ["OWNER", "ADMIN", "MANAGER"]));
    assert.ok(await getAccessibleProject(creatorProject.id, admin.id, ["OWNER", "ADMIN"]));
    assert.equal(await getAccessibleProject(foreignProject.id, owner.id, ["OWNER", "ADMIN"]), null);

    // An explicit project membership grants exactly one project and can be revoked.
    const granted = await setProjectMemberAccess({
      workspaceId: agency.id,
      actorUserId: owner.id,
      projectId: unassignedProject.id,
      targetTelegramId: String(telegramBase + 6n),
      role: "VIEWER"
    });
    assert.equal(granted.changed, true);
    assert.ok(await getAccessibleProject(unassignedProject.id, spare.id, ["VIEWER"]));
    assert.equal(await getAccessibleProject(managerProject.id, spare.id, ["VIEWER", "MANAGER"]), null);

    await assert.rejects(
      setProjectMemberAccess({
        workspaceId: agency.id,
        actorUserId: managerOne.id,
        projectId: managerProject.id,
        targetTelegramId: String(telegramBase + 6n),
        role: "MANAGER"
      }),
      (error: unknown) => error instanceof ProjectMembershipError && error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
      setProjectMemberAccess({
        workspaceId: agency.id,
        actorUserId: owner.id,
        projectId: unassignedProject.id,
        targetTelegramId: String(telegramBase + 7n),
        role: "MANAGER"
      }),
      (error: unknown) => error instanceof ProjectMembershipError && error.code === "MEMBER_NOT_FOUND"
    );
    await assert.rejects(
      setProjectMemberAccess({
        workspaceId: agency.id,
        actorUserId: owner.id,
        projectId: creatorProject.id,
        targetTelegramId: String(telegramBase + 3n),
        role: "VIEWER"
      }),
      (error: unknown) => error instanceof ProjectMembershipError && error.code === "CREATOR_HAS_MANAGER_ACCESS"
    );
    await assert.rejects(
      setProjectMemberAccess({
        workspaceId: agency.id,
        actorUserId: owner.id,
        projectId: foreignProject.id,
        targetTelegramId: String(telegramBase + 6n),
        role: "VIEWER"
      }),
      (error: unknown) => error instanceof ProjectMembershipError && error.code === "PROJECT_NOT_FOUND"
    );

    const revoked = await removeProjectMemberAccess({
      workspaceId: agency.id,
      actorUserId: admin.id,
      projectId: unassignedProject.id,
      targetTelegramId: String(telegramBase + 6n)
    });
    assert.equal(revoked.removed, true);
    assert.equal(await getAccessibleProject(unassignedProject.id, spare.id, ["VIEWER", "MANAGER"]), null);
    await assert.rejects(
      removeProjectMemberAccess({
        workspaceId: agency.id,
        actorUserId: owner.id,
        projectId: creatorProject.id,
        targetTelegramId: String(telegramBase + 3n)
      }),
      (error: unknown) => error instanceof ProjectMembershipError && error.code === "CREATOR_HAS_MANAGER_ACCESS"
    );

    // Removing an agency member revokes all explicit project access atomically.
    await removeWorkspaceMember({
      workspaceId: agency.id,
      actorUserId: owner.id,
      targetTelegramId: String(telegramBase + 4n)
    });
    assert.equal(await getAccessibleProject(managerProject.id, managerTwo.id, ["MANAGER", "VIEWER"]), null);
    assert.equal(await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: managerProject.id, userId: managerTwo.id } }
    }), null);

    // Personal workspaces keep their previous workspace-wide role semantics.
    assert.ok(await getAccessibleProject(personalProject.id, outsider.id, ["OWNER"]));
  } finally {
    for (const workspaceId of workspaceIds) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});
