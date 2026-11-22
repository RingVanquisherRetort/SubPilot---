import assert from "node:assert/strict";
import { test } from "node:test";
import { getAccessRevocationRetryState } from "./access-revocation-retry.js";

const now = new Date("2026-11-22T12:00:00.000Z");

test("revocation retry uses an increasing delay after each failed attempt", () => {
  const first = getAccessRevocationRetryState(0, now, "INVITE_REVOKE_FAILED");
  const second = getAccessRevocationRetryState(first.attempts, now, "INVITE_REVOKE_FAILED");
  const third = getAccessRevocationRetryState(second.attempts, now, "INVITE_REVOKE_FAILED");

  assert.equal(first.attempts, 1);
  assert.equal(first.nextAttemptAt.getTime() - now.getTime(), 2 * 60_000);
  assert.equal(second.attempts, 2);
  assert.equal(second.nextAttemptAt.getTime() - now.getTime(), 4 * 60_000);
  assert.equal(third.attempts, 3);
  assert.equal(third.nextAttemptAt.getTime() - now.getTime(), 8 * 60_000);
});

test("revocation retry delay is capped so a broken grant eventually gets another attempt", () => {
  const retry = getAccessRevocationRetryState(20, now, "SOURCE_BOT_UNAVAILABLE");
  assert.equal(retry.attempts, 21);
  assert.equal(retry.nextAttemptAt.getTime() - now.getTime(), 60 * 60_000);
});

test("invalid error strings are normalized before persistence", () => {
  const retry = getAccessRevocationRetryState(0, now, "telegram token: secret-value");
  assert.equal(retry.lastError, "ACCESS_REVOCATION_FAILED");
});
