export const MAX_ACCESS_DELIVERY_ATTEMPTS = 10;

export interface AccessDeliveryFailureState {
  attempts: number;
  nextAttemptAt: Date;
  lastError: string;
  failedAt: Date | null;
}

/** Exponential retry schedule shared by the API worker and operator controls. */
export function getAccessDeliveryFailureState(
  attemptsSoFar: number,
  now: Date,
  errorCode: string
): AccessDeliveryFailureState {
  if (!Number.isSafeInteger(attemptsSoFar) || attemptsSoFar < 0) {
    throw new Error("Access-delivery attempt count must be a non-negative integer.");
  }
  const attempts = attemptsSoFar + 1;
  const retryMinutes = Math.min(60, 2 ** Math.min(attemptsSoFar, 6));
  const failedAt = attempts >= MAX_ACCESS_DELIVERY_ATTEMPTS ? now : null;
  const normalizedError = errorCode.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  return {
    attempts,
    nextAttemptAt: new Date(now.getTime() + retryMinutes * 60_000),
    lastError: normalizedError || "UNKNOWN_ACCESS_DELIVERY_ERROR",
    failedAt
  };
}
