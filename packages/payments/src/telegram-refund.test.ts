import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchesTelegramStarsRefundReceipt,
  recalculateSubscriptionPeriod
} from "./telegram-refund.js";

const basePayment = {
  id: "initial-payment",
  originalPaymentId: null,
  provider: "TELEGRAM_STARS",
  currency: "XTR",
  amount: "250",
  providerPaymentId: "initial-charge",
  customerTelegramUserId: "123456789",
  originProjectBotId: "project-bot"
};

const baseReceipt = {
  invoice_payload: "initial-payment",
  currency: "XTR",
  total_amount: 250,
  telegram_payment_charge_id: "initial-charge"
};

test("matches an initial Stars refund against its invoice anchor and first charge", () => {
  assert.equal(matchesTelegramStarsRefundReceipt(
    basePayment,
    baseReceipt,
    123456789,
    "project-bot"
  ), true);
});

test("matches a recurring renewal refund against the original invoice payload and renewal charge", () => {
  assert.equal(matchesTelegramStarsRefundReceipt(
    {
      ...basePayment,
      id: "renewal-payment",
      originalPaymentId: "initial-payment",
      providerPaymentId: "renewal-charge"
    },
    {
      ...baseReceipt,
      telegram_payment_charge_id: "renewal-charge"
    },
    123456789,
    "project-bot"
  ), true);
});

test("rejects refund receipts with a different buyer, bot, charge or amount", () => {
  for (const [payment, receipt, buyer, botId] of [
    [basePayment, baseReceipt, 123456788, "project-bot"],
    [basePayment, baseReceipt, 123456789, "other-bot"],
    [basePayment, { ...baseReceipt, telegram_payment_charge_id: "other-charge" }, 123456789, "project-bot"],
    [basePayment, { ...baseReceipt, total_amount: 251 }, 123456789, "project-bot"]
  ] as const) {
    assert.equal(matchesTelegramStarsRefundReceipt(payment, receipt, buyer, botId), false);
  }
});

test("recalculates a paid recurring chain from each immutable payment snapshot", () => {
  const first = new Date("2026-01-01T00:00:00.000Z");
  const renewal = new Date("2026-01-31T00:00:00.000Z");
  const result = recalculateSubscriptionPeriod([
    { paidAt: first, metadata: { durationDays: 30 } },
    { paidAt: renewal, metadata: { durationDays: 30, isRenewal: true } }
  ], { startsAt: null, endsAt: null });

  assert.equal(result.exact, true);
  assert.equal(result.startsAt?.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(result.endsAt?.toISOString(), "2026-03-02T00:00:00.000Z");
});
