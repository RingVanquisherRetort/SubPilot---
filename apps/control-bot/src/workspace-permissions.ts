export const MANAGER_ROLES = ["OWNER", "ADMIN", "MANAGER"] as const;
export const ADMIN_ROLES = ["OWNER", "ADMIN"] as const;

export type WorkspaceRole = "OWNER" | "ADMIN" | "MANAGER" | "VIEWER";
export type InvitableWorkspaceRole = "ADMIN" | "MANAGER" | "VIEWER";

export function canInviteWorkspaceRole(
  actorRole: WorkspaceRole,
  requestedRole: InvitableWorkspaceRole
): boolean {
  if (actorRole !== "OWNER" && actorRole !== "ADMIN") return false;
  return requestedRole !== "ADMIN" || actorRole === "OWNER";
}

export function canRemoveWorkspaceMember(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  isSelf: boolean
): boolean {
  if (actorRole !== "OWNER" && actorRole !== "ADMIN") return false;
  if (isSelf || targetRole === "OWNER") return false;
  if (actorRole === "ADMIN" && targetRole === "ADMIN") return false;
  return true;
}
