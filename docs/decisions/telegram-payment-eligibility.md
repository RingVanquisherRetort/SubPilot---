# Telegram payment eligibility decision

**Status:** implemented as a conservative application-level policy gate  
**Scope:** creator checkout and future provider adapters  
**Last reviewed:** 2026-11-20

## Findings from Nemiling public documentation

Nemiling's public material describes a creator-owned payment model: the creator connects payment credentials, the payment provider processes the transaction and settles to the creator, and Nemiling receives a technical confirmation before granting or revoking Telegram access. It documents provider connections for YooKassa, YooMoney, Prodamus, Robokassa, CloudPayments, Crypto Pay, Telegram Stars, Telegram Payments and manual confirmation.

The Robokassa setup guide instructs the creator to set a Result URL webhook, and separately configures success/failure return URLs. Its Telegram Payments guide instructs the owner to obtain a provider token from BotFather and attach it to the project bot. The product page also advertises direct tariff links for external websites.

These are descriptions of Nemiling product and its publicly documented setup. They do not establish that every listed method is permitted for every product type under Telegram current rules. The public docs do not provide enough detail to prove that an external-card checkout for digital channel access is compliant.

## Telegram rule applied by SubPilot

Telegram current Bot Platform Developer Terms, section 6.2, say transactions for digital goods and services in a bot or Mini App must be executed exclusively using Telegram Stars. Telegram Stars documentation repeats that rule and says it applies even when the developer also operates websites, apps or other payment providers.

Therefore:
- Paid access to a Telegram channel/group is classified as TELEGRAM_CHANNEL_ACCESS and must use Telegram Stars.
- Other digital goods/services offered, promoted, or fulfilled by a Telegram bot/Mini App must use Telegram Stars.
- An external provider must not be used as a redirect or alternate checkout for a digital product associated with the Telegram bot/Mini App.
- Independent website sales are represented separately and require an explicit declaration that the product is not offered, promoted, or fulfilled by the Telegram TPA. This is not a loophole for channel access: the channel-access product type is always restricted to Stars.
- Telegram Stars are not the route for physical goods/services. Eligible physical goods/services may use third-party providers in accordance with the Bot Payments API, provider terms and local law.

The policy gate evaluates Telegram product/surface eligibility only. A positive result does not mean an adapter exists or that a merchant has been approved by a PSP.

## Nemiling-style mechanics worth adopting

1. Creator-owned merchant account/credentials and direct settlement to the creator, when the provider explicitly supports this merchant model.
2. One payment connection per project/provider/merchant label, with encrypted credentials and test/live separation.
3. Provider notification endpoint separate from browser success/failure return URLs.
4. Verify provider payment server-side; never grant access based only on a return URL, screenshot or client message.
5. Normalize provider events into one internal event contract, deduplicate them, and process them idempotently.
6. Store an immutable snapshot of the purchase, merchant connection, amount, currency, product classification and access period.
7. Keep creator transaction money/records separate from SubPilot own workspace billing.

## Current implementation state

- Telegram Stars checkout is implemented for in-Telegram digital access.
- A common adapter contract and registry exist.
- External PSP adapters are not implemented and must remain unavailable for Telegram channel-access plans.
- evaluatePaymentEligibility is the first reusable policy gate. It does not activate providers by itself.
- Merchant KYC, country, legal status, product category, provider-specific contract, recurring-payment consent, refund support and receipt/tax handling must be checked before enabling an adapter.

## Release blockers before external providers

- Legal/compliance review of the exact product, sales surface, and jurisdiction.
- Provider approval for the creator legal form and business category.
- Explicit provider capability mapping: checkout, webhooks, refund, recurring payment, cancellation, receipts and direct settlement.
- Authenticated webhook verification plus server-side payment retrieval.
- Payment-period ledger and exact refund recalculation.
- No external checkout for Telegram digital access unless Telegram official rules are changed or written guidance clearly permits the exact scenario.