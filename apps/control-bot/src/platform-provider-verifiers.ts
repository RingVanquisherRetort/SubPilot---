import { PaymentProviderCredentialVerifierRegistry } from "@subpilot/payments";

/**
 * Provider-specific verification adapters are registered here when they are
 * implemented. An empty registry intentionally leaves all connections PENDING.
 */
export const platformProviderCredentialVerifiers =
  new PaymentProviderCredentialVerifierRegistry();
