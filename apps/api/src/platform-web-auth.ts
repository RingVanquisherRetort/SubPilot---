import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface TelegramLoginIdentity {
  telegramId: string;
  firstName: string;
  username?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function constantTimeHexEquals(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Verifies Telegram Login Widget data and rejects stale or future-dated assertions. */
export function verifyTelegramLoginPayload(
  payload: unknown,
  botToken: string,
  options: { nowMs?: number; maxAgeSeconds?: number; futureSkewSeconds?: number } = {}
): TelegramLoginIdentity {
  if (!isRecord(payload) || !botToken.trim()) throw new Error("INVALID_TELEGRAM_LOGIN");
  const hash = payload.hash;
  const authDateRaw = payload.auth_date;
  const idRaw = payload.id;
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash) ||
      (typeof authDateRaw !== "string" && typeof authDateRaw !== "number") ||
      (typeof idRaw !== "string" && typeof idRaw !== "number")) {
    throw new Error("INVALID_TELEGRAM_LOGIN");
  }
  const telegramId = String(idRaw);
  const authDate = Number(authDateRaw);
  if (!/^\d{1,20}$/.test(telegramId) || !Number.isSafeInteger(authDate) || authDate <= 0) {
    throw new Error("INVALID_TELEGRAM_LOGIN");
  }
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const maxAge = options.maxAgeSeconds ?? 300;
  const futureSkew = options.futureSkewSeconds ?? 30;
  if (authDate < nowSeconds - maxAge || authDate > nowSeconds + futureSkew) {
    throw new Error("EXPIRED_TELEGRAM_LOGIN");
  }

  const entries = Object.entries(payload)
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => {
      if (!/^[a-z_]+$/.test(key) ||
          (typeof value !== "string" && typeof value !== "number") ||
          String(value).includes("\n") || String(value).includes("\r")) {
        throw new Error("INVALID_TELEGRAM_LOGIN");
      }
      return [key, String(value)] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right));
  const dataCheckString = entries.map(([key, value]) => key + "=" + value).join("\n");
  const secretKey = createHash("sha256").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!constantTimeHexEquals(hash, expectedHash)) throw new Error("INVALID_TELEGRAM_LOGIN");

  const firstName = typeof payload.first_name === "string" ? payload.first_name.slice(0, 128) : "";
  const username = typeof payload.username === "string" && /^[A-Za-z0-9_]{1,32}$/.test(payload.username)
    ? payload.username
    : undefined;
  return { telegramId, firstName, ...(username ? { username } : {}) };
}

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
}

function sessionSignature(encodedPayload: string, secret: string): string {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("PLATFORM_BILLING_WEB_SESSION_SECRET must be at least 32 bytes.");
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createPlatformWebSession(
  telegramId: string,
  secret: string,
  options: { nowMs?: number; ttlSeconds?: number } = {}
): string {
  if (!/^\d{1,20}$/.test(telegramId)) throw new Error("INVALID_SESSION_SUBJECT");
  const issuedAt = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const ttlSeconds = options.ttlSeconds ?? 8 * 60 * 60;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 24 * 60 * 60) {
    throw new Error("INVALID_SESSION_TTL");
  }
  const payload: SessionPayload = {
    sub: telegramId,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    nonce: randomBytes(16).toString("hex")
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return encoded + "." + sessionSignature(encoded, secret);
}

export function verifyPlatformWebSession(
  token: string | undefined,
  secret: string,
  nowMs = Date.now()
): string | null {
  if (!token || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let expected: string;
  try { expected = sessionSignature(parts[0] ?? "", secret); }
  catch { return null; }
  const actualBytes = Buffer.from(parts[1] ?? "", "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded) || typeof decoded.sub !== "string" ||
        !/^\d{1,20}$/.test(decoded.sub) ||
        typeof decoded.iat !== "number" || typeof decoded.exp !== "number" ||
        typeof decoded.nonce !== "string" || !/^[a-f0-9]{32}$/.test(decoded.nonce)) return null;
    const nowSeconds = Math.floor(nowMs / 1000);
    if (!Number.isSafeInteger(decoded.iat) || !Number.isSafeInteger(decoded.exp) ||
        decoded.iat > nowSeconds + 30 || decoded.exp <= nowSeconds ||
        decoded.exp <= decoded.iat || decoded.exp - decoded.iat > 24 * 60 * 60) return null;
    return decoded.sub;
  } catch {
    return null;
  }
}

export function isExpectedWebOrigin(origin: string | undefined, expectedOrigin: string | undefined): boolean {
  if (!origin || !expectedOrigin) return false;
  try {
    const expected = new URL(expectedOrigin);
    const received = new URL(origin);
    return expected.protocol === "https:" &&
      expected.origin === expectedOrigin &&
      received.origin === origin &&
      received.origin === expected.origin;
  } catch {
    return false;
  }
}
