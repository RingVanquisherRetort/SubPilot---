export function buildExpiredSubscriptionNotice(
  projectName: string,
  failedDestinations: readonly string[]
): string {
  const expiry = `Срок подписки в проекте «${projectName}» закончился.`;

  if (failedDestinations.length > 0) {
    return (
      expiry +
      "\n\nSubPilot пока не смог отключить доступ на всех площадках. " +
      "Администратор проекта уведомлён и должен проверить подключённые площадки. " +
      "До подтверждения отключения доступ на отдельных площадках может сохраняться."
    );
  }

  return expiry + " Доступ к закрытым площадкам прекращён.\n\nВы можете оформить её снова:";
}
