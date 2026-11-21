import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PLATFORM_EXTERNAL_PROVIDER_IDS,
  parsePlatformProviderConnectionInput,
  parsePlatformProviderCredentials
} from "./platform-provider-connection.js";

test("platform acquiring connection parser accepts only supported external PSPs", () => {
  assert.deepEqual(
    parsePlatformProviderConnectionInput("yookassa | main | TEST"),
    { provider: "YOOKASSA", label: "main", environment: "TEST" }
  );
  assert.deepEqual(
    parsePlatformProviderConnectionInput("CRYPTO_PAY | backup account | LIVE"),
    { provider: "CRYPTO_PAY", label: "backup account", environment: "LIVE" }
  );

  for (const input of [
    "TELEGRAM_STARS | stars | LIVE",
    "MANUAL | manual | LIVE",
    "UNKNOWN | main | TEST",
    "YOOKASSA | | TEST",
    "YOOKASSA | main | production",
    "YOOKASSA | main | TEST | extra"
  ]) {
    assert.throws(() => parsePlatformProviderConnectionInput(input));
  }

  assert.deepEqual(PLATFORM_EXTERNAL_PROVIDER_IDS, [
    "YOOKASSA", "YOOMONEY", "PRODAMUS", "ROBOKASSA", "CLOUDPAYMENTS", "CRYPTO_PAY"
  ]);
});

test("platform provider credential parser accepts only a flat string object", () => {
  assert.deepEqual(
    parsePlatformProviderCredentials('{"shopId":"shop_1","secretKey":"abc-123"}'),
    { shopId: "shop_1", secretKey: "abc-123" }
  );
  for (const input of [
    "",
    "not-json",
    "[]",
    '"secret"',
    '{"secretKey":""}',
    '{"secretKey":123}',
    '{"secretKey":null}',
    '{"nested":{"key":"value"}}',
    '{"bad key":"value"}'
  ]) {
    assert.throws(() => parsePlatformProviderCredentials(input));
  }
});
