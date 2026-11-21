import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  createPlatformWebSession,
  isExpectedWebOrigin,
  verifyPlatformWebSession,
  verifyTelegramLoginPayload
} from "./platform-web-auth.js";

function signedTelegramPayload(botToken: string, nowSeconds: number): Record<string, string> {
  const payload: Record<string, string> = {
    auth_date: String(nowSeconds),
    first_name: "SubPilot User",
    id: "123456789",
    username: "subpilot_user"
  };
  const data = Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value).join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  payload.hash = createHmac("sha256", secret).update(data).digest("hex");
  return payload;
}

test("verifies Telegram Login Widget payload and extracts only the trusted identity", () => {
  const nowMs = 1_800_000_000_000;
  const payload = signedTelegramPayload("123456:bot-token-secret", Math.floor(nowMs / 1000));
  assert.deepEqual(
    verifyTelegramLoginPayload(payload, "123456:bot-token-secret", { nowMs }),
    { telegramId: "123456789", firstName: "SubPilot User", username: "subpilot_user" }
  );
});

test("rejects tampered, stale and future Telegram login assertions", () => {
  const nowMs = 1_800_000_000_000;
  const nowSeconds = Math.floor(nowMs / 1000);
  const valid = signedTelegramPayload("123456:bot-token-secret", nowSeconds);
  assert.throws(() => verifyTelegramLoginPayload({ ...valid, id: "987654321" },
    "123456:bot-token-secret", { nowMs }), /INVALID_TELEGRAM_LOGIN/);
  assert.throws(() => verifyTelegramLoginPayload(
    signedTelegramPayload("123456:bot-token-secret", nowSeconds - 301),
    "123456:bot-token-secret", { nowMs }), /EXPIRED_TELEGRAM_LOGIN/);
  assert.throws(() => verifyTelegramLoginPayload(
    signedTelegramPayload("123456:bot-token-secret", nowSeconds + 31),
    "123456:bot-token-secret", { nowMs }), /EXPIRED_TELEGRAM_LOGIN/);
});

test("creates and verifies short-lived signed web sessions", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const nowMs = 1_800_000_000_000;
  const token = createPlatformWebSession("123456789", secret, { nowMs, ttlSeconds: 600 });
  assert.equal(verifyPlatformWebSession(token, secret, nowMs), "123456789");
  assert.equal(verifyPlatformWebSession(token, secret, nowMs + 601_000), null);
  assert.equal(verifyPlatformWebSession(token + "x", secret, nowMs), null);
  assert.equal(verifyPlatformWebSession(token, "short", nowMs), null);
});

test("requires an exact HTTPS origin match", () => {
  assert.equal(isExpectedWebOrigin("https://tgsubpilot.ru", "https://tgsubpilot.ru"), true);
  assert.equal(isExpectedWebOrigin("http://tgsubpilot.ru", "https://tgsubpilot.ru"), false);
  assert.equal(isExpectedWebOrigin("https://evil.example", "https://tgsubpilot.ru"), false);
  assert.equal(isExpectedWebOrigin("https://tgsubpilot.ru.evil", "https://tgsubpilot.ru"), false);
  assert.equal(isExpectedWebOrigin("https://tgsubpilot.ru", "https://tgsubpilot.ru/path"), false);
});
