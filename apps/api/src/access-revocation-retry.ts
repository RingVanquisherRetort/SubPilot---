export interface AccessRevocationRetryState {
  attempts: number;
  nextAttemptAt: Date;
  lastError: string;
}

/**
 * Bounded exponential backoff for Telegram access revocation. Failed grants
 * move out of the due queue temporarily so one broken chat/bot cannot occupy
 * the first BATCH_SIZE positions on every lifecycle pass.
 */
export function getAccessRevocationRetryState(
  currentAttempts: number,
  now: Date,
  errorCode: string
): AccessRevocationRetryState {
  const attempts = Math.max(0, Math.floor(currentAttempts)) + 1;
  const retryMinutes = Math.min(60, 2 ** Math.min(attempts, 6));
  return {
    attempts,
    nextAttemptAt: new Date(now.getTime() + retryMinutes * 60_000),
    lastError: /^[A-Z0-9_]{1,64}$/.test(errorCode) ? errorCode : "ACCESS_REVOCATION_FAILED"
  };
}
