import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getAccessDeliveryFailureState,
  MAX_ACCESS_DELIVERY_ATTEMPTS
} from "./access-delivery-retry.js";

test("access-delivery retries use bounded exponential backoff", () => {
  const now = new Date("2026-11-21T20:00:00.000Z");
  const waits = [1, 2, 4, 8, 16, 32, 60, 60, 60, 60];
  for (let prior = 0; prior < waits.length; prior++) {
    const state = getAccessDeliveryFailureState(prior, now, "TELEGRAM_FORBIDDEN");
    assert.equal(state.attempts, prior + 1);
    assert.equal(state.nextAttemptAt.getTime() - now.getTime(), (waits[prior] ?? 0) * 60_000);
    assert.equal(state.failedAt !== null, prior + 1 >= MAX_ACCESS_DELIVERY_ATTEMPTS);
    assert.equal(state.lastError, "TELEGRAM_FORBIDDEN");
  }
});

test("access-delivery error values are normalized before persistence", () => {
  const state = getAccessDeliveryFailureState(0, new Date(0), " Telegram 403 / chat not found ");
  assert.equal(state.lastError, "_Telegram_403___chat_not_found_");
});

test("invalid attempt counts are rejected", () => {
  assert.throws(() => getAccessDeliveryFailureState(-1, new Date(), "ERROR"));
  assert.throws(() => getAccessDeliveryFailureState(1.5, new Date(), "ERROR"));
});
