import { prisma } from "@subpilot/database";
import type { WorkspaceRole } from "./workspace-permissions.js";

export type ProjectAccessRole = WorkspaceRole;

export async function getAccessibleProject(
  projectId: string,
  userId: string,
  allowedRoles: readonly ProjectAccessRole[],
  db: Pick<typeof prisma, "project"> = prisma
) {
  const project = await db.project.findFirst({
    where: {
      id: projectId,
      status: { not: "ARCHIVED" },
      workspace: { members: { some: { userId } } }
    },
    select: {
      id: true,
      name: true,
      workspaceId: true,
      defaultCurrency: true,
      countryCode: true,
      merchantType: true,
      creatorUserId: true,
      creatorUser: { select: { firstName: true, lastName: true, username: true } },
      workspace: {
        select: {
          type: true,
          members: {
            where: { userId },
            select: { role: true },
            take: 1
          }
        }
      },
      members: {
        where: { userId },
        select: { role: true },
        take: 1
      }
    }
  });
  if (!project) return null;

  const workspaceRole = project.workspace.members[0]?.role;
  if (!workspaceRole) return null;

  let accessRole: ProjectAccessRole | null = null;
  if (project.workspace.type === "PERSONAL") {
    // Preserve the established personal-workspace permissions.
    accessRole = workspaceRole;
  } else if (workspaceRole === "OWNER" || workspaceRole === "ADMIN") {
    // Agency owners and administrators retain workspace-wide control.
    accessRole = workspaceRole;
  } else if (project.creatorUserId === userId) {
    // The assigned responsible creator is a manager of this project only.
    accessRole = "MANAGER";
  } else {
    const projectRole = project.members[0]?.role;
    if (projectRole === "MANAGER" || projectRole === "VIEWER") {
      accessRole = projectRole;
    }
  }

  if (!accessRole || !allowedRoles.includes(accessRole)) return null;
  const { workspace, members: _members, ...projectData } = project;
  return { ...projectData, workspaceType: workspace.type, accessRole };
}
