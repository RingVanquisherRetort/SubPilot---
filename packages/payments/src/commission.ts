export const START_WITHOUT_UPFRONT_COST = {
  code: "START_WITHOUT_UPFRONT_COST",
  durationDays: 7,
  commissionBasisPoints: 1_400
} as const;

export interface IntroductoryCommissionInput {
  grossAmount: string;
  refundedAmount?: string;
  currency: string;
  paidAt: Date;
  trialStartedAt: Date;
  trialEndsAt: Date;
  commissionBasisPoints?: number;
}

export interface IntroductoryCommission {
  eligible: boolean;
  currency: string;
  commissionBasisPoints: number;
  commissionRate: string;
  grossAmount: string;
  refundedAmount: string;
  netAmount: string;
  commissionAmount: string;
  reason?: "OUTSIDE_INTRODUCTORY_PERIOD" | "NO_NET_SALE";
}

function toMinorUnits(value: string): bigint {
  if (!/^\\d{1,12}(?:\\.\\d{1,2})?$/.test(value)) {
    throw new Error("Invalid commission amount.");
  }

  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function fromMinorUnits(value: bigint): string {
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, "0");
  return fraction === "00" ? whole.toString() : `${whole}.${fraction}`;
}

function formatRate(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2).replace(/\\.?0+$/, "");
}

/**
 * Calculates a temporary platform fee on a creator sale.
 * The fee remains denominated in the original sale currency; currency
 * conversion and collection are deliberately handled by platform billing.
 */
export function calculateIntroductoryCommission(
  input: IntroductoryCommissionInput
): IntroductoryCommission {
  const gross = toMinorUnits(input.grossAmount);
  const refunded = toMinorUnits(input.refundedAmount ?? "0");
  const rate = input.commissionBasisPoints ?? START_WITHOUT_UPFRONT_COST.commissionBasisPoints;

  if (!input.currency.trim()) {
    throw new Error("Commission currency is required.");
  }
  if (refunded > gross) {
    throw new Error("Refunded amount cannot exceed the gross sale amount.");
  }
  if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) {
    throw new Error("Commission rate must be an integer from 0 to 10000 basis points.");
  }

  const validDates =
    Number.isFinite(input.paidAt.getTime()) &&
    Number.isFinite(input.trialStartedAt.getTime()) &&
    Number.isFinite(input.trialEndsAt.getTime());

  if (!validDates || input.trialEndsAt <= input.trialStartedAt) {
    throw new Error("Invalid introductory commission period.");
  }

  const net = gross - refunded;
  const eligible =
    input.paidAt >= input.trialStartedAt &&
    input.paidAt < input.trialEndsAt;

  // Round half up to the currency's two-decimal ledger precision.
  const commission = eligible && net > 0n
    ? (net * BigInt(rate) + 5_000n) / 10_000n
    : 0n;

  return {
    eligible: eligible && net > 0n,
    currency: input.currency.trim().toUpperCase(),
    commissionBasisPoints: rate,
    commissionRate: formatRate(rate),
    grossAmount: fromMinorUnits(gross),
    refundedAmount: fromMinorUnits(refunded),
    netAmount: fromMinorUnits(net),
    commissionAmount: fromMinorUnits(commission),
    ...(!eligible
      ? { reason: "OUTSIDE_INTRODUCTORY_PERIOD" as const }
      : net === 0n
        ? { reason: "NO_NET_SALE" as const }
        : {})
  };
}
