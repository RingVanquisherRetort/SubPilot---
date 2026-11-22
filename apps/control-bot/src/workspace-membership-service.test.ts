import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("workspace membership administration rechecks roles transactionally and audits mutations", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const {
    WorkspaceMembershipError,
    createWorkspaceInvite,
    listWorkspaceMembersForAdmin,
    removeWorkspaceMember,
    revokeWorkspaceInvite,
    setWorkspaceMemberRole
  } = await import("./workspace-membership-service.js");

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  const users: string[] = [];
  let workspaceId: string | undefined;
  let otherWorkspaceId: string | undefined;

  try {
    const makeUser = async (offset: number, firstName: string) => {
      const user = await prisma.user.create({
        data: { telegramId: telegramBase + BigInt(offset), firstName }
      });
      users.push(user.id);
      return user;
    };
    const owner = await makeUser(1, "Membership Owner");
    const admin = await makeUser(2, "Membership Admin");
    const secondAdmin = await makeUser(3, "Second Admin");
    const manager = await makeUser(4, "Membership Manager");
    const viewer = await makeUser(5, "Membership Viewer");
    const outsider = await makeUser(6, "Workspace Outsider");

    const workspace = await prisma.workspace.create({
      data: {
        name: "Membership test " + suffix,
        slug: "membership-" + suffix,
        createdById: owner.id,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: admin.id, role: "ADMIN" },
            { userId: secondAdmin.id, role: "ADMIN" },
            { userId: manager.id, role: "MANAGER" },
            { userId: viewer.id, role: "VIEWER" }
          ]
        }
      }
    });
    workspaceId = workspace.id;

    const otherWorkspace = await prisma.workspace.create({
      data: {
        name: "Other membership test " + suffix,
        slug: "membership-other-" + suffix,
        createdById: outsider.id,
        members: { create: { userId: outsider.id, role: "OWNER" } }
      }
    });
    otherWorkspaceId = otherWorkspace.id;

    await prisma.user.update({
      where: { id: viewer.id },
      data: { activeWorkspaceId: workspace.id }
    });

    const directory = await listWorkspaceMembersForAdmin({
      workspaceId: workspace.id,
      actorUserId: admin.id
    });
    assert.equal(directory.workspaceName, workspace.name);
    assert.equal(directory.members.length, 5);
    assert.equal(directory.members.some((member) => member.telegramId === String(telegramBase + 1n)), true);
    await assert.rejects(
      listWorkspaceMembersForAdmin({ workspaceId: workspace.id, actorUserId: manager.id }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
      listWorkspaceMembersForAdmin({ workspaceId: workspace.id, actorUserId: viewer.id }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED"
    );

    await assert.rejects(
      setWorkspaceMemberRole({
        workspaceId: workspace.id,
        actorUserId: manager.id,
        targetTelegramId: String(telegramBase + 5n),
        requestedRole: "MANAGER"
      }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED"
    );
    const promoted = await setWorkspaceMemberRole({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      targetTelegramId: String(telegramBase + 4n),
      requestedRole: "ADMIN"
    });
    assert.equal(promoted.previousRole, "MANAGER");
    assert.equal(promoted.role, "ADMIN");

    await assert.rejects(
      setWorkspaceMemberRole({
        workspaceId: workspace.id,
        actorUserId: admin.id,
        targetTelegramId: String(telegramBase + 3n),
        requestedRole: "VIEWER"
      }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
      setWorkspaceMemberRole({
        workspaceId: workspace.id,
        actorUserId: admin.id,
        targetTelegramId: String(telegramBase + 5n),
        requestedRole: "ADMIN"
      }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
      setWorkspaceMemberRole({
        workspaceId: workspace.id,
        actorUserId: admin.id,
        targetTelegramId: String(telegramBase + 2n),
        requestedRole: "VIEWER"
      }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
      setWorkspaceMemberRole({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        targetTelegramId: String(telegramBase + 1n),
        requestedRole: "VIEWER"
      }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
      setWorkspaceMemberRole({
        workspaceId: otherWorkspace.id,
        actorUserId: outsider.id,
        targetTelegramId: String(telegramBase + 5n),
        requestedRole: "MANAGER"
      }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "MEMBER_NOT_FOUND"
    );

    const adminInvite = await createWorkspaceInvite({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      requestedRole: "ADMIN"
    });
    assert.equal(adminInvite.token.length > 30, true);
    const storedAdminInvite = await prisma.workspaceInvite.findFirstOrThrow({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" }
    });
    assert.notEqual(storedAdminInvite.tokenHash, adminInvite.token);
    assert.equal(storedAdminInvite.role, "ADMIN");
    await assert.rejects(
      revokeWorkspaceInvite({
        workspaceId: workspace.id,
        actorUserId: admin.id,
        inviteId: storedAdminInvite.id
      }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED"
    );
    assert.equal((await prisma.workspaceInvite.findUniqueOrThrow({
      where: { id: storedAdminInvite.id }
    })).usedAt, null);

    const ordinaryInvite = await createWorkspaceInvite({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      requestedRole: "MANAGER"
    });
    const storedOrdinaryInvite = await prisma.workspaceInvite.findFirstOrThrow({
      where: { workspaceId: workspace.id, role: "MANAGER" },
      orderBy: { createdAt: "desc" }
    });
    assert.equal(await revokeWorkspaceInvite({
      workspaceId: workspace.id,
      actorUserId: admin.id,
      inviteId: storedOrdinaryInvite.id
    }), true);
    assert.equal(await revokeWorkspaceInvite({
      workspaceId: workspace.id,
      actorUserId: admin.id,
      inviteId: storedOrdinaryInvite.id
    }), false);
    assert.ok(ordinaryInvite.token.length > 30);

    await assert.rejects(
      createWorkspaceInvite({
        workspaceId: workspace.id,
        actorUserId: viewer.id,
        requestedRole: "VIEWER"
      }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED"
    );

    await assert.rejects(
      removeWorkspaceMember({
        workspaceId: workspace.id,
        actorUserId: admin.id,
        targetTelegramId: String(telegramBase + 3n)
      }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
      removeWorkspaceMember({
        workspaceId: workspace.id,
        actorUserId: admin.id,
        targetTelegramId: String(telegramBase + 2n)
      }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "PERMISSION_DENIED"
    );
    const removed = await removeWorkspaceMember({
      workspaceId: workspace.id,
      actorUserId: admin.id,
      targetTelegramId: String(telegramBase + 5n)
    });
    assert.equal(removed.role, "VIEWER");
    const removedUser = await prisma.user.findUniqueOrThrow({
      where: { id: viewer.id },
      select: { activeWorkspaceId: true }
    });
    assert.equal(removedUser.activeWorkspaceId, null);
    await assert.rejects(
      removeWorkspaceMember({
        workspaceId: workspace.id,
        actorUserId: outsider.id,
        targetTelegramId: String(telegramBase + 4n)
      }),
      (error: unknown) => error instanceof WorkspaceMembershipError && error.code === "ACTOR_NOT_MEMBER"
    );

    const audit = await prisma.auditLog.findMany({
      where: {
        workspaceId: workspace.id,
        action: {
          in: [
            "WORKSPACE_MEMBER_ROLE_CHANGED",
            "WORKSPACE_MEMBER_REMOVED",
            "WORKSPACE_INVITE_CREATED",
            "WORKSPACE_INVITE_REVOKED"
          ]
        }
      },
      orderBy: { createdAt: "asc" }
    });
    assert.equal(audit.length, 5);
    assert.equal(audit.some((event) => event.action === "WORKSPACE_MEMBER_REMOVED"), true);
    assert.equal(audit.some((event) => event.action === "WORKSPACE_INVITE_REVOKED"), true);
    assert.equal(audit.some((event) => JSON.stringify(event.metadata).includes(adminInvite.token)), false);
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (otherWorkspaceId) await prisma.workspace.deleteMany({ where: { id: otherWorkspaceId } });
    if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
});
