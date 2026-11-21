import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPlatformAdminTelegramId,
  parsePlatformAdminTelegramIds
} from "./platform-admin.js";

test("platform admin allowlist parses comma-separated Telegram IDs", () => {
  assert.deepEqual(
    [...parsePlatformAdminTelegramIds("12345, 67890,12345")],
    ["12345", "67890"]
  );
});

test("empty and malformed allowlists fail closed", () => {
  assert.equal(parsePlatformAdminTelegramIds(undefined).size, 0);
  assert.equal(parsePlatformAdminTelegramIds("").size, 0);
  assert.equal(parsePlatformAdminTelegramIds("123,not-an-id").size, 0);
  assert.equal(parsePlatformAdminTelegramIds("0").size, 0);
  assert.equal(parsePlatformAdminTelegramIds("-123").size, 0);
  assert.equal(parsePlatformAdminTelegramIds("9223372036854775808").size, 0);
});

test("only explicitly allowlisted Telegram users are platform admins", () => {
  assert.equal(isPlatformAdminTelegramId(12345, "12345,67890"), true);
  assert.equal(isPlatformAdminTelegramId("67890", "12345,67890"), true);
  assert.equal(isPlatformAdminTelegramId(11111, "12345,67890"), false);
  assert.equal(isPlatformAdminTelegramId(12345, undefined), false);
  assert.equal(isPlatformAdminTelegramId(-1, "12345"), false);
});
