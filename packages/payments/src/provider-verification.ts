export interface ProviderCredentialVerificationInput {
  credentials: Record<string, string>;
  environment: "TEST" | "LIVE";
}

export type ProviderCredentialVerificationResult =
  | { ok: true }
  | { ok: false; errorCode: string };

/**
 * A provider-specific verifier validates merchant credentials against the
 * provider's own API. It must never return or log credential values.
 */
export interface PaymentProviderCredentialVerifier {
  readonly provider: string;
  verifyCredentials(
    input: ProviderCredentialVerificationInput
  ): Promise<ProviderCredentialVerificationResult>;
}

export class PaymentProviderCredentialVerifierRegistry {
  private readonly verifiers = new Map<string, PaymentProviderCredentialVerifier>();

  register(verifier: PaymentProviderCredentialVerifier): this {
    if (this.verifiers.has(verifier.provider)) {
      throw new Error(`Credential verifier already registered: ${verifier.provider}`);
    }
    this.verifiers.set(verifier.provider, verifier);
    return this;
  }

  get(provider: string): PaymentProviderCredentialVerifier {
    const verifier = this.verifiers.get(provider);
    if (!verifier) throw new Error(`Credential verifier is not configured: ${provider}`);
    return verifier;
  }

  has(provider: string): boolean {
    return this.verifiers.has(provider);
  }
}
