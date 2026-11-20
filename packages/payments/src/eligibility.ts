import type { PaymentProviderId } from "./index.js";

export const PAYMENT_PRODUCT_TYPES = [
  "TELEGRAM_CHANNEL_ACCESS",
  "DIGITAL_GOODS_OR_SERVICES",
  "PHYSICAL_GOODS_OR_SERVICES"
] as const;

export type PaymentProductType = (typeof PAYMENT_PRODUCT_TYPES)[number];

export const PAYMENT_SURFACES = [
  "TELEGRAM_BOT",
  "TELEGRAM_MINI_APP",
  "INDEPENDENT_WEB"
] as const;

export type PaymentSurface = (typeof PAYMENT_SURFACES)[number];

export interface PaymentEligibilityInput {
  provider: PaymentProviderId;
  productType: PaymentProductType;
  surface: PaymentSurface;
  telegramTpaRelated: boolean;
}

export type PaymentEligibilityCode =
  | "ALLOWED"
  | "TELEGRAM_STARS_REQUIRED"
  | "MOVE_CHECKOUT_TO_TELEGRAM"
  | "STARS_NOT_VALID_FOR_PHYSICAL_GOODS"
  | "EXTERNAL_PROVIDER_NOT_FOR_TELEGRAM_DIGITAL_GOODS"
  | "MANUAL_CONFIRMATION_REQUIRES_INDEPENDENT_WEB";

export interface PaymentEligibilityDecision {
  allowed: boolean;
  code: PaymentEligibilityCode;
  requiredProvider?: PaymentProviderId;
  message: string;
}

/**
 * Conservative product-policy gate. This checks Telegram policy eligibility only;
 * adapter availability, merchant onboarding, provider contracts and local law
 * are separate checks.
 */
export function evaluatePaymentEligibility(
  input: PaymentEligibilityInput
): PaymentEligibilityDecision {
  const { provider, productType, surface, telegramTpaRelated } = input;

  if (productType === "TELEGRAM_CHANNEL_ACCESS") {
    if (surface !== "TELEGRAM_BOT" && surface !== "TELEGRAM_MINI_APP") {
      return {
        allowed: false,
        code: "MOVE_CHECKOUT_TO_TELEGRAM",
        requiredProvider: "TELEGRAM_STARS",
        message: "Telegram channel access is a digital service. Start checkout in the Telegram bot or Mini App and use Telegram Stars."
      };
    }
    if (provider !== "TELEGRAM_STARS") {
      return {
        allowed: false,
        code: "TELEGRAM_STARS_REQUIRED",
        requiredProvider: "TELEGRAM_STARS",
        message: "Paid access to Telegram channels/groups is digital access sold by a Telegram bot. Telegram Stars are required."
      };
    }
    return { allowed: true, code: "ALLOWED", message: "Telegram Stars are eligible for Telegram channel/group access." };
  }

  if (provider === "MANUAL" && (surface !== "INDEPENDENT_WEB" || telegramTpaRelated)) {
    return {
      allowed: false,
      code: "MANUAL_CONFIRMATION_REQUIRES_INDEPENDENT_WEB",
      message: "Manual transfer and proof review are not an in-Telegram payment provider. Keep this method to a separately reviewed independent-web checkout that is not offered, promoted or fulfilled through a Telegram bot or Mini App. Provider, tax and local-law checks still apply."
    };
  }

  if (productType === "DIGITAL_GOODS_OR_SERVICES") {
    if (telegramTpaRelated) {
      if (surface !== "TELEGRAM_BOT" && surface !== "TELEGRAM_MINI_APP") {
        return {
          allowed: false,
          code: "MOVE_CHECKOUT_TO_TELEGRAM",
          requiredProvider: "TELEGRAM_STARS",
          message: "This digital product is offered or fulfilled by a Telegram bot/Mini App. Do not move its checkout to an external provider; complete checkout with Telegram Stars inside Telegram."
        };
      }
      if (provider !== "TELEGRAM_STARS") {
        return {
          allowed: false,
          code: "TELEGRAM_STARS_REQUIRED",
          requiredProvider: "TELEGRAM_STARS",
          message: "Digital goods/services offered by a Telegram bot or Mini App must be paid for exclusively with Telegram Stars."
        };
      }
      return { allowed: true, code: "ALLOWED", message: "Telegram Stars are eligible for digital goods/services sold in the Telegram bot/Mini App." };
    }
    if (surface !== "INDEPENDENT_WEB") {
      return {
        allowed: false,
        code: "EXTERNAL_PROVIDER_NOT_FOR_TELEGRAM_DIGITAL_GOODS",
        message: "An unrelated website product must not be represented as an in-Telegram bot/Mini App payment. Use a separately reviewed external checkout."
      };
    }
    if (provider === "TELEGRAM_STARS") {
      return {
        allowed: false,
        code: "EXTERNAL_PROVIDER_NOT_FOR_TELEGRAM_DIGITAL_GOODS",
        message: "Telegram Stars checkout must be initiated through Telegram, not an independent website."
      };
    }
    return {
      allowed: true,
      code: "ALLOWED",
      message: "This is an independent website sale, not a product offered or fulfilled by the Telegram bot/Mini App. Provider, merchant and local-law checks still apply."
    };
  }

  if (provider === "TELEGRAM_STARS") {
    return {
      allowed: false,
      code: "STARS_NOT_VALID_FOR_PHYSICAL_GOODS",
      message: "Telegram Stars are intended for digital goods/services and are not the payment route for physical goods or services."
    };
  }
  return {
    allowed: true,
    code: "ALLOWED",
    message: "Third-party payments may be used for eligible physical goods/services, subject to the Telegram Bot Payments flow (when inside Telegram), provider terms and jurisdiction."
  };
}