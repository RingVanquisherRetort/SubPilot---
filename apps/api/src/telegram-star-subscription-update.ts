export type TelegramStarSubscriptionState = "ACTIVE" | "CANCELED" | "FAILED";

export interface TelegramStarSubscriptionUpdate {
  telegramUserId: number;
  invoicePayload: string;
  state: TelegramStarSubscriptionState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the optional Bot API Update.subscription field without assuming that
 * the installed grammY type definitions already know about newer Bot API fields.
 */
export function parseTelegramStarSubscriptionUpdate(
  update: unknown
): TelegramStarSubscriptionUpdate | null {
  if (!isRecord(update) || !isRecord(update.subscription)) return null;

  const subscription = update.subscription;
  const user = isRecord(subscription.user) ? subscription.user : null;
  const telegramUserId = user?.id;
  const invoicePayload = subscription.invoice_payload;
  const rawState = subscription.state;

  if (
    typeof telegramUserId !== "number" ||
    !Number.isSafeInteger(telegramUserId) ||
    telegramUserId <= 0 ||
    typeof invoicePayload !== "string" ||
    invoicePayload.length === 0 ||
    Buffer.byteLength(invoicePayload, "utf8") > 128 ||
    (rawState !== "active" && rawState !== "canceled" && rawState !== "failed")
  ) {
    return null;
  }

  return {
    telegramUserId,
    invoicePayload,
    state: rawState === "active" ? "ACTIVE" : rawState === "canceled" ? "CANCELED" : "FAILED"
  };
}
