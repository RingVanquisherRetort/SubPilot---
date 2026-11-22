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

  // Bot API models is_first_recurring as an optional True-only flag.
  // Later recurring charges therefore normally omit it instead of sending false.
  // The persisted first-charge anchor proves that this recurring chain
  // was initialized successfully. Its ledger row may later be refunded while
  // Telegram can still deliver a valid subsequent renewal.
  return input.isFirstRecurring === undefined &&
    ["SUCCEEDED", "REFUNDING", "REFUNDED"].includes(input.paymentStatus)
      ? "RECURRING_RENEWAL"
      : null;
}
