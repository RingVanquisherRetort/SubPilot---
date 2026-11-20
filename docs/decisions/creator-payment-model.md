# Creator payment and SubPilot billing model

**Status:** Accepted for the current product direction  
**Date:** 2026-11-21  
**Scope:** Russia-first launch; Telegram channel/group subscriptions

## Decision

SubPilot follows the creator-owned payment model used by Nemiling as the reference product model:

1. Any individual may register in SubPilot and create a project.
2. The creator configures a payment method that is actually available to their merchant type and country.
3. The buyer pays through the creator's connected provider or Telegram's native payment flow.
4. The payment provider settles to the creator according to the creator's provider agreement. SubPilot does not collect creator proceeds into its own pooled balance and does not run creator payouts.
5. SubPilot verifies the payment event, records the transaction and manages the Telegram entitlement.
6. SubPilot's default revenue comes from fixed workspace plans, separate from payment-provider fees.

The current implementation has Telegram Stars checkout for Telegram channel/group access. External payment-provider adapters are not yet enabled.

## Individuals are a first-class creator type

SubPilot registration must not require self-employment or an individual-entrepreneur status.

Payment-method availability is provider-specific. The current research catalog uses the following seller-type matrix as an initial discovery hint, transcribed from Nemiling's public payment-method documentation:

| Method | Seller types shown by Nemiling | Reference country coverage | SubPilot state |
|---|---|---|---|
| Telegram Stars | Individuals | Worldwide | Implemented for channel/group access |
| YooMoney | Individuals, self-employed | Russia | Planned; verify direct provider/API terms |
| Crypto Pay | Individuals | Worldwide | Planned; API adapter not implemented |
| Manual confirmation | Individuals, self-employed, individual entrepreneurs, legal entities | Worldwide | Planned; workflow not implemented |
| YooKassa | Self-employed, individual entrepreneurs, legal entities | Russia | Research required |
| Prodamus | Self-employed, individual entrepreneurs, legal entities | Russia, Kazakhstan | Research required |
| Robokassa | Self-employed, individual entrepreneurs, legal entities | Russia, Kazakhstan | Research required |
| CloudPayments | Individual entrepreneurs, legal entities | Russia, Kazakhstan | Research required |

This is not a guarantee that a provider will onboard a particular creator or product. It is not legal advice. Before activating an adapter, verify the provider's current contract, permitted goods/services, settlement model, receipt/tax requirements, supported country and account type.

## Telegram product-policy gate

The provider catalog never overrides Telegram's rules:

- Paid access to Telegram channels/groups is treated as a digital service.
- Digital goods/services offered, promoted or fulfilled through a Telegram bot or Mini App must be paid for in Telegram Stars.
- An external provider, cryptocurrency checkout or manual bank transfer must not be used as a workaround for a Telegram Stars requirement.
- Third-party payment providers may be assessed for genuinely eligible physical goods/services or for a separate independent-web product that is not offered, promoted or fulfilled through the Telegram TPA.
- The product policy check, provider merchant eligibility and provider adapter readiness are separate gates. A method is selectable only when all relevant gates pass.

Telegram Stars payments are credited to the creator's project bot balance, not to SubPilot's pooled balance. Crypto Pay, if implemented, would credit the creator's own connected Crypto Pay application balance under that product's terms; it should not be described as a direct bank payout.

## Security and abuse controls

- Provider credentials belong to a single creator project and remain encrypted at rest.
- SubPilot never asks for a creator's personal Telegram login, password or one-time login code.
- Every payment is bound to a project, plan, buyer and unique idempotency reference.
- Payment confirmation is accepted only from a verified provider event or the official Telegram successful-payment update; a browser redirect or screenshot is not sufficient for automatic confirmation.
- Webhooks are authenticated, deduplicated and checked against the stored amount, currency, project and payment reference.
- Manual confirmation is a separate, auditable workflow. It must never silently become an automatic payment confirmation based on an uploaded image.
- Provider connections can be disabled without deleting payment history.
- Refunds, subscription cancellation and access revocation are handled as explicit lifecycle operations.

## SubPilot pricing

The primary launch model is fixed-price workspace billing. SubPilot does not take a default percentage of each creator sale.

The seven-day free period followed by a 14% commission is preserved as an isolated experiment only. Its calculator and schema groundwork are not connected to the creator payment success path. Do not activate commission accrual or collection until the terms, eligible seller types, permitted payment scenarios, tax/receipt handling, currency conversion and collection model have been separately reviewed and approved. In particular, XTR must never be silently converted into RUB and SubPilot must never debit the creator's Stars balance.

## Implementation sequence

1. Keep Stars checkout and subscription/access lifecycle stable.
2. Add fixed-price SubPilot workspace billing.
3. Complete the creator payment settings UI and the merchant-type profile needed for method filtering.
4. Implement only provider adapters that are permitted for the selected product and seller type.
5. Add separate audit, refund, reconciliation and operational recovery paths before production activation.
