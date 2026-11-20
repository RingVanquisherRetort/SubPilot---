const TELEGRAM_UPDATE_SEQUENCE_RESET_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Telegram keeps update IDs increasing, but may start a new random sequence
 * after a bot has received no updates for at least a week.
 */
export function resolveTelegramUpdateSequenceEpoch(
  currentEpoch: number,
  lastUpdateAt: Date | null,
  now: Date
): number {
  if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 0) {
    throw new Error("Invalid Telegram update sequence epoch.");
  }
  if (!lastUpdateAt || !Number.isFinite(lastUpdateAt.getTime())) return currentEpoch;
  return now.getTime() - lastUpdateAt.getTime() >= TELEGRAM_UPDATE_SEQUENCE_RESET_MS
    ? currentEpoch + 1
    : currentEpoch;
}

/**
 * Apply state-changing updates only when they are newer than the last update
 * for that entity in the same Telegram sequence epoch. A later epoch supersedes
 * every cursor from an older sequence.
 */
export function shouldProcessTelegramUpdate(
  updateId: number,
  lastProcessedUpdateId: bigint | null,
  lastProcessedSequenceEpoch?: number | null,
  incomingSequenceEpoch?: number
): boolean {
  if (!Number.isSafeInteger(updateId) || updateId < 0) return false;

  if (incomingSequenceEpoch !== undefined && lastProcessedSequenceEpoch !== undefined &&
      lastProcessedSequenceEpoch !== null) {
    if (incomingSequenceEpoch > lastProcessedSequenceEpoch) return true;
    if (incomingSequenceEpoch < lastProcessedSequenceEpoch) return false;
  } else if (incomingSequenceEpoch !== undefined &&
      (lastProcessedSequenceEpoch === null || lastProcessedSequenceEpoch === undefined)) {
    return true;
  }

  return lastProcessedUpdateId === null || BigInt(updateId) > lastProcessedUpdateId;
}
