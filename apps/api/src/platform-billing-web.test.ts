import assert from "node:assert/strict";
import Fastify from "fastify";
import { test } from "node:test";
import { registerPlatformBillingWebRoutes } from "./platform-billing-web.js";

const CONFIG_KEYS = [
  "CONTROL_BOT_TOKEN",
  "TELEGRAM_LOGIN_BOT_USERNAME",
  "PLATFORM_BILLING_WEB_ENABLED",
  "PLATFORM_BILLING_WEB_COMPLIANCE_REVIEWED",
  "PLATFORM_BILLING_TELEGRAM_TPA_RELATED",
  "PLATFORM_BILLING_WEB_ORIGIN",
  "PLATFORM_BILLING_WEB_SESSION_SECRET",
  "PLATFORM_BILLING_PROVIDER_CONNECTION_ID",
  "PLATFORM_BILLING_RETURN_URL"
] as const;

function saveEnvironment(): Map<string, string | undefined> {
  return new Map(CONFIG_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureEnabledCheckout(): void {
  process.env.CONTROL_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  process.env.TELEGRAM_LOGIN_BOT_USERNAME = "SubPilotLoginBot";
  process.env.PLATFORM_BILLING_WEB_ENABLED = "true";
  process.env.PLATFORM_BILLING_WEB_COMPLIANCE_REVIEWED = "true";
  process.env.PLATFORM_BILLING_TELEGRAM_TPA_RELATED = "false";
  process.env.PLATFORM_BILLING_WEB_ORIGIN = "https://tgsubpilot.ru";
  process.env.PLATFORM_BILLING_WEB_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.PLATFORM_BILLING_PROVIDER_CONNECTION_ID = "conn_test_123456";
  process.env.PLATFORM_BILLING_RETURN_URL = "https://tgsubpilot.ru/billing/return";
}

test("web billing routes fail closed and require an authenticated same-origin owner session", async () => {
  const previous = saveEnvironment();
  const app = Fastify({ logger: false });
  registerPlatformBillingWebRoutes(app);

  try {
    configureEnabledCheckout();

    const page = await app.inject({ method: "GET", url: "/billing" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-security-policy"] ?? "", /frame-ancestors 'none'/);
    assert.match(page.headers["cache-control"] ?? "", /no-store/);

    const returnPage = await app.inject({ method: "GET", url: "/billing/return?payment_id=payment_1234567890" });
    assert.equal(returnPage.statusCode, 200);

    const optionsWithoutSession = await app.inject({ method: "GET", url: "/web/billing/options" });
    assert.equal(optionsWithoutSession.statusCode, 401);

    const statusWithoutSession = await app.inject({
      method: "GET", url: "/web/billing/status?payment_id=payment_1234567890"
    });
    assert.equal(statusWithoutSession.statusCode, 401);

    const checkoutWithoutSession = await app.inject({
      method: "POST",
      url: "/web/billing/checkout",
      headers: { origin: "https://tgsubpilot.ru", "content-type": "application/json" },
      payload: {
        workspaceId: "workspace_test_123",
        planCode: "pro_monthly",
        idempotencyKey: "123e4567-e89b-12d3-a456-426614174000"
      }
    });
    assert.equal(checkoutWithoutSession.statusCode, 401);

    const checkoutFromAnotherOrigin = await app.inject({
      method: "POST",
      url: "/web/billing/checkout",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      payload: {
        workspaceId: "workspace_test_123",
        planCode: "pro_monthly",
        idempotencyKey: "123e4567-e89b-12d3-a456-426614174000"
      }
    });
    assert.equal(checkoutFromAnotherOrigin.statusCode, 403);

    const loginFromAnotherOrigin = await app.inject({
      method: "POST",
      url: "/web/billing/auth/telegram",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      payload: { id: "123456789", auth_date: 1800000000, hash: "0".repeat(64) }
    });
    assert.equal(loginFromAnotherOrigin.statusCode, 403);

    const invalidTelegramAssertion = await app.inject({
      method: "POST",
      url: "/web/billing/auth/telegram",
      headers: { origin: "https://tgsubpilot.ru", "content-type": "application/json" },
      payload: { id: "123456789", auth_date: 1800000000, hash: "0".repeat(64) }
    });
    assert.equal(invalidTelegramAssertion.statusCode, 401);

    process.env.PLATFORM_BILLING_WEB_ENABLED = "false";
    const disabledAuth = await app.inject({
      method: "POST",
      url: "/web/billing/auth/telegram",
      headers: { origin: "https://tgsubpilot.ru", "content-type": "application/json" },
      payload: { id: "123456789", auth_date: 1800000000, hash: "0".repeat(64) }
    });
    assert.equal(disabledAuth.statusCode, 503);
    const disabledPage = await app.inject({ method: "GET", url: "/billing" });
    assert.equal(disabledPage.statusCode, 200);
    assert.match(disabledPage.body, /Web checkout is disabled/);
  } finally {
    restoreEnvironment(previous);
    await app.close();
  }
});
