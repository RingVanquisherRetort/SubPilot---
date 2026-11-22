export const PAYMENT_PROVIDER_IDS = [
  "TELEGRAM_STARS",
  "YOOKASSA",
  "YOOMONEY",
  "PRODAMUS",
  "ROBOKASSA",
  "CLOUDPAYMENTS",
  "CRYPTO_PAY",
  "MANUAL"
] as const;

export type PaymentProviderId = (typeof PAYMENT_PROVIDER_IDS)[number];
export type NormalizedPaymentStatus = "SUCCEEDED" | "FAILED" | "CANCELLED" | "REFUNDED";

export interface CreateCheckoutInput {
  paymentId: string;
  amount: string;
  currency: string;
  title: string;
  description: string;
  customerReference: string;
  returnUrl?: string;
  metadata?: Record<string, string>;
}

export interface CheckoutResult {
  checkoutUrl?: string;
  invoicePayload?: string;
  expiresAt?: Date;
  providerPaymentId?: string;
  instructions?: string;
}

export interface NormalizedPaymentEvent {
  providerEventId: string;
  eventType: string;
  providerPaymentId: string;
  paymentReference?: string;
  status: NormalizedPaymentStatus;
  amount: string;
  currency: string;
  occurredAt?: Date;
  rawPayload: unknown;
}

export interface ProviderWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  body: unknown;
}

export interface PaymentProviderAdapter {
  readonly provider: PaymentProviderId;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult>;
  verifyWebhook(request: ProviderWebhookRequest): Promise<boolean>;
  parseWebhook(body: unknown): Promise<NormalizedPaymentEvent[]>;
}

export class PaymentProviderRegistry {
  private readonly adapters = new Map<PaymentProviderId, PaymentProviderAdapter>();

  register(adapter: PaymentProviderAdapter): this {
    if (this.adapters.has(adapter.provider)) {
      throw new Error(`Payment adapter already registered: ${adapter.provider}`);
    }

    this.adapters.set(adapter.provider, adapter);
    return this;
  }

  get(provider: PaymentProviderId): PaymentProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Payment adapter is not configured: ${provider}`);
    }
    return adapter;
  }

  has(provider: PaymentProviderId): boolean {
    return this.adapters.has(provider);
  }

  list(): PaymentProviderId[] {
    return [...this.adapters.keys()];
  }
}

export function normalizeDecimalAmount(amount: string): string {
  const normalized = amount.trim();

  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Invalid payment amount.");
  }

  const [whole = "0", fraction = ""] = normalized.split(".");
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
  const trimmedFraction = fraction.replace(/0+$/, "");

  return trimmedFraction
    ? `${trimmedWhole}.${trimmedFraction}`
    : trimmedWhole;
}

export {
  evaluatePaymentEligibility,
  PAYMENT_PRODUCT_TYPES,
  PAYMENT_SURFACES
} from "./eligibility.js";
export type {
  PaymentEligibilityInput,
  PaymentEligibilityDecision,
  PaymentEligibilityCode,
  PaymentProductType,
  PaymentSurface
} from "./eligibility.js";

export {
  calculateIntroductoryCommission,
  START_WITHOUT_UPFRONT_COST
} from "./commission.js";
export type {
  IntroductoryCommission,
  IntroductoryCommissionInput
} from "./commission.js";


export {
  CREATOR_MERCHANT_TYPES,
  PAYMENT_PROVIDER_CATALOG,
  getPaymentProviderAvailability,
  listPaymentProviderAvailability
} from "./provider-catalog.js";
export type {
  CreatorMerchantType,
  ProviderRolloutStatus,
  ProviderSetupMode,
  PaymentProviderDescriptor,
  ProviderAvailabilityInput,
  ProviderAvailabilityReason,
  ProviderAvailability
} from "./provider-catalog.js";

export {
  classifyTelegramRefundError,
  isTelegramInviteAlreadyRevoked,
  recalculateSubscriptionPeriod,
  matchesTelegramStarsRefundReceipt
} from "./telegram-refund.js";
export type {
  TelegramRefundErrorClassification,
  PaidSubscriptionPeriod,
  SubscriptionPeriodFallback,
  RecalculatedSubscriptionPeriod,
  TelegramStarsRefundReceipt,
  TelegramStarsRefundPaymentSnapshot
} from "./telegram-refund.js";

export {
  reconcileExternalPaymentEvent
} from "./external-payment-reconciliation.js";
export type {
  TrackedExternalPaymentStatus,
  ExternalPaymentEventDecision
} from "./external-payment-reconciliation.js";

export {
  PaymentProviderCredentialVerifierRegistry
} from "./provider-verification.js";
export type {
  PaymentProviderCredentialVerifier,
  ProviderCredentialVerificationInput,
  ProviderCredentialVerificationResult
} from "./provider-verification.js";

export {
  YooKassaPaymentAdapter,
  YooKassaCredentialVerifier,
  YooKassaApiError
} from "./yookassa-adapter.js";
export type { YooKassaCredentials, YooKassaAdapterOptions } from "./yookassa-adapter.js";

export { getAccessDeliveryFailureState, MAX_ACCESS_DELIVERY_ATTEMPTS } from "./access-delivery-retry.js";
export type { AccessDeliveryFailureState } from "./access-delivery-retry.js";

export { lockSubscriptionAccessScope, lockSubscriptionAccessScopes } from "./subscription-access-scope-lock.js";

export {
  requestSubscriptionAccessReconciliation,
  claimNextSubscriptionAccessScope,
  renewSubscriptionAccessScopeLease,
  completeSubscriptionAccessScope,
  failSubscriptionAccessScope,
  DEFAULT_SUBSCRIPTION_ACCESS_SCOPE_LEASE_TTL_MS
} from "./subscription-access-scope-lease.js";
export type { SubscriptionAccessScopeLease } from "./subscription-access-scope-lease.js";
