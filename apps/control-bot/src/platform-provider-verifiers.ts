import { PaymentProviderCredentialVerifierRegistry, YooKassaCredentialVerifier } from "@subpilot/payments";

export const platformProviderCredentialVerifiers =
  new PaymentProviderCredentialVerifierRegistry()
    .register(new YooKassaCredentialVerifier());
