import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldProcessTelegramUpdate } from "./telegram-update-order.js";

test("the first valid Telegram update is processable", () => {
  assert.equal(shouldProcessTelegramUpdate(1, null), true);
});

test("only update IDs newer than the stored cursor are processable", () => {
  assert.equal(shouldProcessTelegramUpdate(101, 100n), true);
  assert.equal(shouldProcessTelegramUpdate(100, 100n), false);
  assert.equal(shouldProcessTelegramUpdate(99, 100n), false);
});

test("invalid or unsafe Telegram update IDs are rejected", () => {
  assert.equal(shouldProcessTelegramUpdate(-1, null), false);
  assert.equal(shouldProcessTelegramUpdate(1.5, null), false);
  assert.equal(shouldProcessTelegramUpdate(Number.MAX_SAFE_INTEGER + 1, null), false);
});
