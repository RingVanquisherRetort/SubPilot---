export function buildWorkspaceInviteAcceptanceMessage(
  workspaceName: string,
  currentRole: string,
  wasAlreadyMember: boolean
): string {
  if (wasAlreadyMember) {
    return (
      `Вы уже состоите в пространстве «${workspaceName}».\n` +
      `Ваша текущая роль сохранена: ${currentRole.toLowerCase()}.\n\n` +
      "Текущий кабинет: /start · Проекты: /projects"
    );
  }

  return (
    `Вы присоединились к пространству «${workspaceName}».\n` +
    `Ваша роль: ${currentRole.toLowerCase()}.\n\n` +
    "Текущий кабинет: /start · Проекты: /projects"
  );
}
