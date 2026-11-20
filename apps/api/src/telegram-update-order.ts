/**
 * Telegram update IDs are monotonically increasing per bot. Once an update ID
 * has been processed, duplicates and older updates must not mutate chat state.
 */
export function shouldProcessTelegramUpdate(
  updateId: number,
  lastProcessedUpdateId: bigint | null
): boolean {
  if (!Number.isSafeInteger(updateId) || updateId < 0) return false;
  return lastProcessedUpdateId === null || BigInt(updateId) > lastProcessedUpdateId;
}
