import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTelegramStarsPayment, isStarsAccessSuppressedByAdminRevocation } from "./telegram-star-payment-kind.js";

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

  for (const paymentStatus of ["SUCCEEDED", "REFUNDING", "REFUNDED"]) {
    assert.equal(classifyTelegramStarsPayment({
      planIsRecurring: true,
      paymentStatus,
      initialChargeId: "initial-charge",
      isRecurring: true,
      isFirstRecurring: undefined
    }), "RECURRING_RENEWAL");
  }

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

test("Stars receipt never reauthorizes access after an admin revoke or pending cancel", () => {
  const cases = [
    { adminAccessRevokedAt: null, adminStarsCancelPending: false, suppressed: false },
    { adminAccessRevokedAt: new Date("2026-11-23T00:00:00Z"), adminStarsCancelPending: false, suppressed: true },
    { adminAccessRevokedAt: null, adminStarsCancelPending: true, suppressed: true },
    { adminAccessRevokedAt: new Date("2026-11-23T00:00:00Z"), adminStarsCancelPending: true, suppressed: true }
  ];
  for (const { suppressed, ...state } of cases) {
    assert.equal(isStarsAccessSuppressedByAdminRevocation(state), suppressed);
  }
});

test("duplicate renewal receipt classification remains valid for accounting but cannot override a committed admin revoke", () => {
  for (const paymentStatus of ["SUCCEEDED", "REFUNDING", "REFUNDED"]) {
    const kind = classifyTelegramStarsPayment({
      planIsRecurring: true,
      paymentStatus,
      initialChargeId: "original-charge",
      isRecurring: true,
      isFirstRecurring: undefined
    });
    assert.equal(kind, "RECURRING_RENEWAL");
    for (const state of [
      { adminAccessRevokedAt: new Date("2026-11-23T00:00:00Z"), adminStarsCancelPending: false },
      { adminAccessRevokedAt: null, adminStarsCancelPending: true }
    ]) {
      assert.equal(isStarsAccessSuppressedByAdminRevocation(state), true);
    }
  }
});
