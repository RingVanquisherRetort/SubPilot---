export type TelegramRefundErrorClassification =
  | { kind: "ALREADY_REFUNDED" }
  | { kind: "REJECTED"; errorCode: number }
  | { kind: "UNKNOWN" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Classify Telegram API failures without treating transport errors as definitive rejections. */
export function classifyTelegramRefundError(error: unknown): TelegramRefundErrorClassification {
  if (!isRecord(error)) return { kind: "UNKNOWN" };
  const description = typeof error.description === "string" ? error.description : "";
  if (description.includes("CHARGE_ALREADY_REFUNDED")) return { kind: "ALREADY_REFUNDED" };
  const errorCode = error.error_code;
  if (typeof errorCode === "number" && Number.isInteger(errorCode) && errorCode >= 400 && errorCode < 500) {
    return { kind: "REJECTED", errorCode };
  }
  return { kind: "UNKNOWN" };
}

/** Telegram reports an expired invite hash when a bot retries revoking an already-revoked link. */
export function isTelegramInviteAlreadyRevoked(error: unknown): boolean {
  return isRecord(error) && typeof error.description === "string" &&
    error.description.includes("INVITE_HASH_EXPIRED");
}

export interface PaidSubscriptionPeriod {
  paidAt: Date | null;
  metadata: unknown;
}

export interface SubscriptionPeriodFallback {
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface RecalculatedSubscriptionPeriod {
  exact: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rebuild paid entitlement from immutable duration snapshots; legacy rows remain unchanged. */
export function recalculateSubscriptionPeriod(
  payments: readonly PaidSubscriptionPeriod[],
  fallback: SubscriptionPeriodFallback
): RecalculatedSubscriptionPeriod {
  if (payments.length === 0) return { exact: true, startsAt: null, endsAt: null };
  const ordered = [...payments].sort((left, right) => {
    if (!left.paidAt || !right.paidAt) return 0;
    return left.paidAt.getTime() - right.paidAt.getTime();
  });
  const periods = ordered.map((payment) => {
    if (!payment.paidAt || !Number.isFinite(payment.paidAt.getTime()) || !isRecord(payment.metadata) ||
        !Object.prototype.hasOwnProperty.call(payment.metadata, "durationDays")) return null;
    const durationDays = payment.metadata.durationDays;
    if (durationDays !== null &&
        (typeof durationDays !== "number" || !Number.isSafeInteger(durationDays) || durationDays <= 0)) return null;
    const expirationValue = payment.metadata.subscriptionExpirationDate;
    let providerExpiration: Date | null = null;
    if (expirationValue !== undefined) {
      if (typeof expirationValue !== "number" || !Number.isSafeInteger(expirationValue) || expirationValue <= 0) {
        return null;
      }
      providerExpiration = new Date(expirationValue * 1000);
      if (!Number.isFinite(providerExpiration.getTime())) return null;
    }
    return { paidAt: payment.paidAt, durationDays, providerExpiration };
  });
  if (periods.some((period) => period === null)) {
    return { exact: false, startsAt: fallback.startsAt, endsAt: fallback.endsAt };
  }
  const validPeriods = periods as Array<{
    paidAt: Date;
    durationDays: number | null;
    providerExpiration: Date | null;
  }>;
  const startsAt = validPeriods[0]?.paidAt ?? null;
  let periodEnd = startsAt;
  for (const period of validPeriods) {
    if (period.durationDays === null) return { exact: true, startsAt, endsAt: null };
    const anchor = periodEnd && periodEnd > period.paidAt ? periodEnd : period.paidAt;
    const durationEnd = new Date(anchor.getTime() + period.durationDays * DAY_MS);
    if (!Number.isFinite(durationEnd.getTime())) {
      return { exact: false, startsAt: fallback.startsAt, endsAt: fallback.endsAt };
    }
    // Telegram's absolute subscription expiration is more precise than deriving
    // a date from the local webhook receipt timestamp. Keep longer prior access.
    periodEnd = period.providerExpiration && period.providerExpiration > durationEnd
      ? period.providerExpiration
      : durationEnd;
  }
  return { exact: true, startsAt, endsAt: periodEnd };
}

export interface TelegramStarsRefundReceipt {
  invoice_payload: string;
  currency: string;
  total_amount: number;
  telegram_payment_charge_id: string;
}

export interface TelegramStarsRefundPaymentSnapshot {
  id: string;
  originalPaymentId?: string | null;
  provider: string;
  currency: string;
  amount: string;
  providerPaymentId: string | null;
  customerTelegramUserId: string;
  originProjectBotId: string | null;
}

/** Validate a refund service message against the original project payment before changing local state. */
export function matchesTelegramStarsRefundReceipt(
  payment: TelegramStarsRefundPaymentSnapshot,
  receipt: TelegramStarsRefundReceipt,
  buyerChatId: number,
  webhookProjectBotId: string
): boolean {
  const amount = Number(payment.amount);
  return payment.provider === "TELEGRAM_STARS" &&
    payment.currency === "XTR" &&
    (payment.id === receipt.invoice_payload || payment.originalPaymentId === receipt.invoice_payload) &&
    receipt.currency === "XTR" &&
    Number.isSafeInteger(receipt.total_amount) &&
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    receipt.total_amount === amount &&
    Boolean(payment.providerPaymentId) &&
    payment.providerPaymentId === receipt.telegram_payment_charge_id &&
    Number.isSafeInteger(buyerChatId) &&
    BigInt(buyerChatId) === BigInt(payment.customerTelegramUserId) &&
    (!payment.originProjectBotId || payment.originProjectBotId === webhookProjectBotId);
}
