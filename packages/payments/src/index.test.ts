import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PaymentProviderRegistry,
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
