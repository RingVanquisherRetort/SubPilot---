import assert from "node:assert/strict";
import { test } from "node:test";
import { hasInvoiceDispatchStarted } from "./telegram-invoice-state.js";

test("a dispatch-start marker suppresses a duplicate invoice even before message ID is stored", () => {
  assert.equal(hasInvoiceDispatchStarted({ invoiceDispatchStartedAt: "2026-11-21T00:00:00.000Z" }), true);
});

test("a recorded Telegram invoice message suppresses another invoice", () => {
  assert.equal(hasInvoiceDispatchStarted({ invoiceMessageId: 123 }), true);
});

test("no marker or malformed metadata does not suppress the first invoice", () => {
  assert.equal(hasInvoiceDispatchStarted({ planId: "plan-a" }), false);
  assert.equal(hasInvoiceDispatchStarted(null), false);
  assert.equal(hasInvoiceDispatchStarted(["invalid"]), false);
  assert.equal(hasInvoiceDispatchStarted({ invoiceMessageId: "123" }), false);
});
