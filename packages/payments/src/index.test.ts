import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PaymentProviderRegistry,
  classifyTelegramRefundError,
  isTelegramInviteAlreadyRevoked,
  recalculateSubscriptionPeriod,
  matchesTelegramStarsRefundReceipt,
  calculateIntroductoryCommission,
  getPaymentProviderAvailability,
  listPaymentProviderAvailability,
  evaluatePaymentEligibility,
  normalizeDecimalAmount,
  type PaymentProviderAdapter
} from "./index.js";

const mockStarsAdapter: PaymentProviderAdapter = {
  provider: "TELEGRAM_STARS",
  async createCheckout() {
    return { invoicePayload: "payment_123" };
  },
  async verifyWebhook() {
    return true;
  },
  async parseWebhook() {
    return [];
  }
};

test("normalizes decimal amounts without floating-point conversion", () => {
  assert.equal(normalizeDecimalAmount("00012.50"), "12.5");
  assert.equal(normalizeDecimalAmount("0007.00"), "7");
  assert.equal(normalizeDecimalAmount("0.10"), "0.1");
  assert.equal(normalizeDecimalAmount("42"), "42");
});

test("rejects malformed payment amounts", () => {
  for (const value of ["", "-1", "+1", "1.001", "1e3", "1,20", "1.2.3"]) {
    assert.throws(() => normalizeDecimalAmount(value), /Invalid payment amount/);
  }
});

test("registers and retrieves a provider adapter", () => {
  const registry = new PaymentProviderRegistry();
  registry.register(mockStarsAdapter);

  assert.equal(registry.has("TELEGRAM_STARS"), true);
  assert.equal(registry.get("TELEGRAM_STARS"), mockStarsAdapter);
  assert.deepEqual(registry.list(), ["TELEGRAM_STARS"]);
});

test("rejects duplicate adapters and missing providers", () => {
  const registry = new PaymentProviderRegistry();
  registry.register(mockStarsAdapter);

  assert.throws(
    () => registry.register(mockStarsAdapter),
    /already registered/
  );
  assert.throws(
    () => registry.get("YOOKASSA"),
    /not configured/
  );
});


test("Telegram channel access only accepts Stars in the Telegram bot or Mini App", () => {
  const stars = evaluatePaymentEligibility({
    provider: "TELEGRAM_STARS",
    productType: "TELEGRAM_CHANNEL_ACCESS",
    surface: "TELEGRAM_BOT",
    telegramTpaRelated: true
  });
  const card = evaluatePaymentEligibility({
    provider: "YOOKASSA",
    productType: "TELEGRAM_CHANNEL_ACCESS",
    surface: "TELEGRAM_BOT",
    telegramTpaRelated: true
  });
  const external = evaluatePaymentEligibility({
    provider: "YOOKASSA",
    productType: "TELEGRAM_CHANNEL_ACCESS",
    surface: "INDEPENDENT_WEB",
    telegramTpaRelated: true
  });

  assert.equal(stars.allowed, true);
  assert.equal(card.allowed, false);
  assert.equal(card.requiredProvider, "TELEGRAM_STARS");
  assert.equal(external.allowed, false);
  assert.equal(external.code, "MOVE_CHECKOUT_TO_TELEGRAM");
});

