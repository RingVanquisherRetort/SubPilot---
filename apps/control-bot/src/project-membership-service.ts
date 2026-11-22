import { prisma } from "@subpilot/database";
import { ADMIN_ROLES, type WorkspaceRole } from "./workspace-permissions.js";
import { lockWorkspace } from "./workspace-quota-enforcement.js";

type ProjectMembershipTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export type ProjectMemberRole = "MANAGER" | "VIEWER";

export class ProjectMembershipError extends Error {
  constructor(public readonly code:
    | "WORKSPACE_NOT_FOUND"
    | "NOT_AN_AGENCY"
    | "ACTOR_NOT_MEMBER"
    | "PERMISSION_DENIED"
    | "PROJECT_NOT_FOUND"
    | "MEMBER_NOT_FOUND"
    | "PROJECT_MEMBER_NOT_FOUND"
    | "CREATOR_HAS_MANAGER_ACCESS"
  ) {
    super(code);
    this.name = "ProjectMembershipError";
  }
}

async function requireProjectAdmin(
  tx: ProjectMembershipTransaction,
  workspaceId: string,
  actorUserId: string
): Promise<void> {
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { type: true }
  });
  if (!workspace) throw new ProjectMembershipError("WORKSPACE_NOT_FOUND");
  if (workspace.type !== "AGENCY") throw new ProjectMembershipError("NOT_AN_AGENCY");
  const actor = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actorUserId } },
    select: { role: true }
  });
  if (!actor) throw new ProjectMembershipError("ACTOR_NOT_MEMBER");
  if (!ADMIN_ROLES.includes(actor.role as typeof ADMIN_ROLES[number])) {
    throw new ProjectMembershipError("PERMISSION_DENIED");
  }
}

export async function setProjectMemberAccess(input: {
  workspaceId: string;
  actorUserId: string;
  projectId: string;
  targetTelegramId: string;
  role: ProjectMemberRole;
}): Promise<{ changed: boolean; projectName: string; memberName: string; previousRole: ProjectMemberRole | null; role: ProjectMemberRole }> {
  if (!/^\d{1,20}$/.test(input.targetTelegramId)) {
    throw new ProjectMembershipError("MEMBER_NOT_FOUND");
  }
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    await requireProjectAdmin(tx, input.workspaceId, input.actorUserId);
    const project = await tx.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId, status: { not: "ARCHIVED" } },
      select: { id: true, name: true, creatorUserId: true }
    });
    if (!project) throw new ProjectMembershipError("PROJECT_NOT_FOUND");
    const target = await tx.workspaceMember.findFirst({
      where: {
        workspaceId: input.workspaceId,
        user: { telegramId: BigInt(input.targetTelegramId) }
      },
      select: {
        userId: true,
        user: { select: { firstName: true, lastName: true, username: true } }
      }
    });
    if (!target) throw new ProjectMembershipError("MEMBER_NOT_FOUND");
    if (project.creatorUserId === target.userId && input.role === "VIEWER") {
      throw new ProjectMembershipError("CREATOR_HAS_MANAGER_ACCESS");
    }
    const existing = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: target.userId } },
      select: { id: true, role: true }
    });
    const memberName = [target.user.firstName, target.user.lastName].filter(Boolean).join(" ").trim()
      || (target.user.username ? "@" + target.user.username : "Участник");
    if (existing?.role === input.role) {
      return { changed: false, projectName: project.name, memberName, previousRole: existing.role, role: input.role };
    }
    const membership = existing
      ? await tx.projectMember.update({
          where: { id: existing.id },
          data: { role: input.role },
          select: { id: true, role: true }
        })
      : await tx.projectMember.create({
          data: { projectId: project.id, userId: target.userId, role: input.role },
          select: { id: true, role: true }
        });
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: project.id,
        actorUserId: input.actorUserId,
        action: "PROJECT_MEMBER_ACCESS_CHANGED",
        resourceType: "ProjectMember",
        resourceId: membership.id,
        metadata: {
          targetUserId: target.userId,
          previousRole: existing?.role ?? null,
          newRole: membership.role
        }
      }
    });
    return {
      changed: true,
      projectName: project.name,
      memberName,
      previousRole: existing?.role ?? null,
      role: membership.role
    };
  }, { isolationLevel: "ReadCommitted" });
}

export async function removeProjectMemberAccess(input: {
  workspaceId: string;
  actorUserId: string;
  projectId: string;
  targetTelegramId: string;
}): Promise<{ removed: boolean; projectName: string; memberName: string; role: ProjectMemberRole | null }> {
  if (!/^\d{1,20}$/.test(input.targetTelegramId)) {
    throw new ProjectMembershipError("MEMBER_NOT_FOUND");
  }
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    await requireProjectAdmin(tx, input.workspaceId, input.actorUserId);
    const project = await tx.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { id: true, name: true, creatorUserId: true }
    });
    if (!project) throw new ProjectMembershipError("PROJECT_NOT_FOUND");
    const target = await tx.workspaceMember.findFirst({
      where: {
        workspaceId: input.workspaceId,
        user: { telegramId: BigInt(input.targetTelegramId) }
      },
      select: {
        userId: true,
        user: { select: { firstName: true, lastName: true, username: true } }
      }
    });
    if (!target) throw new ProjectMembershipError("MEMBER_NOT_FOUND");
    if (project.creatorUserId === target.userId) {
      throw new ProjectMembershipError("CREATOR_HAS_MANAGER_ACCESS");
    }
    const existing = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: target.userId } },
      select: { id: true, role: true }
    });
    const memberName = [target.user.firstName, target.user.lastName].filter(Boolean).join(" ").trim()
      || (target.user.username ? "@" + target.user.username : "Участник");
    if (!existing) {
      return { removed: false, projectName: project.name, memberName, role: null };
    }
    await tx.projectMember.delete({ where: { id: existing.id } });
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: project.id,
        actorUserId: input.actorUserId,
        action: "PROJECT_MEMBER_ACCESS_REMOVED",
        resourceType: "ProjectMember",
        resourceId: existing.id,
        metadata: { targetUserId: target.userId, removedRole: existing.role }
      }
    });
    return { removed: true, projectName: project.name, memberName, role: existing.role };
  }, { isolationLevel: "ReadCommitted" });
}
