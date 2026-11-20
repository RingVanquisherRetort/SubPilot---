import { evaluatePaymentEligibility } from "./eligibility.js";
import type { PaymentProductType, PaymentSurface } from "./eligibility.js";
import type { PaymentProviderId } from "./index.js";

export const CREATOR_MERCHANT_TYPES = [
  "INDIVIDUAL",
  "SELF_EMPLOYED",
  "INDIVIDUAL_ENTREPRENEUR",
  "LEGAL_ENTITY"
] as const;

export type CreatorMerchantType = (typeof CREATOR_MERCHANT_TYPES)[number];
export type ProviderRolloutStatus = "AVAILABLE" | "PLANNED" | "RESEARCH_REQUIRED";
export type ProviderSetupMode =
  | "TELEGRAM_NATIVE"
  | "PROVIDER_ACCOUNT"
  | "API_CREDENTIALS"
  | "MANUAL_CONFIRMATION";

export interface PaymentProviderDescriptor {
  id: PaymentProviderId;
  title: string;
  rolloutStatus: ProviderRolloutStatus;
  setupMode: ProviderSetupMode;
  sellerTypesFromReference: readonly CreatorMerchantType[];
  countriesFromReference: readonly string[];
  note: string;
}

const ALL_MERCHANT_TYPES: readonly CreatorMerchantType[] = CREATOR_MERCHANT_TYPES;

 /**
  * Research-only onboarding matrix.
  *
  * Seller types and countries below are transcribed from Nemiling's public
  * payment-method matrix, checked on 2026-11-21. They are discovery hints,
  * not provider approval or legal advice. Before enabling an integration,
  * verify the provider's current merchant terms, product rules and country
  * coverage directly with that provider.
  */
export const PAYMENT_PROVIDER_CATALOG: readonly PaymentProviderDescriptor[] = [
  {
    id: "TELEGRAM_STARS",
    title: "Telegram Stars",
    rolloutStatus: "AVAILABLE",
    setupMode: "TELEGRAM_NATIVE",
    sellerTypesFromReference: ALL_MERCHANT_TYPES,
    countriesFromReference: ["*"],
    note: "Implemented for paid access to Telegram channels/groups through the project bot."
  },
  {
    id: "YOOMONEY",
    title: "ЮMoney",
    rolloutStatus: "PLANNED",
    setupMode: "PROVIDER_ACCOUNT",
    sellerTypesFromReference: ["INDIVIDUAL", "SELF_EMPLOYED"],
    countriesFromReference: ["RU"],
    note: "Listed for individuals and self-employed users in Nemiling's public matrix; SubPilot adapter and provider approval are not implemented."
  },
  {
    id: "CRYPTO_PAY",
    title: "Crypto Pay",
    rolloutStatus: "PLANNED",
    setupMode: "API_CREDENTIALS",
    sellerTypesFromReference: ["INDIVIDUAL"],
    countriesFromReference: ["*"],
    note: "Nemiling's setup guide describes connecting the creator's Crypto Pay app token and webhook; funds first reach that app balance."
  },
  {
    id: "MANUAL",
    title: "Полуавтоматическая оплата",
    rolloutStatus: "PLANNED",
    setupMode: "MANUAL_CONFIRMATION",
    sellerTypesFromReference: ALL_MERCHANT_TYPES,
    countriesFromReference: ["*"],
    note: "Requires proof submission and manual confirmation by the project owner; not a payment-provider integration."
  },
  {
    id: "YOOKASSA",
    title: "ЮKassa",
    rolloutStatus: "RESEARCH_REQUIRED",
    setupMode: "PROVIDER_ACCOUNT",
    sellerTypesFromReference: ["SELF_EMPLOYED", "INDIVIDUAL_ENTREPRENEUR", "LEGAL_ENTITY"],
    countriesFromReference: ["RU"],
    note: "Reference matrix lists self-employed users, individual entrepreneurs and legal entities; direct provider terms must be verified."
  },
  {
    id: "PRODAMUS",
    title: "Prodamus",
    rolloutStatus: "RESEARCH_REQUIRED",
    setupMode: "PROVIDER_ACCOUNT",
    sellerTypesFromReference: ["SELF_EMPLOYED", "INDIVIDUAL_ENTREPRENEUR", "LEGAL_ENTITY"],
    countriesFromReference: ["RU", "KZ"],
    note: "Reference matrix lists self-employed users, individual entrepreneurs and legal entities; direct provider terms must be verified."
  },
  {
    id: "ROBOKASSA",
    title: "Robokassa",
    rolloutStatus: "RESEARCH_REQUIRED",
    setupMode: "PROVIDER_ACCOUNT",
    sellerTypesFromReference: ["SELF_EMPLOYED", "INDIVIDUAL_ENTREPRENEUR", "LEGAL_ENTITY"],
    countriesFromReference: ["RU", "KZ"],
    note: "Reference matrix lists self-employed users, individual entrepreneurs and legal entities; direct provider terms must be verified."
  },
  {
    id: "CLOUDPAYMENTS",
    title: "CloudPayments",
    rolloutStatus: "RESEARCH_REQUIRED",
    setupMode: "PROVIDER_ACCOUNT",
    sellerTypesFromReference: ["INDIVIDUAL_ENTREPRENEUR", "LEGAL_ENTITY"],
    countriesFromReference: ["RU", "KZ"],
    note: "Reference matrix lists individual entrepreneurs and legal entities; direct provider terms must be verified."
  }
];

