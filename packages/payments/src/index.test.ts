import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PaymentProviderRegistry,
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
