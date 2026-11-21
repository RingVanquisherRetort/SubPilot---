import assert from "node:assert/strict";
import { test } from "node:test";
import { YooKassaCredentialVerifier, YooKassaPaymentAdapter, YooKassaApiError } from "./yookassa-adapter.js";

const credentials = { shopId: "123456", secretKey: "test_secret_key" };
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function authHeader(init?: RequestInit): string | null { return new Headers(init?.headers).get("authorization"); }

test("creates redirect checkout with Basic Auth, capture and stable idempotency", async () => {
  let url = "";
  let init: RequestInit | undefined;
  const adapter = new YooKassaPaymentAdapter(credentials, { fetch: async (input, options) => {
    url = String(input); init = options;
    return response({ id: "yoo_payment_123", status: "pending",
      confirmation: { type: "redirect", confirmation_url: "https://yookassa.ru/checkout/123" },
      expires_at: "2026-11-22T10:00:00.000Z" });
  }});
  const result = await adapter.createCheckout({
    paymentId: "local_payment_123", amount: "149.5", currency: "rub",
    title: "SubPilot", description: "Workspace subscription",
    customerReference: "workspace_1", returnUrl: "https://tgsubpilot.ru/billing/return"
  });
  assert.equal(url, "https://api.yookassa.ru/v3/payments");
  assert.equal(authHeader(init), "Basic " + Buffer.from("123456:test_secret_key").toString("base64"));
  const headers = new Headers(init?.headers);
  assert.match(headers.get("Idempotence-Key") ?? "", /^[a-f0-9]{64}$/);
  const body = JSON.parse(String(init?.body));
  assert.deepEqual(body.amount, { value: "149.50", currency: "RUB" });
  assert.equal(body.capture, true);
  assert.deepEqual(body.confirmation, { type: "redirect", return_url: "https://tgsubpilot.ru/billing/return" });
  assert.deepEqual(body.metadata, { subpilot_payment_id: "local_payment_123" });
  assert.equal(result.providerPaymentId, "yoo_payment_123");
  assert.equal(result.checkoutUrl, "https://yookassa.ru/checkout/123");
  assert.equal(result.expiresAt?.toISOString(), "2026-11-22T10:00:00.000Z");
});

test("reuses deterministic idempotency key for the same local payment", async () => {
  const keys: string[] = [];
  const adapter = new YooKassaPaymentAdapter(credentials, { fetch: async (_input, init) => {
    keys.push(new Headers(init?.headers).get("Idempotence-Key") ?? "");
    return response({ id: "payment", confirmation: { confirmation_url: "https://yookassa.ru/checkout" } });
  }});
  const input = { paymentId: "same_payment", amount: "10", currency: "RUB", title: "Plan",
    description: "Plan", customerReference: "workspace", returnUrl: "https://tgsubpilot.ru/return" };
  await adapter.createCheckout(input);
  await adapter.createCheckout(input);
  assert.equal(keys[0], keys[1]);
});

test("rejects invalid amount, currency and unsafe return URL without network calls", async () => {
  let calls = 0;
  const adapter = new YooKassaPaymentAdapter(credentials, { fetch: async () => { calls += 1; return response({}); } });
  const input = { paymentId: "payment_1", amount: "10", currency: "RUB", title: "Plan",
    description: "Plan", customerReference: "workspace", returnUrl: "https://tgsubpilot.ru/return" };
  await assert.rejects(() => adapter.createCheckout({ ...input, amount: "0" }), /greater than zero/);
  await assert.rejects(() => adapter.createCheckout({ ...input, amount: "1.001" }), /amount/);
  await assert.rejects(() => adapter.createCheckout({ ...input, currency: "RUBB" }), /currency/);
  await assert.rejects(() => adapter.createCheckout({ ...input, returnUrl: "http://evil.example/return" }), /HTTPS/);
  assert.equal(calls, 0);
});

