import { createHash } from "node:crypto";
import type { CheckoutResult, CreateCheckoutInput, NormalizedPaymentEvent, PaymentProviderAdapter, ProviderWebhookRequest } from "./index.js";
import type { PaymentProviderCredentialVerifier, ProviderCredentialVerificationInput, ProviderCredentialVerificationResult } from "./provider-verification.js";

const API_BASE = "https://api.yookassa.ru/v3";
const DEFAULT_TIMEOUT_MS = 10_000;
type JsonObject = Record<string, unknown>;
type FetchImplementation = typeof fetch;

export interface YooKassaCredentials { shopId: string; secretKey: string; }
export interface YooKassaAdapterOptions { fetch?: FetchImplementation; timeoutMs?: number; }

export class YooKassaApiError extends Error {
  constructor(public readonly status: number, public readonly providerCode?: string) {
    super("YooKassa API request failed.");
    this.name = "YooKassaApiError";
  }
}
function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid YooKassa response: " + field + " is missing.");
  return value;
}
function normalizeCredentials(credentials: YooKassaCredentials): YooKassaCredentials {
  if (!/^\d{1,32}$/.test(credentials.shopId) ||
      typeof credentials.secretKey !== "string" ||
      credentials.secretKey.length < 8 || credentials.secretKey.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(credentials.secretKey)) throw new Error("Invalid YooKassa credentials.");
  return { shopId: credentials.shopId, secretKey: credentials.secretKey };
}
function asAmount(value: string): string {
  const normalized = value.trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(normalized)) throw new Error("Invalid YooKassa amount.");
  const parts = normalized.split(".");
  const result = (parts[0] ?? "0") + "." + (parts[1] ?? "").padEnd(2, "0");
  if (!/[1-9]/.test(result)) throw new Error("YooKassa amount must be greater than zero.");
  return result;
}
function currencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw new Error("Invalid payment currency.");
  return normalized;
}
function idempotenceKey(value: string): string {
  if (!value.trim()) throw new Error("An idempotency key is required.");
  return createHash("sha256").update(value).digest("hex");
}
function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
function notificationParts(body: unknown): { event: string; object: JsonObject } | null {
  if (!isRecord(body) || body.type !== "notification" ||
      typeof body.event !== "string" || !isRecord(body.object)) return null;
  return { event: body.event, object: body.object };
}
function paymentReference(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined;
  const value = metadata.subpilot_payment_id;
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}
function amountsMatch(announced: unknown, current: unknown): boolean {
  if (!isRecord(announced) || !isRecord(current) ||
      typeof announced.value !== "string" || typeof current.value !== "string" ||
      typeof announced.currency !== "string" || typeof current.currency !== "string") return false;
  return announced.value === current.value &&
    announced.currency.toUpperCase() === current.currency.toUpperCase();
}

export class YooKassaPaymentAdapter implements PaymentProviderAdapter {
  readonly provider = "YOOKASSA" as const;
  private readonly fetchImpl: FetchImplementation;
  private readonly timeoutMs: number;
  private readonly authorization: string;

