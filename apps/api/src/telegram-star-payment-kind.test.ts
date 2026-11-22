import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTelegramStarsPayment } from "./telegram-star-payment-kind.js";

test("classifies a first recurring payment only when Telegram marks it as first", () => {
  assert.equal(classifyTelegramStarsPayment({
    planIsRecurring: true,
    paymentStatus: "PENDING",
    initialChargeId: null,
    isRecurring: true,
    isFirstRecurring: true
  }), "INITIAL_RECURRING");

  assert.equal(classifyTelegramStarsPayment({
    planIsRecurring: true,
    paymentStatus: "PENDING",
    initialChargeId: null,
    isRecurring: true,
    isFirstRecurring: false
  }), null);
});

test("classifies later recurring charges against the persisted first charge", () => {
  assert.equal(classifyTelegramStarsPayment({
    planIsRecurring: true,
    paymentStatus: "SUCCEEDED",
    initialChargeId: "initial-charge",
    isRecurring: true,
    isFirstRecurring: false
  }), null);

  assert.equal(classifyTelegramStarsPayment({
    planIsRecurring: true,
    paymentStatus: "SUCCEEDED",
    initialChargeId: "initial-charge",
    isRecurring: true,
    isFirstRecurring: undefined
  }), "RECURRING_RENEWAL");

  assert.equal(classifyTelegramStarsPayment({
    planIsRecurring: true,
    paymentStatus: "SUCCEEDED",
    initialChargeId: "initial-charge",
    isRecurring: true,
    isFirstRecurring: true
  }), null);
});

test("rejects contradictory, incomplete and non-recurring receipt flags", () => {
  assert.equal(classifyTelegramStarsPayment({
    planIsRecurring: true,
    paymentStatus: "PENDING",
    initialChargeId: null,
    isRecurring: undefined,
    isFirstRecurring: undefined
  }), null);

  assert.equal(classifyTelegramStarsPayment({
    planIsRecurring: false,
    paymentStatus: "PENDING",
    initialChargeId: null,
    isRecurring: true,
    isFirstRecurring: true
  }), null);

  assert.equal(classifyTelegramStarsPayment({
    planIsRecurring: false,
    paymentStatus: "PENDING",
    initialChargeId: null,
    isRecurring: false,
    isFirstRecurring: false
  }), "ONE_TIME");

  assert.equal(classifyTelegramStarsPayment({
    planIsRecurring: true,
    paymentStatus: "SUCCEEDED",
    initialChargeId: null,
    isRecurring: true,
    isFirstRecurring: false
  }), null);
});