test("rejects a non-HTTPS checkout URL returned by provider", async () => {
  const adapter = new YooKassaPaymentAdapter(credentials, { fetch: async () =>
    response({ id: "payment_1", confirmation: { confirmation_url: "javascript:alert(1)" } }) });
  await assert.rejects(() => adapter.createCheckout({
    paymentId: "local_1", amount: "10", currency: "RUB", title: "Plan", description: "Plan",
    customerReference: "workspace", returnUrl: "https://tgsubpilot.ru/return"
  }), /Invalid YooKassa checkout URL/);
});

test("sanitizes provider API errors and does not include response secrets", async () => {
  const adapter = new YooKassaPaymentAdapter(credentials, { fetch: async () =>
    response({ code: "invalid_credentials", description: "test_secret_key leaked here" }, 401) });
  await assert.rejects(async () => adapter.createRefund({
    providerPaymentId: "payment_1", amount: "10", currency: "RUB", idempotencyKey: "refund_1"
  }), (error: unknown) => {
    assert.ok(error instanceof YooKassaApiError);
    assert.equal(error.status, 401);
    assert.equal(error.providerCode, "invalid_credentials");
    assert.equal(error.message.includes("test_secret_key"), false);
    return true;
  });
});

test("validates credentials with read-only payment list API", async () => {
  let url = "";
  let init: RequestInit | undefined;
  const verifier = new YooKassaCredentialVerifier(async (input, options) => {
    url = String(input); init = options; return response({ type: "list", items: [] });
  });
  assert.deepEqual(await verifier.verifyCredentials({ credentials, environment: "TEST" }), { ok: true });
  assert.equal(url, "https://api.yookassa.ru/v3/payments?limit=1");
  assert.equal(init?.method, "GET");
  assert.equal(authHeader(init), "Basic " + Buffer.from("123456:test_secret_key").toString("base64"));
});

test("rejects invalid credentials without leaking provider response body", async () => {
  const verifier = new YooKassaCredentialVerifier(async () =>
    response({ code: "invalid_credentials", description: "secret_key must not leak" }, 401));
  assert.deepEqual(await verifier.verifyCredentials({ credentials, environment: "LIVE" }),
    { ok: false, errorCode: "PROVIDER_REJECTED_CREDENTIALS" });
  assert.deepEqual(await verifier.verifyCredentials({
    credentials: { shopId: "not-a-shop", secretKey: "secret" }, environment: "TEST"
  }), { ok: false, errorCode: "VERIFICATION_FAILED" });
});

test("verifies payment event against authoritative ID, status, amount, currency and metadata", async () => {
  let url = "";
  const adapter = new YooKassaPaymentAdapter(credentials, { fetch: async (input) => {
    url = String(input);
    return response({
      id: "provider_payment_1", status: "succeeded",
      amount: { value: "149.50", currency: "RUB" },
      metadata: { subpilot_payment_id: "local_payment_1" }
    });
  }});
  const body = { type: "notification", event: "payment.succeeded", object: {
    id: "provider_payment_1", status: "succeeded",
    amount: { value: "149.50", currency: "RUB" },
    metadata: { subpilot_payment_id: "local_payment_1" }
  }};
  assert.equal(await adapter.verifyWebhook({ headers: {}, rawBody: "", body }), true);
  assert.equal(url, "https://api.yookassa.ru/v3/payments/provider_payment_1");
});

test("rejects webhook if event amount or local metadata is altered", async () => {
  const adapter = new YooKassaPaymentAdapter(credentials, { fetch: async () => response({
    id: "provider_payment_1", status: "succeeded",
    amount: { value: "149.50", currency: "RUB" },
    metadata: { subpilot_payment_id: "correct_local_payment" }
  })});
  const base = { type: "notification", event: "payment.succeeded", object: {
    id: "provider_payment_1", status: "succeeded",
    amount: { value: "149.50", currency: "RUB" },
    metadata: { subpilot_payment_id: "correct_local_payment" }
  }};
  assert.equal(await adapter.verifyWebhook({ headers: {}, rawBody: "", body: base }), true);
  const wrongAmount = { ...base, object: { ...base.object, amount: { value: "1.00", currency: "RUB" } } };
  assert.equal(await adapter.verifyWebhook({ headers: {}, rawBody: "", body: wrongAmount }), false);
  const wrongReference = { ...base, object: { ...base.object, metadata: { subpilot_payment_id: "other_payment" } } };
  assert.equal(await adapter.verifyWebhook({ headers: {}, rawBody: "", body: wrongReference }), false);
});

