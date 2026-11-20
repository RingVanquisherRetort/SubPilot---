export function selectOwnerNotificationRecipientIds(
  workspaceOwnerId: string,
  projectCreatorId: string | null,
  creatorIsWorkspaceMember: boolean
): string[] {
  const recipients = new Set<string>([workspaceOwnerId]);
  if (projectCreatorId && (projectCreatorId === workspaceOwnerId || creatorIsWorkspaceMember)) {
    recipients.add(projectCreatorId);
  }
  return [...recipients];
}

export function isCurrentOwnerNotificationRecipient(
  recipientUserId: string,
  workspaceOwnerId: string,
  isWorkspaceMember: boolean
): boolean {
  return recipientUserId === workspaceOwnerId || isWorkspaceMember;
}
