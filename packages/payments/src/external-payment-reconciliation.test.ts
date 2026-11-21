import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileExternalPaymentEvent } from "./external-payment-reconciliation.js";
import type { NormalizedPaymentEvent } from "./index.js";

function event(overrides: Partial<NormalizedPaymentEvent> = {}): NormalizedPaymentEvent {
  return {
    providerEventId: "evt_123",
    eventType: "payment.succeeded",
    providerPaymentId: "pay_123",
    paymentReference: "local_payment_123",
    status: "SUCCEEDED",
    amount: "100.00",
    currency: "RUB",
    rawPayload: {},
    ...overrides
  };
}

const pendingPayment = {
  reference: "local_payment_123",
  amount: "100",
  currency: "RUB",
  status: "PENDING" as const
};

test("applies a verified matching external payment event using decimal-safe comparisons", () => {
  assert.deepEqual(
    reconcileExternalPaymentEvent({
      payment: pendingPayment,
      event: event({ amount: "00100.00", currency: "rub" })
    }),
    {
      kind: "APPLY",
      nextStatus: "SUCCEEDED",
      providerPaymentId: "pay_123"
    }
  );
});

test("rejects external events that do not match the original payment reference", () => {
  const decision = reconcileExternalPaymentEvent({
    payment: pendingPayment,
    event: event({ paymentReference: "another_payment" })
  });
  assert.deepEqual(decision, { kind: "REJECT", reason: "PAYMENT_REFERENCE_MISMATCH" });
});

test("rejects amount, currency and provider payment ID mismatches", () => {
  assert.deepEqual(
    reconcileExternalPaymentEvent({ payment: pendingPayment, event: event({ amount: "99.99" }) }),
    { kind: "REJECT", reason: "AMOUNT_MISMATCH" }
  );
  assert.deepEqual(
    reconcileExternalPaymentEvent({ payment: pendingPayment, event: event({ currency: "XTR" }) }),
    { kind: "REJECT", reason: "CURRENCY_MISMATCH" }
  );
  assert.deepEqual(
    reconcileExternalPaymentEvent({
      payment: { ...pendingPayment, providerPaymentId: "pay_other" },
      event: event()
    }),
    { kind: "REJECT", reason: "PROVIDER_PAYMENT_ID_MISMATCH" }
  );
});

test("does not downgrade a terminal or already settled payment on an out-of-order event", () => {
  assert.deepEqual(
    reconcileExternalPaymentEvent({
      payment: { ...pendingPayment, status: "SUCCEEDED" },
      event: event({ status: "FAILED" })
    }),
    { kind: "MANUAL_REVIEW", reason: "OUT_OF_ORDER_STATUS" }
  );
  assert.deepEqual(
    reconcileExternalPaymentEvent({
      payment: { ...pendingPayment, status: "FAILED" },
      event: event()
    }),
    { kind: "MANUAL_REVIEW", reason: "LATE_SUCCESS_AFTER_TERMINAL_STATE" }
  );
});

test("recognizes duplicate events and allows a verified refund transition", () => {
  assert.deepEqual(
    reconcileExternalPaymentEvent({
      payment: { ...pendingPayment, status: "SUCCEEDED", providerPaymentId: "pay_123" },
      event: event()
    }),
    { kind: "DUPLICATE" }
  );
  assert.deepEqual(
    reconcileExternalPaymentEvent({
      payment: { ...pendingPayment, status: "SUCCEEDED", providerPaymentId: "pay_123" },
      event: event({ providerEventId: "evt_refund", eventType: "refund.succeeded", status: "REFUNDED" })
    }),
    { kind: "APPLY", nextStatus: "REFUNDED", providerPaymentId: "pay_123" }
  );
});