test("rejects stale, unsupported and malformed notifications", async () => {
  const adapter = new YooKassaPaymentAdapter(credentials, { fetch: async () =>
    response({ id: "provider_payment_1", status: "canceled", amount: { value: "1.00", currency: "RUB" },
      metadata: { subpilot_payment_id: "local_1" } }) });
  const forged = { type: "notification", event: "payment.succeeded", object: {
    id: "provider_payment_1", status: "succeeded", amount: { value: "1.00", currency: "RUB" },
    metadata: { subpilot_payment_id: "local_1" }
  }};
  assert.equal(await adapter.verifyWebhook({ headers: {}, rawBody: "", body: forged }), false);
  assert.equal(await adapter.verifyWebhook({ headers: {}, rawBody: "", body: {
    type: "notification", event: "unknown.event", object: { id: "x" }
  }}), false);
  assert.equal(await adapter.verifyWebhook({ headers: {}, rawBody: "", body: null }), false);
});

test("parses payment events and retains the SubPilot payment ID", async () => {
  const adapter = new YooKassaPaymentAdapter(credentials);
  const events = await adapter.parseWebhook({
    type: "notification", event: "payment.succeeded", object: {
      id: "provider_payment_2", status: "succeeded", amount: { value: "149.50", currency: "RUB" },
      metadata: { subpilot_payment_id: "local_payment_2" }, captured_at: "2026-11-21T10:00:00.000Z"
    }
  });
  assert.equal(events.length, 1);
  assert.deepEqual({
    providerEventId: events[0]?.providerEventId, providerPaymentId: events[0]?.providerPaymentId,
    paymentReference: events[0]?.paymentReference, status: events[0]?.status,
    amount: events[0]?.amount, currency: events[0]?.currency
  }, {
    providerEventId: "payment.succeeded:provider_payment_2", providerPaymentId: "provider_payment_2",
    paymentReference: "local_payment_2", status: "SUCCEEDED", amount: "149.50", currency: "RUB"
  });
});

test("authenticates refund notifications through current refund API state", async () => {
  const adapter = new YooKassaPaymentAdapter(credentials, { fetch: async (input) => {
    assert.equal(String(input), "https://api.yookassa.ru/v3/refunds/refund_123");
    return response({ id: "refund_123", payment_id: "payment_123", status: "succeeded",
      amount: { value: "10.00", currency: "RUB" } });
  }});
  assert.equal(await adapter.verifyWebhook({ headers: {}, rawBody: "", body: {
    type: "notification", event: "refund.succeeded", object: {
      id: "refund_123", payment_id: "payment_123", amount: { value: "10.00", currency: "RUB" }
    }
  }}), true);
});

test("creates refunds with decimal-safe amount and idempotency", async () => {
  let body: Record<string, unknown> = {};
  let init: RequestInit | undefined;
  const adapter = new YooKassaPaymentAdapter(credentials, { fetch: async (_input, options) => {
    init = options; body = JSON.parse(String(options?.body)); return response({ id: "refund_1", status: "succeeded" });
  }});
  const result = await adapter.createRefund({
    providerPaymentId: "payment_1", amount: "10.5", currency: "rub", idempotencyKey: "refund_local_1"
  });
  assert.equal(result.providerRefundId, "refund_1");
  assert.equal(result.status, "succeeded");
  assert.deepEqual(body, { payment_id: "payment_1", amount: { value: "10.50", currency: "RUB" } });
  assert.match(new Headers(init?.headers).get("Idempotence-Key") ?? "", /^[a-f0-9]{64}$/);
});
