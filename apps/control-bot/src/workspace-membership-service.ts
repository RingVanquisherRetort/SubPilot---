import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@subpilot/database";
import {
  ADMIN_ROLES,
  canChangeWorkspaceMemberRole,
  canInviteWorkspaceRole,
  canRemoveWorkspaceMember,
  type InvitableWorkspaceRole,
  type WorkspaceRole
} from "./workspace-permissions.js";
import { lockWorkspace } from "./workspace-quota-enforcement.js";

type MembershipTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export class WorkspaceMembershipError extends Error {
  constructor(public readonly code:
    | "WORKSPACE_NOT_FOUND"
    | "ACTOR_NOT_MEMBER"
    | "PERMISSION_DENIED"
    | "MEMBER_NOT_FOUND"
    | "INVITE_NOT_FOUND"
    | "INVITE_INVALID"
  ) {
    super(code);
    this.name = "WorkspaceMembershipError";
  }
}

async function actorRole(
  tx: MembershipTransaction,
  workspaceId: string,
  actorUserId: string
): Promise<WorkspaceRole> {
  const actor = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actorUserId } },
    select: { role: true }
  });
  if (!actor) throw new WorkspaceMembershipError("ACTOR_NOT_MEMBER");
  return actor.role;
}

export async function listWorkspaceMembersForAdmin(input: {
  workspaceId: string;
  actorUserId: string;
}): Promise<{
  workspaceName: string;
  members: Array<{
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    telegramId: string;
    role: WorkspaceRole;
  }>;
}> {
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    const role = await actorRole(tx, input.workspaceId, input.actorUserId);
    if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
      throw new WorkspaceMembershipError("PERMISSION_DENIED");
    }
    const [workspace, members] = await Promise.all([
      tx.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { name: true }
      }),
      tx.workspaceMember.findMany({
        where: { workspaceId: input.workspaceId },
        include: {
          user: {
            select: {
              firstName: true,
              lastName: true,
              username: true,
              telegramId: true
            }
          }
        },
        orderBy: { createdAt: "asc" }
      })
    ]);
    if (!workspace) throw new WorkspaceMembershipError("WORKSPACE_NOT_FOUND");
    return {
      workspaceName: workspace.name,
      members: members.map((member) => ({
        ...member.user,
        telegramId: member.user.telegramId.toString(),
        role: member.role
      }))
    };
  }, { isolationLevel: "ReadCommitted" });
}

export async function setWorkspaceMemberRole(input: {
  workspaceId: string;
  actorUserId: string;
  targetTelegramId: string;
  requestedRole: InvitableWorkspaceRole;
}): Promise<{ telegramId: string; previousRole: WorkspaceRole; role: WorkspaceRole }> {
  if (!/^\d{1,20}$/.test(input.targetTelegramId)) {
    throw new WorkspaceMembershipError("MEMBER_NOT_FOUND");
  }
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    const role = await actorRole(tx, input.workspaceId, input.actorUserId);
    const target = await tx.workspaceMember.findFirst({
      where: {
        workspaceId: input.workspaceId,
        user: { telegramId: BigInt(input.targetTelegramId) }
      },
      include: { user: { select: { telegramId: true } } }
    });
    if (!target) throw new WorkspaceMembershipError("MEMBER_NOT_FOUND");
    const isSelf = target.userId === input.actorUserId;
    if (!canChangeWorkspaceMemberRole(role, target.role, isSelf, input.requestedRole)) {
      throw new WorkspaceMembershipError("PERMISSION_DENIED");
    }
    const updated = await tx.workspaceMember.update({
      where: { id: target.id },
      data: { role: input.requestedRole },
      select: { role: true, user: { select: { telegramId: true } } }
    });
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        action: "WORKSPACE_MEMBER_ROLE_CHANGED",
        resourceType: "WorkspaceMember",
        resourceId: target.id,
        metadata: {
          targetTelegramId: input.targetTelegramId,
          previousRole: target.role,
          newRole: updated.role
        }
      }
    });
    return {
      telegramId: updated.user.telegramId.toString(),
      previousRole: target.role,
      role: updated.role
    };
  }, { isolationLevel: "ReadCommitted" });
}