export interface ProviderAvailabilityInput {
  provider: PaymentProviderId;
  countryCode: string;
  merchantType: CreatorMerchantType;
  productType: PaymentProductType;
  surface: PaymentSurface;
  telegramTpaRelated: boolean;
}

export type ProviderAvailabilityReason =
  | "MERCHANT_TYPE_NOT_SUPPORTED_BY_REFERENCE"
  | "COUNTRY_NOT_SUPPORTED_BY_REFERENCE"
  | "PRODUCT_POLICY_BLOCKED"
  | "INTEGRATION_NOT_READY";

export interface ProviderAvailability {
  provider: PaymentProviderId;
  title: string;
  rolloutStatus: ProviderRolloutStatus;
  available: boolean;
  reason?: ProviderAvailabilityReason;
  policyMessage: string;
  note: string;
}

/**
 * Returns a conservative, product-aware decision.
 *
 * A provider is selectable only when its adapter is shipped, the seller/country
 * matches the research matrix, and the Telegram product-policy gate permits
 * the chosen checkout flow. The reference matrix never overrides provider
 * contracts or local legal requirements.
 */
export function getPaymentProviderAvailability(
  input: ProviderAvailabilityInput
): ProviderAvailability {
  const descriptor = PAYMENT_PROVIDER_CATALOG.find((item) => item.id === input.provider);
  if (!descriptor) {
    throw new Error(`Unknown payment provider: ${input.provider}`);
  }

  const countryCode = input.countryCode.trim().toUpperCase();
  const merchantAllowed = descriptor.sellerTypesFromReference.includes(input.merchantType);
  const countryAllowed =
    descriptor.countriesFromReference.includes("*") ||
    descriptor.countriesFromReference.includes(countryCode);
  const policy = evaluatePaymentEligibility({
    provider: input.provider,
    productType: input.productType,
    surface: input.surface,
    telegramTpaRelated: input.telegramTpaRelated
  });

  let reason: ProviderAvailabilityReason | undefined;
  if (!merchantAllowed) {
    reason = "MERCHANT_TYPE_NOT_SUPPORTED_BY_REFERENCE";
  } else if (!countryAllowed) {
    reason = "COUNTRY_NOT_SUPPORTED_BY_REFERENCE";
  } else if (!policy.allowed) {
    reason = "PRODUCT_POLICY_BLOCKED";
  } else if (descriptor.rolloutStatus !== "AVAILABLE") {
    reason = "INTEGRATION_NOT_READY";
  }

  return {
    provider: descriptor.id,
    title: descriptor.title,
    rolloutStatus: descriptor.rolloutStatus,
    available: reason === undefined,
    ...(reason ? { reason } : {}),
    policyMessage: policy.message,
    note: descriptor.note
  };
}

export function listPaymentProviderAvailability(
  input: Omit<ProviderAvailabilityInput, "provider">
): ProviderAvailability[] {
  return PAYMENT_PROVIDER_CATALOG.map((provider) =>
    getPaymentProviderAvailability({ ...input, provider: provider.id })
  );
}
