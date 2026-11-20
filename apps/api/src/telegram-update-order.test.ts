import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveTelegramUpdateSequenceEpoch,
  shouldProcessTelegramUpdate
} from "./telegram-update-order.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

test("the first valid Telegram update is processable", () => {
  assert.equal(shouldProcessTelegramUpdate(1, null), true);
});

test("only update IDs newer than the stored cursor are processable in one sequence", () => {
  assert.equal(shouldProcessTelegramUpdate(101, 100n, 0, 0), true);
  assert.equal(shouldProcessTelegramUpdate(100, 100n, 0, 0), false);
  assert.equal(shouldProcessTelegramUpdate(99, 100n, 0, 0), false);
});

test("a newer sequence epoch supersedes old update IDs", () => {
  assert.equal(shouldProcessTelegramUpdate(5, 900n, 0, 1), true);
  assert.equal(shouldProcessTelegramUpdate(900, 5n, 1, 0), false);
});

test("invalid or unsafe Telegram update IDs are rejected", () => {
  assert.equal(shouldProcessTelegramUpdate(-1, null), false);
  assert.equal(shouldProcessTelegramUpdate(1.5, null), false);
  assert.equal(shouldProcessTelegramUpdate(Number.MAX_SAFE_INTEGER + 1, null), false);
});

test("Telegram starts a new update sequence after at least seven days without updates", () => {
  const now = new Date("2026-11-21T00:00:00.000Z");
  const exactlyOneWeekEarlier = new Date(now.getTime() - WEEK_MS);
  const sixDaysEarlier = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);

  assert.equal(resolveTelegramUpdateSequenceEpoch(4, exactlyOneWeekEarlier, now), 5);
  assert.equal(resolveTelegramUpdateSequenceEpoch(4, sixDaysEarlier, now), 4);
  assert.equal(resolveTelegramUpdateSequenceEpoch(4, null, now), 4);
});