export async function removeWorkspaceMember(input: {
  workspaceId: string;
  actorUserId: string;
  targetTelegramId: string;
}): Promise<{ telegramId: string; role: WorkspaceRole }> {
  if (!/^\d{1,20}$/.test(input.targetTelegramId)) {
    throw new WorkspaceMembershipError("MEMBER_NOT_FOUND");
  }
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    const role = await actorRole(tx, input.workspaceId, input.actorUserId);
    const target = await tx.workspaceMember.findFirst({
      where: {
        workspaceId: input.workspaceId,
        user: { telegramId: BigInt(input.targetTelegramId) }
      },
      include: { user: { select: { id: true, telegramId: true, activeWorkspaceId: true } } }
    });
    if (!target) throw new WorkspaceMembershipError("MEMBER_NOT_FOUND");
    const isSelf = target.userId === input.actorUserId;
    if (!canRemoveWorkspaceMember(role, target.role, isSelf)) {
      throw new WorkspaceMembershipError("PERMISSION_DENIED");
    }

    // A removed workspace member can no longer remain the active creator
    // assigned to projects in this agency. Preserve the projects and clear only
    // their current creator assignment, in the same transaction as membership removal.
    const clearedCreatorAssignments = await tx.project.updateMany({
      where: {
        workspaceId: input.workspaceId,
        creatorUserId: target.userId
      },
      data: { creatorUserId: null }
    });
    if (clearedCreatorAssignments.count > 0) {
      await tx.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          action: "AGENCY_PROJECT_CREATOR_CLEARED_MEMBER_REMOVED",
          resourceType: "ProjectCreatorAssignments",
          metadata: {
            removedCreatorUserId: target.userId,
            assignmentCount: clearedCreatorAssignments.count
          }
        }
      });
    }
    const removedProjectMemberships = await tx.projectMember.deleteMany({
      where: {
        userId: target.userId,
        project: { workspaceId: input.workspaceId }
      }
    });
    if (removedProjectMemberships.count > 0) {
      await tx.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          action: "PROJECT_MEMBER_ACCESS_CLEARED_MEMBER_REMOVED",
          resourceType: "ProjectMemberAssignments",
          metadata: {
            removedUserId: target.userId,
            assignmentCount: removedProjectMemberships.count
          }
        }
      });
    }

    await tx.workspaceMember.delete({ where: { id: target.id } });
    if (target.user.activeWorkspaceId === input.workspaceId) {
      await tx.user.updateMany({
        where: { id: target.userId, activeWorkspaceId: input.workspaceId },
        data: { activeWorkspaceId: null }
      });
    }
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        action: "WORKSPACE_MEMBER_REMOVED",
        resourceType: "WorkspaceMember",
        resourceId: target.id,
        metadata: {
          targetTelegramId: target.user.telegramId.toString(),
          removedRole: target.role
        }
      }
    });
    return { telegramId: target.user.telegramId.toString(), role: target.role };
  }, { isolationLevel: "ReadCommitted" });
}

export async function createWorkspaceInvite(input: {
  workspaceId: string;
  actorUserId: string;
  requestedRole: InvitableWorkspaceRole;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    const role = await actorRole(tx, input.workspaceId, input.actorUserId);
    if (!canInviteWorkspaceRole(role, input.requestedRole)) {
      throw new WorkspaceMembershipError("PERMISSION_DENIED");
    }
    const invite = await tx.workspaceInvite.create({
      data: {
        workspaceId: input.workspaceId,
        invitedByUserId: input.actorUserId,
        tokenHash,
        role: input.requestedRole,
        expiresAt
      },
      select: { id: true }
    });
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        action: "WORKSPACE_INVITE_CREATED",
        resourceType: "WorkspaceInvite",
        resourceId: invite.id,
        metadata: { role: input.requestedRole, expiresAt: expiresAt.toISOString() }
      }
    });
  }, { isolationLevel: "ReadCommitted" });
  return { token, expiresAt };
}

export async function revokeWorkspaceInvite(input: {
  workspaceId: string;
  actorUserId: string;
  inviteId: string;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    const role = await actorRole(tx, input.workspaceId, input.actorUserId);
    if (!ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number])) {
      throw new WorkspaceMembershipError("PERMISSION_DENIED");
    }
    const invite = await tx.workspaceInvite.findFirst({
      where: { id: input.inviteId, workspaceId: input.workspaceId, usedAt: null },
      select: { id: true, role: true, expiresAt: true }
    });
    if (!invite || invite.expiresAt.getTime() <= Date.now()) return false;
    if (role === "ADMIN" && invite.role === "ADMIN") {
      throw new WorkspaceMembershipError("PERMISSION_DENIED");
    }
    const updated = await tx.workspaceInvite.updateMany({
      where: {
        id: invite.id,
        workspaceId: input.workspaceId,
        usedAt: null,
        expiresAt: { gt: new Date() }
      },
      data: { usedAt: new Date() }
    });
    if (updated.count !== 1) return false;
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        action: "WORKSPACE_INVITE_REVOKED",
        resourceType: "WorkspaceInvite",
        resourceId: invite.id,
        metadata: { role: invite.role }
      }
    });
    return true;
  }, { isolationLevel: "ReadCommitted" });
}
