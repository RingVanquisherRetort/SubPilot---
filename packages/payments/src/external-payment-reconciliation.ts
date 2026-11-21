import type { NormalizedPaymentEvent } from "./index.js";

export type TrackedExternalPaymentStatus =
  | "CREATED"
  | "PENDING"
  | "SUCCEEDED"
  | "REFUNDING"
  | "FAILED"
  | "CANCELLED"
  | "REFUNDED";

export type ExternalPaymentEventDecision =
  | {
      kind: "APPLY";
      nextStatus: NormalizedPaymentEvent["status"];
      providerPaymentId: string;
    }
  | { kind: "DUPLICATE" }
  | {
      kind: "REJECT";
      reason:
        | "EVENT_ID_MISSING"
        | "PROVIDER_PAYMENT_ID_MISSING"
        | "PAYMENT_REFERENCE_MISMATCH"
        | "AMOUNT_MISMATCH"
        | "CURRENCY_MISMATCH"
        | "PROVIDER_PAYMENT_ID_MISMATCH";
    }
  | {
      kind: "MANUAL_REVIEW";
      reason: "LATE_SUCCESS_AFTER_TERMINAL_STATE" | "OUT_OF_ORDER_STATUS";
    };

function normalizeAmount(value: string): string | null {
  const normalized = value.trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
}

/**
 * Performs the deterministic checks that must precede any external-payment
 * mutation. A successful browser redirect is not an event and is not accepted
 * here. Provider authentication and event deduplication happen before this
 * function; this function checks whether a verified event matches its order.
 */
export function reconcileExternalPaymentEvent(input: {
  payment: {
    reference: string;
    amount: string;
    currency: string;
    status: TrackedExternalPaymentStatus;
    providerPaymentId?: string | null;
  };
  event: NormalizedPaymentEvent;
}): ExternalPaymentEventDecision {
  const { payment, event } = input;

  if (typeof event.providerEventId !== "string" || !event.providerEventId.trim()) {
    return { kind: "REJECT", reason: "EVENT_ID_MISSING" };
  }
  if (typeof event.providerPaymentId !== "string" || !event.providerPaymentId.trim()) {
    return { kind: "REJECT", reason: "PROVIDER_PAYMENT_ID_MISSING" };
  }
  if (typeof event.paymentReference !== "string" ||
      !event.paymentReference ||
      event.paymentReference !== payment.reference) {
    return { kind: "REJECT", reason: "PAYMENT_REFERENCE_MISMATCH" };
  }

  const expectedAmount = typeof payment.amount === "string" ? normalizeAmount(payment.amount) : null;
  const receivedAmount = typeof event.amount === "string" ? normalizeAmount(event.amount) : null;
  if (expectedAmount === null || receivedAmount === null || expectedAmount !== receivedAmount) {
    return { kind: "REJECT", reason: "AMOUNT_MISMATCH" };
  }

  const expectedCurrency = typeof payment.currency === "string" ? payment.currency.trim().toUpperCase() : "";
  const receivedCurrency = typeof event.currency === "string" ? event.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(expectedCurrency) ||
      !/^[A-Z]{3}$/.test(receivedCurrency) ||
      expectedCurrency !== receivedCurrency) {
    return { kind: "REJECT", reason: "CURRENCY_MISMATCH" };
  }

  if (payment.providerPaymentId &&
      payment.providerPaymentId !== event.providerPaymentId) {
    return { kind: "REJECT", reason: "PROVIDER_PAYMENT_ID_MISMATCH" };
  }

  if (payment.status === event.status) return { kind: "DUPLICATE" };

  if (payment.status === "CREATED" || payment.status === "PENDING") {
    return {
      kind: "APPLY",
      nextStatus: event.status,
      providerPaymentId: event.providerPaymentId
    };
  }

  if ((payment.status === "SUCCEEDED" || payment.status === "REFUNDING") &&
      event.status === "REFUNDED") {
    return {
      kind: "APPLY",
      nextStatus: "REFUNDED",
      providerPaymentId: event.providerPaymentId
    };
  }

  if ((payment.status === "FAILED" || payment.status === "CANCELLED" ||
       payment.status === "REFUNDED") && event.status === "SUCCEEDED") {
    return { kind: "MANUAL_REVIEW", reason: "LATE_SUCCESS_AFTER_TERMINAL_STATE" };
  }

  return { kind: "MANUAL_REVIEW", reason: "OUT_OF_ORDER_STATUS" };
}
