import assert from "node:assert/strict";
import { test } from "node:test";
import { getInvoiceDispatchState, hasInvoiceDispatchStarted } from "./telegram-invoice-state.js";

test("a dispatch-start marker is treated as ambiguous until Telegram message ID is stored", () => {
  const metadata = { invoiceDispatchStartedAt: "2026-11-21T00:00:00.000Z" };
  assert.equal(getInvoiceDispatchState(metadata), "AMBIGUOUS");
  assert.equal(hasInvoiceDispatchStarted(metadata), true);
});

test("a recorded Telegram invoice message is treated as sent", () => {
  const metadata = { invoiceMessageId: 123 };
  assert.equal(getInvoiceDispatchState(metadata), "SENT");
  assert.equal(hasInvoiceDispatchStarted(metadata), true);
});

test("metadata without a valid dispatch marker allows the first invoice", () => {
  assert.equal(getInvoiceDispatchState({ planId: "plan-a" }), "NOT_STARTED");
  assert.equal(getInvoiceDispatchState(null), "NOT_STARTED");
  assert.equal(getInvoiceDispatchState(["invalid"]), "NOT_STARTED");
  assert.equal(getInvoiceDispatchState({ invoiceMessageId: "123" }), "NOT_STARTED");
});
