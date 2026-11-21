import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PaymentProviderCredentialVerifierRegistry,
  type PaymentProviderCredentialVerifier
} from "./provider-verification.js";

const verifier: PaymentProviderCredentialVerifier = {
  provider: "YOOKASSA",
  async verifyCredentials({ credentials, environment }) {
    return credentials.shopId === "valid-shop" && environment === "TEST"
      ? { ok: true }
      : { ok: false, errorCode: "INVALID_CREDENTIALS" };
  }
};

test("provider credential verifier registry registers and resolves provider verifiers", async () => {
  const registry = new PaymentProviderCredentialVerifierRegistry();
  registry.register(verifier);
  assert.equal(registry.has("YOOKASSA"), true);
  assert.equal(registry.get("YOOKASSA"), verifier);
  assert.deepEqual(
    await registry.get("YOOKASSA").verifyCredentials({
      credentials: { shopId: "valid-shop", secretKey: "private" },
      environment: "TEST"
    }),
    { ok: true }
  );
  assert.deepEqual(
    await registry.get("YOOKASSA").verifyCredentials({
      credentials: { shopId: "wrong-shop", secretKey: "private" },
      environment: "TEST"
    }),
    { ok: false, errorCode: "INVALID_CREDENTIALS" }
  );
});

test("provider credential verifier registry rejects duplicate and unknown verifiers", () => {
  const registry = new PaymentProviderCredentialVerifierRegistry();
  registry.register(verifier);
  assert.throws(() => registry.register(verifier), /already registered/);
  assert.throws(() => registry.get("YOOMONEY"), /not configured/);
});
