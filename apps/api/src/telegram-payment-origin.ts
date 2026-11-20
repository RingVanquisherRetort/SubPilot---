export function isPaymentFromProjectBot(metadata: unknown, projectBotId: string): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    // Older payment records may predate the project-bot origin snapshot.
    return true;
  }

  const originProjectBotId = (metadata as Record<string, unknown>).projectBotId;
  return typeof originProjectBotId !== "string" || originProjectBotId === projectBotId;
}
