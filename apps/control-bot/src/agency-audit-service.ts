import { prisma } from "@subpilot/database";

export class AgencyAuditError extends Error {
  constructor(public readonly code:
    | "WORKSPACE_NOT_FOUND"
    | "NOT_AN_AGENCY"
    | "ACTOR_NOT_MEMBER"
    | "PERMISSION_DENIED"
    | "INVALID_RANGE"
  ) {
    super(code);
    this.name = "AgencyAuditError";
  }
}

export interface AgencyAuditEvent {
  id: string;
  createdAt: Date;
  projectName: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actor: string;
}

const MAX_EXPORT_ROWS = 5_000;

function displayActor(user: {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
} | null): string {
  if (!user) return "System";
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return fullName || (user.username ? "@" + user.username : "Unknown user");
}

function csvCell(value: string): string {
  // Prevent spreadsheet formula execution while retaining RFC 4180 quoting.
  const first = value.trimStart().charAt(0);
  const safe = ["=", "+", "-", "@"].includes(first) ? "'" + value : value;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function buildAgencyAuditCsv(events: readonly AgencyAuditEvent[]): string {
  const columns = [
    "created_at_utc",
    "project",
    "action",
    "resource_type",
    "resource_id",
    "actor"
  ];
  const rows = events.map((event) => [
    event.createdAt.toISOString(),
    event.projectName,
    event.action,
    event.resourceType,
    event.resourceId ?? "",
    event.actor
  ]);
  return "\uFEFF" + [columns, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n") + "\r\n";
}

async function loadAgencyAuditEvents(input: {
  workspaceId: string;
  actorUserId: string;
  from?: Date;
  to?: Date;
  take: number;
}): Promise<{ workspaceName: string; events: AgencyAuditEvent[] }> {
  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { name: true, type: true }
    });
    if (!workspace) throw new AgencyAuditError("WORKSPACE_NOT_FOUND");
    if (workspace.type !== "AGENCY") throw new AgencyAuditError("NOT_AN_AGENCY");

    const membership = await tx.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.actorUserId
        }
      },
      select: { role: true }
    });
    if (!membership) throw new AgencyAuditError("ACTOR_NOT_MEMBER");
    const hasWorkspaceWideAccess = membership.role === "OWNER" || membership.role === "ADMIN";
    const projectFilter = !hasWorkspaceWideAccess
      ? await tx.project.findMany({
          where: {
            workspaceId: input.workspaceId,
            OR: [
              { creatorUserId: input.actorUserId },
              { members: { some: { userId: input.actorUserId, role: "MANAGER" } } }
            ]
          },
          select: { id: true }
        })
      : null;
    if (projectFilter && projectFilter.length === 0) {
      throw new AgencyAuditError("PERMISSION_DENIED");
    }

    const events = await tx.auditLog.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(projectFilter ? { projectId: { in: projectFilter.map((project) => project.id) } } : {}),
        ...(input.from || input.to ? {
          createdAt: {
            ...(input.from ? { gte: input.from } : {}),
            ...(input.to ? { lte: input.to } : {})
          }
        } : {})
      },
      include: {
        project: { select: { name: true } },
        actor: { select: { firstName: true, lastName: true, username: true } }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.take
    });

    return {
      workspaceName: workspace.name,
      events: events.map((event) => ({
        id: event.id,
        createdAt: event.createdAt,
        projectName: event.project?.name ?? (event.projectId ? "Deleted project" : "Workspace"),
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        actor: displayActor(event.actor)
      }))
    };
  }, { isolationLevel: "ReadCommitted" });
}

export async function listAgencyAuditHistory(input: {
  workspaceId: string;
  actorUserId: string;
  limit?: number;
}): Promise<{ workspaceName: string; events: AgencyAuditEvent[] }> {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new AgencyAuditError("INVALID_RANGE");
  }
  return loadAgencyAuditEvents({ ...input, take: limit });
}

export async function exportAgencyAuditHistory(input: {
  workspaceId: string;
  actorUserId: string;
  periodDays?: number;
  now?: Date;
}): Promise<{
  workspaceName: string;
  from: Date;
  to: Date;
  eventCount: number;
  truncated: boolean;
  csv: string;
}> {
  const periodDays = input.periodDays ?? 90;
  if (!Number.isSafeInteger(periodDays) || periodDays < 1 || periodDays > 365) {
    throw new AgencyAuditError("INVALID_RANGE");
  }
  const to = input.now ?? new Date();
  const from = new Date(to.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const result = await loadAgencyAuditEvents({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    from,
    to,
    take: MAX_EXPORT_ROWS + 1
  });
  const truncated = result.events.length > MAX_EXPORT_ROWS;
  const events = truncated ? result.events.slice(0, MAX_EXPORT_ROWS) : result.events;
  return {
    workspaceName: result.workspaceName,
    from,
    to,
    eventCount: events.length,
    truncated,
    csv: buildAgencyAuditCsv(events)
  };
}
