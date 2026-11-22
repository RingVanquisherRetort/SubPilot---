import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTelegramStarSubscriptionUpdate } from "./telegram-star-subscription-update.js";

test("parses active, canceled and failed Telegram Stars subscription updates", () => {
  for (const [rawState, state] of [
    ["active", "ACTIVE"],
    ["canceled", "CANCELED"],
    ["failed", "FAILED"]
  ] as const) {
    assert.deepEqual(
      parseTelegramStarSubscriptionUpdate({
        update_id: 42,
        subscription: {
          user: { id: 123456789 },
          invoice_payload: "payment_cuid",
          state: rawState
        }
      }),
      {
        telegramUserId: 123456789,
        invoicePayload: "payment_cuid",
        state
      }
    );
  }
});

test("ignores unrelated updates and malformed subscription events", () => {
  assert.equal(parseTelegramStarSubscriptionUpdate({ update_id: 1, message: {} }), null);
  assert.equal(parseTelegramStarSubscriptionUpdate({ subscription: {} }), null);
  assert.equal(parseTelegramStarSubscriptionUpdate({
    subscription: { user: { id: 0 }, invoice_payload: "payment", state: "active" }
  }), null);
  assert.equal(parseTelegramStarSubscriptionUpdate({
    subscription: { user: { id: Number.MAX_SAFE_INTEGER + 1 }, invoice_payload: "payment", state: "active" }
  }), null);
  assert.equal(parseTelegramStarSubscriptionUpdate({
    subscription: { user: { id: 123 }, invoice_payload: "", state: "active" }
  }), null);
  assert.equal(parseTelegramStarSubscriptionUpdate({
    subscription: { user: { id: 123 }, invoice_payload: "payment", state: "unknown" }
  }), null);
});