test("digital goods tied to a Telegram bot cannot use an external PSP", () => {
  const decision = evaluatePaymentEligibility({
    provider: "PRODAMUS",
    productType: "DIGITAL_GOODS_OR_SERVICES",
    surface: "INDEPENDENT_WEB",
    telegramTpaRelated: true
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.requiredProvider, "TELEGRAM_STARS");
});

test("an unrelated independent website sale is evaluated separately", () => {
  const decision = evaluatePaymentEligibility({
    provider: "YOOKASSA",
    productType: "DIGITAL_GOODS_OR_SERVICES",
    surface: "INDEPENDENT_WEB",
    telegramTpaRelated: false
  });

  assert.equal(decision.allowed, true);
});

test("manual confirmation is blocked inside Telegram even for physical goods", () => {
  const decision = evaluatePaymentEligibility({
    provider: "MANUAL",
    productType: "PHYSICAL_GOODS_OR_SERVICES",
    surface: "TELEGRAM_BOT",
    telegramTpaRelated: false
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "MANUAL_CONFIRMATION_REQUIRES_INDEPENDENT_WEB");
});

test("manual confirmation is blocked for Telegram Mini App related products", () => {
  const decision = evaluatePaymentEligibility({
    provider: "MANUAL",
    productType: "DIGITAL_GOODS_OR_SERVICES",
    surface: "TELEGRAM_MINI_APP",
    telegramTpaRelated: true
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "MANUAL_CONFIRMATION_REQUIRES_INDEPENDENT_WEB");
});

test("manual confirmation passes only the policy gate for independent web sales", () => {
  for (const productType of ["DIGITAL_GOODS_OR_SERVICES", "PHYSICAL_GOODS_OR_SERVICES"] as const) {
    const decision = evaluatePaymentEligibility({
      provider: "MANUAL",
      productType,
      surface: "INDEPENDENT_WEB",
      telegramTpaRelated: false
    });

    assert.equal(decision.allowed, true);
    assert.equal(decision.code, "ALLOWED");
  }
});

test("Stars are not accepted for physical goods or services", () => {
  const decision = evaluatePaymentEligibility({
    provider: "TELEGRAM_STARS",
    productType: "PHYSICAL_GOODS_OR_SERVICES",
    surface: "TELEGRAM_BOT",
    telegramTpaRelated: false
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "STARS_NOT_VALID_FOR_PHYSICAL_GOODS");
});


test("introductory commission is 14% only during the selected seven-day period", () => {
  const trialStartedAt = new Date("2026-11-21T00:00:00.000Z");
  const trialEndsAt = new Date("2026-11-28T00:00:00.000Z");
  const result = calculateIntroductoryCommission({
    grossAmount: "20000.00",
    currency: "RUB",
    paidAt: new Date("2026-11-24T12:00:00.000Z"),
    trialStartedAt,
    trialEndsAt
  });

  assert.equal(result.eligible, true);
  assert.equal(result.commissionRate, "14");
  assert.equal(result.commissionAmount, "2800");
  assert.equal(result.netAmount, "20000");
});

test("introductory commission excludes sales at or after the trial end", () => {
  const result = calculateIntroductoryCommission({
    grossAmount: "1000",
    currency: "RUB",
    paidAt: new Date("2026-11-28T00:00:00.000Z"),
    trialStartedAt: new Date("2026-11-21T00:00:00.000Z"),
    trialEndsAt: new Date("2026-11-28T00:00:00.000Z")
  });

  assert.equal(result.eligible, false);
  assert.equal(result.commissionAmount, "0");
  assert.equal(result.reason, "OUTSIDE_INTRODUCTORY_PERIOD");
});

test("refunds reduce the commission base and preserve the sale currency", () => {
  const result = calculateIntroductoryCommission({
    grossAmount: "1000",
    refundedAmount: "250",
    currency: "xtr",
    paidAt: new Date("2026-11-22T00:00:00.000Z"),
    trialStartedAt: new Date("2026-11-21T00:00:00.000Z"),
    trialEndsAt: new Date("2026-11-28T00:00:00.000Z")
  });

  assert.equal(result.currency, "XTR");
  assert.equal(result.netAmount, "750");
  assert.equal(result.commissionAmount, "105");
});

test("commission calculator uses decimal-safe rounding and validates refunds", () => {
  const base = {
    currency: "XTR",
    paidAt: new Date("2026-11-22T00:00:00.000Z"),
    trialStartedAt: new Date("2026-11-21T00:00:00.000Z"),
    trialEndsAt: new Date("2026-11-28T00:00:00.000Z")
  };
  const fractional = calculateIntroductoryCommission({
    ...base,
    grossAmount: "1"
  });

  assert.equal(fractional.commissionAmount, "0.14");
  assert.throws(
    () => calculateIntroductoryCommission({
      ...base,
      grossAmount: "10",
      refundedAmount: "11"
    }),
    /cannot exceed/
  );
});


test("Russian individual creator can select Stars for Telegram channel access", () => {
  const options = listPaymentProviderAvailability({
    countryCode: "RU",
    merchantType: "INDIVIDUAL",
    productType: "TELEGRAM_CHANNEL_ACCESS",
    surface: "TELEGRAM_BOT",
    telegramTpaRelated: true
  });

  const available = options.filter((option) => option.available);
  assert.deepEqual(available.map((option) => option.provider), ["TELEGRAM_STARS"]);

  const cryptoPay = options.find((option) => option.provider === "CRYPTO_PAY");
  assert.equal(cryptoPay?.available, false);
  assert.equal(cryptoPay?.reason, "PRODUCT_POLICY_BLOCKED");
});

test("YooMoney and Crypto Pay are research candidates for an individual, not enabled adapters", () => {
  const common = {
    countryCode: "RU",
    merchantType: "INDIVIDUAL" as const,
    productType: "DIGITAL_GOODS_OR_SERVICES" as const,
    surface: "INDEPENDENT_WEB" as const,
    telegramTpaRelated: false
  };

  const yooMoney = getPaymentProviderAvailability({ ...common, provider: "YOOMONEY" });
  const cryptoPay = getPaymentProviderAvailability({ ...common, provider: "CRYPTO_PAY" });

  assert.equal(yooMoney.available, false);
  assert.equal(yooMoney.reason, "INTEGRATION_NOT_READY");
  assert.equal(cryptoPay.available, false);
  assert.equal(cryptoPay.reason, "INTEGRATION_NOT_READY");
});

test("individual creators are not shown merchant-only providers as eligible", () => {
  const result = getPaymentProviderAvailability({
    provider: "YOOKASSA",
    countryCode: "RU",
    merchantType: "INDIVIDUAL",
    productType: "PHYSICAL_GOODS_OR_SERVICES",
    surface: "INDEPENDENT_WEB",
    telegramTpaRelated: false
  });

  assert.equal(result.available, false);
  assert.equal(result.reason, "MERCHANT_TYPE_NOT_SUPPORTED_BY_REFERENCE");
});

test("self-employed status allows research candidates but does not bypass rollout checks", () => {
  const result = getPaymentProviderAvailability({
    provider: "YOOKASSA",
    countryCode: "RU",
    merchantType: "SELF_EMPLOYED",
    productType: "PHYSICAL_GOODS_OR_SERVICES",
    surface: "INDEPENDENT_WEB",
    telegramTpaRelated: false
  });

  assert.equal(result.available, false);
  assert.equal(result.reason, "INTEGRATION_NOT_READY");
});

test("provider catalog does not override Telegram Stars policy for digital access", () => {
  const result = getPaymentProviderAvailability({
    provider: "YOOMONEY",
    countryCode: "RU",
    merchantType: "INDIVIDUAL",
    productType: "TELEGRAM_CHANNEL_ACCESS",
    surface: "INDEPENDENT_WEB",
    telegramTpaRelated: true
  });

  assert.equal(result.available, false);
  assert.equal(result.reason, "PRODUCT_POLICY_BLOCKED");
});


test("introductory commission accepts fractional amounts and formats fractional rates", () => {
  const result = calculateIntroductoryCommission({
    grossAmount: "00012.50",
    refundedAmount: "2.25",
    currency: "rub",
    paidAt: new Date("2026-11-22T00:00:00.000Z"),
    trialStartedAt: new Date("2026-11-21T00:00:00.000Z"),
    trialEndsAt: new Date("2026-11-28T00:00:00.000Z"),
    commissionBasisPoints: 1_425
  });

  assert.equal(result.currency, "RUB");
  assert.equal(result.commissionRate, "14.25");
  assert.equal(result.grossAmount, "12.50");
  assert.equal(result.refundedAmount, "2.25");
  assert.equal(result.netAmount, "10.25");
  assert.equal(result.commissionAmount, "1.46");
});

test("introductory commission rejects malformed decimal amounts", () => {
  const base = {
    currency: "RUB",
    paidAt: new Date("2026-11-22T00:00:00.000Z"),
    trialStartedAt: new Date("2026-11-21T00:00:00.000Z"),
    trialEndsAt: new Date("2026-11-28T00:00:00.000Z")
  };

  for (const grossAmount of ["", "-1", "1.001", "1e3", "1,25"]) {
    assert.throws(
      () => calculateIntroductoryCommission({ ...base, grossAmount }),
      /Invalid commission amount/
    );
  }
});

test("Telegram refund errors distinguish already-refunded, rejected and unknown outcomes", () => {
  assert.deepEqual(classifyTelegramRefundError({ error_code: 400, description: "Bad Request: CHARGE_ALREADY_REFUNDED" }), { kind: "ALREADY_REFUNDED" });
  assert.deepEqual(classifyTelegramRefundError({ error_code: 400, description: "Bad Request: USER_ID_INVALID" }), { kind: "REJECTED", errorCode: 400 });
  assert.deepEqual(classifyTelegramRefundError({ error_code: 500, description: "Internal Server Error" }), { kind: "UNKNOWN" });
  assert.deepEqual(classifyTelegramRefundError(new Error("network timeout")), { kind: "UNKNOWN" });
});

test("Telegram invite cleanup recognizes only the already-expired invite hash response", () => {
  assert.equal(isTelegramInviteAlreadyRevoked({ error_code: 400, description: "Bad Request: INVITE_HASH_EXPIRED" }), true);
  assert.equal(isTelegramInviteAlreadyRevoked({ error_code: 400, description: "Bad Request: INVITE_HASH_INVALID" }), false);
});

test("subscription refund recalculation rebuilds remaining paid periods in paid order", () => {
  const firstPaidAt = new Date("2026-11-01T00:00:00.000Z");
  const secondPaidAt = new Date("2026-11-10T00:00:00.000Z");
  const result = recalculateSubscriptionPeriod([
    { paidAt: secondPaidAt, metadata: { durationDays: 30 } },
    { paidAt: firstPaidAt, metadata: { durationDays: 30 } }
  ], { startsAt: firstPaidAt, endsAt: new Date("2026-12-31T00:00:00.000Z") });
  assert.equal(result.exact, true);
  assert.equal(result.startsAt?.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(result.endsAt?.toISOString(), "2026-12-31T00:00:00.000Z");
});

test("subscription refund recalculation preserves legacy dates without duration snapshots", () => {
  const fallback = { startsAt: new Date("2026-11-01T00:00:00.000Z"), endsAt: new Date("2026-12-01T00:00:00.000Z") };
  const result = recalculateSubscriptionPeriod([{ paidAt: fallback.startsAt, metadata: { legacy: true } }], fallback);
  assert.equal(result.exact, false);
  assert.equal(result.startsAt, fallback.startsAt);
  assert.equal(result.endsAt, fallback.endsAt);
});

test("an indefinite remaining payment keeps the recalculated subscription open-ended", () => {
  const result = recalculateSubscriptionPeriod([{ paidAt: new Date("2026-11-01T00:00:00.000Z"), metadata: { durationDays: null } }], { startsAt: null, endsAt: new Date("2026-12-01T00:00:00.000Z") });
  assert.equal(result.exact, true);
  assert.equal(result.endsAt, null);
});

test("refunded_payment service updates must match the original buyer, bot, invoice, charge, amount and currency", () => {
  const payment = {
    id: "payment_123",
    provider: "TELEGRAM_STARS",
    currency: "XTR",
    amount: "499.00",
    providerPaymentId: "charge_123",
    customerTelegramUserId: "123456789",
    originProjectBotId: "project_bot_1"
  };
  const receipt = {
    invoice_payload: "payment_123",
    currency: "XTR",
    total_amount: 499,
    telegram_payment_charge_id: "charge_123"
  };

  assert.equal(matchesTelegramStarsRefundReceipt(payment, receipt, 123456789, "project_bot_1"), true);
  assert.equal(matchesTelegramStarsRefundReceipt(payment, { ...receipt, total_amount: 500 }, 123456789, "project_bot_1"), false);
  assert.equal(matchesTelegramStarsRefundReceipt(payment, receipt, 123456780, "project_bot_1"), false);
  assert.equal(matchesTelegramStarsRefundReceipt(payment, receipt, 123456789, "different_bot"), false);
  assert.equal(matchesTelegramStarsRefundReceipt(payment, { ...receipt, telegram_payment_charge_id: "other_charge" }, 123456789, "project_bot_1"), false);
});