  constructor(credentials: YooKassaCredentials, options: YooKassaAdapterOptions = {}) {
    const safe = normalizeCredentials(credentials);
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error("Invalid YooKassa request timeout.");
    }
    this.authorization = "Basic " + Buffer.from(safe.shopId + ":" + safe.secretKey, "utf8").toString("base64");
  }

  private async request(path: string, init: RequestInit = {}): Promise<JsonObject> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      headers.set("Authorization", this.authorization);
      response = await this.fetchImpl(API_BASE + path, {
        ...init, headers, signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new Error("YooKassa API is unavailable.");
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = isRecord(payload) && typeof payload.code === "string" &&
        /^[a-z0-9_]{1,64}$/i.test(payload.code) ? payload.code : undefined;
      throw new YooKassaApiError(response.status, code);
    }
    if (!isRecord(payload)) throw new Error("Invalid YooKassa API response.");
    return payload;
  }

  private async getPayment(id: string): Promise<JsonObject> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid YooKassa payment identifier.");
    return this.request("/payments/" + encodeURIComponent(id));
  }
  private async getRefund(id: string): Promise<JsonObject> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid YooKassa refund identifier.");
    return this.request("/refunds/" + encodeURIComponent(id));
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    const amount = asAmount(input.amount);
    const currency = currencyCode(input.currency);
    if (!input.paymentId.trim()) throw new Error("A local payment identifier is required.");
    if (typeof input.returnUrl !== "string" || !input.returnUrl.trim()) throw new Error("A return URL is required for YooKassa checkout.");
    let returnUrl: URL;
    try { returnUrl = new URL(input.returnUrl); } catch { throw new Error("Invalid YooKassa return URL."); }
    if (returnUrl.protocol !== "https:" &&
        !(returnUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(returnUrl.hostname))) {
      throw new Error("YooKassa return URL must use HTTPS.");
    }
    const description = (input.description || input.title || "SubPilot subscription").trim();
    if (!description || description.length > 128) throw new Error("YooKassa payment description must contain 1 to 128 characters.");

    const result = await this.request("/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotence-Key": idempotenceKey(input.paymentId) },
      body: JSON.stringify({
        amount: { value: amount, currency },
        capture: true,
        confirmation: { type: "redirect", return_url: returnUrl.toString() },
        description,
        metadata: { subpilot_payment_id: input.paymentId }
      })
    });
    const providerPaymentId = requiredString(result.id, "id");
    if (!isRecord(result.confirmation)) throw new Error("Invalid YooKassa response: confirmation is missing.");
    const checkoutUrl = requiredString(result.confirmation.confirmation_url, "confirmation.confirmation_url");
    let safeUrl: URL;
    try { safeUrl = new URL(checkoutUrl); } catch { throw new Error("Invalid YooKassa checkout URL."); }
    if (safeUrl.protocol !== "https:") throw new Error("Invalid YooKassa checkout URL.");
    const expiresAt = parseDate(result.expires_at);
    return { checkoutUrl: safeUrl.toString(), providerPaymentId, ...(expiresAt ? { expiresAt } : {}) };
  }

  async createRefund(input: {
    providerPaymentId: string; amount: string; currency: string; idempotencyKey: string; description?: string;
  }): Promise<{ providerRefundId: string; status: string }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.providerPaymentId)) throw new Error("Invalid YooKassa payment identifier.");
    const result = await this.request("/refunds", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotence-Key": idempotenceKey(input.idempotencyKey) },
      body: JSON.stringify({
        payment_id: input.providerPaymentId,
        amount: { value: asAmount(input.amount), currency: currencyCode(input.currency) },
        ...(input.description ? { description: input.description.slice(0, 128) } : {})
      })
    });
    return { providerRefundId: requiredString(result.id, "id"), status: requiredString(result.status, "status") };
  }

  /**
   * YooKassa notifications are not cryptographically signed. Re-fetch the object
   * over authenticated API and compare ID, status, amount, currency and payment reference.
   */
  async verifyWebhook(request: ProviderWebhookRequest): Promise<boolean> {
    const parts = notificationParts(request.body);
    if (!parts) return false;
    try {
      if (parts.event === "payment.succeeded" || parts.event === "payment.canceled") {
        const id = parts.object.id;
        if (typeof id !== "string") return false;
        const current = await this.getPayment(id);
        const expectedStatus = parts.event === "payment.succeeded" ? "succeeded" : "canceled";
        const reference = paymentReference(current.metadata);
        return current.id === id && current.status === expectedStatus &&
          amountsMatch(parts.object.amount, current.amount) &&
          reference !== undefined && paymentReference(parts.object.metadata) === reference;
      }
      if (parts.event === "refund.succeeded") {
        const refundId = parts.object.id;
        const paymentId = parts.object.payment_id;
        if (typeof refundId !== "string" || typeof paymentId !== "string") return false;
        const current = await this.getRefund(refundId);
        return current.id === refundId && current.payment_id === paymentId &&
          current.status === "succeeded" && amountsMatch(parts.object.amount, current.amount);
      }
    } catch { return false; }
    return false;
  }

  async parseWebhook(body: unknown): Promise<NormalizedPaymentEvent[]> {
    const parts = notificationParts(body);
    if (!parts) return [];

    if (parts.event === "payment.succeeded" || parts.event === "payment.canceled") {
      const id = parts.object.id;
      const amount = parts.object.amount;
      if (typeof id !== "string" || !isRecord(amount) ||
          typeof amount.value !== "string" || typeof amount.currency !== "string") return [];
      const reference = paymentReference(parts.object.metadata);
      const occurredAt = parseDate(parts.object.captured_at ?? parts.object.created_at);
      return [{
        providerEventId: parts.event + ":" + id,
        eventType: parts.event,
        providerPaymentId: id,
        ...(reference ? { paymentReference: reference } : {}),
        status: parts.event === "payment.succeeded" ? "SUCCEEDED" : "CANCELLED",
        amount: amount.value, currency: amount.currency,
        ...(occurredAt ? { occurredAt } : {}),
        rawPayload: body
      }];
    }

    if (parts.event === "refund.succeeded") {
      const refundId = parts.object.id;
      const paymentId = parts.object.payment_id;
      const amount = parts.object.amount;
      if (typeof refundId !== "string" || typeof paymentId !== "string" ||
          !isRecord(amount) || typeof amount.value !== "string" || typeof amount.currency !== "string") return [];
      let payment: JsonObject;
      try { payment = await this.getPayment(paymentId); } catch { return []; }
      const reference = paymentReference(payment.metadata);
      const occurredAt = parseDate(parts.object.created_at);
      return [{
        providerEventId: parts.event + ":" + refundId, eventType: parts.event,
        providerPaymentId: paymentId, ...(reference ? { paymentReference: reference } : {}),
        status: "REFUNDED",
        // Partial refunds intentionally fail exact-amount reconciliation rather than revoking access.
        amount: amount.value, currency: amount.currency,
        ...(occurredAt ? { occurredAt } : {}),
        rawPayload: body
      }];
    }
    return [];
  }
}

export class YooKassaCredentialVerifier implements PaymentProviderCredentialVerifier {
  readonly provider = "YOOKASSA" as const;
  constructor(private readonly fetchImpl: FetchImplementation = fetch) {}

  async verifyCredentials(input: ProviderCredentialVerificationInput): Promise<ProviderCredentialVerificationResult> {
    try {
      const safe = normalizeCredentials({
        shopId: input.credentials.shopId,
        secretKey: input.credentials.secretKey
      });
      const response = await this.fetchImpl(API_BASE + "/payments?limit=1", {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Basic " + Buffer.from(safe.shopId + ":" + safe.secretKey, "utf8").toString("base64")
        },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
      });
      if (!response.ok) return { ok: false, errorCode: "PROVIDER_REJECTED_CREDENTIALS" };
      const body: unknown = await response.json().catch(() => null);
      return isRecord(body) && body.type === "list" && Array.isArray(body.items)
        ? { ok: true }
        : { ok: false, errorCode: "INVALID_PROVIDER_RESPONSE" };
    } catch { return { ok: false, errorCode: "VERIFICATION_FAILED" }; }
  }
}
