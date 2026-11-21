# SubPilot workspace billing checkout

**Status:** external-acquiring product direction accepted; checkout implementation and launch surface still gated by provider/compliance validation  
**Reviewed:** 2026-11-21  
**Scope:** fixed-price SubPilot workspace subscriptions

## Product decision

SubPilot's primary platform revenue model is fixed-price workspace subscriptions collected through an external payment provider (эквайринг), not Telegram Stars.

The implementation must follow the Nemiling-style separation:
- SubPilot is the software platform and merchant for its own workspace subscription.
- The external payment provider processes the charge and settles funds to SubPilot under the provider's merchant agreement.
- SubPilot stores the payment record and verified provider event, then activates or extends workspace entitlements.
- SubPilot does not treat creator payment proceeds as its own funds and does not pool, custody or pay out creator revenue.
- Creator payments and SubPilot workspace billing use separate records, provider connections, webhooks, refunds and lifecycle logic.

This product direction supersedes the previous Stars-first recommendation for SubPilot workspace billing. It does not replace Telegram Stars in creator checkout where Telegram requires Stars.

## Important Telegram policy boundary

Telegram's current Bot Platform Developer Terms state that digital goods and services offered for purchase through a Telegram bot or Mini App must be paid exclusively in Telegram Stars. The terms permit third-party payment providers in the TPA payment API for physical goods and services, while explicitly excluding digital goods/services from that route.

Official source: https://telegram.org/tos/bot-developers (sections 6.1 and 6.2).

SubPilot is software delivered digitally. Therefore, an external checkout link placed inside the bot or Mini App must not be assumed compliant merely because the payment page is hosted by a PSP. Before enabling external checkout from a Telegram surface, the exact user journey and product classification require a documented compliance review. Do not disguise, relabel or route a Telegram digital-service sale through an external PSP to evade Telegram's terms.

The external-acquiring architecture can be implemented independently of the final sales surface. The initial compliant launch surface must be confirmed before enabling customer-facing payment initiation. If a genuinely independent web checkout is selected, document how the website, offer, acquisition, account lifecycle and Telegram bot relate; do not assume that moving the card form to a browser automatically makes the sale independent of the TPA.

## Reference model: Nemiling

Nemiling's public documentation describes creator payments as going directly through the creator's connected provider, with provider-specific availability and recurring support for selected providers. This is the reference for creator payment isolation and adapter design, not proof that every provider or checkout surface is available to SubPilot.

Reference:
- https://nemiling.info/help/platyozhnye-sistemy/
- https://github.com/Nemiling-official/docs/blob/main/features/paid-subscriptions.md

## Current implementation boundary

The PlatformPlan catalogue is managed by explicitly allowlisted platform operators. Assigned plans are immutable, catalogue changes are audited, and plan assignment/deactivation operations share a row-lock protocol. Workspace quota enforcement is implemented.

The platform billing schema is groundwork only:
- WorkspaceBilling does not yet model a complete pending purchase, payment-failure/grace, cancellation-at-period-end and renewal lifecycle.
- PlatformPayment does not yet store a first-class immutable plan/price snapshot, provider connection, external checkout reference, provider event identifiers and refund reconciliation state.
- No external platform checkout handler, platform payment webhook processor, billing lifecycle worker or operational reconciliation interface is implemented.
- No platform workspace-plan assignment flow is implemented.

Creating a catalogue plan does not assign it, collect money or unlock quotas.

## Target external checkout architecture

1. The workspace owner selects an active PlatformPlan in the central control panel.
2. SubPilot creates a pending checkout and immutable purchase snapshot: workspace, plan code/title, price, currency, billing period, payer/account reference and idempotency key.
3. A platform-owned provider connection creates the hosted checkout session. Provider credentials are stored encrypted and are never exposed to the client or Telegram message.
4. The user completes payment on the provider's hosted page.
5. A verified provider webhook is authenticated, deduplicated and matched against the exact pending payment, provider account, amount, currency and immutable purchase snapshot.
6. Only a committed, verified successful payment may activate or extend WorkspaceBilling and make the plan quotas effective.
7. Browser return URLs are informational only; they never prove payment and never activate a workspace.
8. Renewals, failed charges, refunds, chargebacks and cancellation events are recorded idempotently and reconciled with the provider.
9. Cancellation stops future renewal according to the provider contract but preserves access through the paid-through timestamp unless a verified refund/chargeback or other explicit policy requires revocation.
10. All administrative changes and exceptional recovery actions are audited.

The platform billing provider connection is owned by SubPilot and is distinct from creator-owned PaymentProviderConnection records. Platform payments must not be written into creator Payment rows.

## Required data and safety controls

Before enabling checkout, add and test:
- explicit PENDING checkout/payment state that never grants quota access;
- immutable plan and amount/currency snapshot on each platform payment;
- unique idempotency key, provider payment ID and provider event ID constraints;
- platform provider connection and encrypted credentials, separate from creator connections;
- signed webhook verification using raw request bytes where required by the provider;
- strict matching of merchant account, payment reference, amount, currency and status;
- duplicate, delayed, out-of-order and replayed webhook handling;
- checkout expiration, retry and abandoned-checkout cleanup;
- transactional workspace-plan assignment and plan row locking;
- explicit payment state machine and refund/chargeback reconciliation;
- lifecycle worker for paid-through expiry, grace-period transitions and renewal state;
- audit logs and operator recovery for exhausted retries and provider inconsistencies;
- customer-facing terms, support, cancellation and refund information;
- provider-specific receipt, fiscalization, tax and merchant onboarding requirements.

Never activate access from a redirect, client callback, screenshot or unverified provider response.

## Provider selection and commercial terms

The external provider for SubPilot's own workspace billing has not yet been selected. Do not infer that a provider listed in Nemiling's creator payment matrix is available to SubPilot as a merchant. Verify current onboarding eligibility, SaaS/digital-service category acceptance, recurring billing, webhooks, refunds, chargebacks, settlement, fees, currency, fiscal receipts and legal entity requirements against the provider's own contract and documentation.

Commercial plan prices, currency, billing period, trial, grace period, cancellation rules, refund policy and upgrade/downgrade proration still require explicit approval. Do not seed live commercial tiers or automatically assign workspaces before those decisions are recorded.

## Implementation order

1. Keep the existing creator Stars payment and subscription lifecycle stable.
2. Complete the workspace plan catalogue, quotas and read-only billing UI (implemented).
3. Implement provider-agnostic platform checkout/payment lifecycle and separate platform-provider connections.
4. Implement and test the selected external provider adapter.
5. Complete the documented compliance review for the actual sales surface and provider merchant account.
6. Add workspace plan assignment, verified checkout activation, renewal, failure/grace, cancellation, refund and reconciliation flows.
7. Run PostgreSQL integration tests, webhook replay/race tests and provider sandbox end-to-end tests before any production activation.

No merge to main or deployment is implied by this decision.
