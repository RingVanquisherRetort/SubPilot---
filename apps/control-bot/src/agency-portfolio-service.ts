import { prisma } from "@subpilot/database";
import {
  ADMIN_ROLES,
  MANAGER_ROLES,
  type WorkspaceRole
} from "./workspace-permissions.js";
import { lockWorkspace } from "./workspace-quota-enforcement.js";

type MembershipTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export class AgencyPortfolioError extends Error {
  constructor(public readonly code:
    | "WORKSPACE_NOT_FOUND"
    | "NOT_AN_AGENCY"
    | "ACTOR_NOT_MEMBER"
    | "PERMISSION_DENIED"
    | "PROJECT_NOT_FOUND"
    | "CREATOR_NOT_MEMBER"
  ) {
    super(code);
    this.name = "AgencyPortfolioError";
  }
}

function displayCreator(user: {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
} | null): string {
  if (!user) return "Не назначен";
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return fullName || (user.username ? "@" + user.username : "Без имени");
}

async function requireAgencyAndActor(
  tx: MembershipTransaction,
  workspaceId: string,
  actorUserId: string,
  allowedRoles: readonly WorkspaceRole[]
): Promise<{ name: string; role: WorkspaceRole }> {
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, type: true }
  });
  if (!workspace) throw new AgencyPortfolioError("WORKSPACE_NOT_FOUND");
  if (workspace.type !== "AGENCY") throw new AgencyPortfolioError("NOT_AN_AGENCY");
  const membership = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actorUserId } },
    select: { role: true }
  });
  if (!membership) throw new AgencyPortfolioError("ACTOR_NOT_MEMBER");
  if (!allowedRoles.includes(membership.role)) {
    throw new AgencyPortfolioError("PERMISSION_DENIED");
  }
  return { name: workspace.name, role: membership.role };
}

export async function getAgencyPortfolio(input: {
  workspaceId: string;
  actorUserId: string;
}): Promise<{
  workspaceName: string;
  totalProjects: number;
  assignedProjects: number;
  unassignedProjects: Array<{ id: string; name: string; status: string }>;
  creators: Array<{
    userId: string;
    name: string;
    projects: Array<{ id: string; name: string; status: string }>;
  }>;
}> {
  return prisma.$transaction(async (tx) => {
    const workspace = await requireAgencyAndActor(
      tx,
      input.workspaceId,
      input.actorUserId,
      MANAGER_ROLES
    );
    const projects = await tx.project.findMany({
      where: { workspaceId: input.workspaceId },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      select: {
        id: true,
        name: true,
        status: true,
        creatorUserId: true,
        creatorUser: {
          select: { id: true, firstName: true, lastName: true, username: true }
        }
      }
    });

    const grouped = new Map<string, {
      userId: string;
      name: string;
      projects: Array<{ id: string; name: string; status: string }>;
    }>();
    const unassignedProjects: Array<{ id: string; name: string; status: string }> = [];

    for (const project of projects) {
      const item = { id: project.id, name: project.name, status: project.status };
      if (!project.creatorUserId || !project.creatorUser) {
        unassignedProjects.push(item);
        continue;
      }
      const group = grouped.get(project.creatorUserId) ?? {
        userId: project.creatorUserId,
        name: displayCreator(project.creatorUser),
        projects: []
      };
      group.projects.push(item);
      grouped.set(project.creatorUserId, group);
    }

    const creators = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return {
      workspaceName: workspace.name,
      totalProjects: projects.length,
      assignedProjects: projects.length - unassignedProjects.length,
      unassignedProjects,
      creators
    };
  }, { isolationLevel: "ReadCommitted" });
}

export async function assignAgencyProjectCreator(input: {
  workspaceId: string;
  actorUserId: string;
  projectId: string;
  creatorTelegramId: string;
}): Promise<{ changed: boolean; projectName: string; creatorName: string; previousCreatorName: string }> {
  if (!/^\d{1,20}$/.test(input.creatorTelegramId)) {
    throw new AgencyPortfolioError("CREATOR_NOT_MEMBER");
  }
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    await requireAgencyAndActor(tx, input.workspaceId, input.actorUserId, ADMIN_ROLES);
    const project = await tx.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: {
        id: true,
        name: true,
        creatorUserId: true,
        creatorUser: { select: { firstName: true, lastName: true, username: true } }
      }
    });
    if (!project) throw new AgencyPortfolioError("PROJECT_NOT_FOUND");

    const creator = await tx.workspaceMember.findFirst({
      where: {
        workspaceId: input.workspaceId,
        user: { telegramId: BigInt(input.creatorTelegramId) }
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, username: true } }
      }
    });
    if (!creator) throw new AgencyPortfolioError("CREATOR_NOT_MEMBER");

    const previousCreatorName = displayCreator(project.creatorUser);
    const creatorName = displayCreator(creator.user);
    if (project.creatorUserId === creator.user.id) {
      return { changed: false, projectName: project.name, creatorName, previousCreatorName };
    }

    await tx.project.update({
      where: { id: project.id },
      data: { creatorUserId: creator.user.id }
    });
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: project.id,
        actorUserId: input.actorUserId,
        action: "AGENCY_PROJECT_CREATOR_ASSIGNED",
        resourceType: "Project",
        resourceId: project.id,
        metadata: {
          previousCreatorUserId: project.creatorUserId,
          creatorUserId: creator.user.id
        }
      }
    });
    return { changed: true, projectName: project.name, creatorName, previousCreatorName };
  }, { isolationLevel: "ReadCommitted" });
}

export async function unassignAgencyProjectCreator(input: {
  workspaceId: string;
  actorUserId: string;
  projectId: string;
}): Promise<{ changed: boolean; projectName: string; previousCreatorName: string }> {
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId);
    await requireAgencyAndActor(tx, input.workspaceId, input.actorUserId, ADMIN_ROLES);
    const project = await tx.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: {
        id: true,
        name: true,
        creatorUserId: true,
        creatorUser: { select: { firstName: true, lastName: true, username: true } }
      }
    });
    if (!project) throw new AgencyPortfolioError("PROJECT_NOT_FOUND");
    if (!project.creatorUserId) {
      return { changed: false, projectName: project.name, previousCreatorName: "Не назначен" };
    }
    const previousCreatorName = displayCreator(project.creatorUser);
    await tx.project.update({
      where: { id: project.id },
      data: { creatorUserId: null }
    });
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: project.id,
        actorUserId: input.actorUserId,
        action: "AGENCY_PROJECT_CREATOR_UNASSIGNED",
        resourceType: "Project",
        resourceId: project.id,
        metadata: { previousCreatorUserId: project.creatorUserId }
      }
    });
    return { changed: true, projectName: project.name, previousCreatorName };
  }, { isolationLevel: "ReadCommitted" });
}
