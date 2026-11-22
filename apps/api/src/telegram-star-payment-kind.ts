export type TelegramStarsPaymentKind = "ONE_TIME" | "INITIAL_RECURRING" | "RECURRING_RENEWAL";

export interface TelegramStarsPaymentClassificationInput {
  planIsRecurring: boolean;
  paymentStatus: string;
  initialChargeId: string | null;
  isRecurring: boolean | undefined;
  isFirstRecurring: boolean | undefined;
}

/**
 * Classify a successful Stars receipt using the immutable checkout setting,
 * Telegram's recurring flags and the persisted first-charge anchor.
 * Unknown or contradictory combinations fail closed.
 */
export function classifyTelegramStarsPayment(
  input: TelegramStarsPaymentClassificationInput
): TelegramStarsPaymentKind | null {
  const canCompletePending = input.paymentStatus === "PENDING" || input.paymentStatus === "CANCELLED";

  if (!input.planIsRecurring) {
    return input.isRecurring === true || !canCompletePending ? null : "ONE_TIME";
  }

  if (input.isRecurring !== true) return null;

  if (input.initialChargeId === null) {
    return canCompletePending && input.isFirstRecurring === true
      ? "INITIAL_RECURRING"
      : null;
  }

  return input.paymentStatus === "SUCCEEDED" && input.isFirstRecurring === false
    ? "RECURRING_RENEWAL"
    : null;
}
