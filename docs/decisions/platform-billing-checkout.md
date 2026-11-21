# SubPilot workspace billing checkout

**Status:** external-acquiring product direction accepted; authenticated web checkout and full-refund lifecycle implemented behind a fail-closed launch gate; live merchant, legal and sandbox validation remain open  
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

The current branch now contains an authenticated independent-web checkout and provider-verified one-time payment lifecycle for SubPilot workspace subscriptions:
- `GET /billing` and `GET /billing/return` serve the checkout and return page. Telegram Login Widget assertions are verified server-side; a signed, short-lived, HttpOnly/Secure session cookie identifies the user.
- Checkout endpoints require an authenticated OWNER/ADMIN of the selected workspace, an exact HTTPS Origin, JSON input, an active SubPilot-owned YooKassa connection selected server-side, an active plan and an idempotency key. Browser input cannot select a provider connection or set the eligibility classification.
- Repeated checkout attempts reuse the existing pending payment for the same workspace/plan/provider. A different plan or new charge is blocked while any prior provider payment is still non-terminal, even after its displayed expiry, until a verified provider event settles it. This protects against delayed success notifications causing a second charge.
- Only an authenticated and reconciled provider webhook activates/extends WorkspaceBilling. The browser return page displays current server-side status and is never treated as proof of payment.
- The payment record stores immutable plan/amount/currency/period snapshots and the previous billing-period snapshot needed for a potential refund reconciliation.
- Full refunds can be requested by allowlisted platform operators with `/platformrefund PAYMENT_ID`. The request is idempotent and audited. Access changes only after an authenticated `refund.succeeded` webhook and period-level reconciliation; uncertain or overlapping periods remain in `/platformpaymentreviews`.
- A full-refund event matching the most recent period restores the captured preceding paid/trial period or expires the refunded entitlement when no preceding period existed. A refund for an already-ended period or when a later non-overlapping period is active does not revoke that later access. Partial/mismatched refunds and non-contiguous period histories remain in manual review.

The implementation does **not** yet provide a complete automatic renewal/failure/grace/cancellation lifecycle or payment-provider recurring charge schedule. A customer can initiate a new one-time checkout to extend the same plan; a plan switch while the current period is unexpired is held for manual review. Creating a catalogue plan still does not automatically assign it to workspaces.

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

The code currently implements the YooKassa adapter for SubPilot-owned workspace billing. This does not mean the real merchant account is connected or approved. Do not infer that a provider listed in Nemiling's creator payment matrix is available to SubPilot as a merchant. Verify current onboarding eligibility, SaaS/digital-service category acceptance, recurring billing, webhooks, refunds, chargebacks, settlement, fees, currency, fiscal receipts and legal entity requirements against the provider's own contract and documentation. A test-store credential and the owner's authorization are still required for a real sandbox checkout/refund run.

Commercial plan prices, currency, billing period, trial, grace period, cancellation rules, refund policy and upgrade/downgrade proration still require explicit approval. Do not seed live commercial tiers or automatically assign workspaces before those decisions are recorded.

## Implementation order

1. Keep the existing creator Stars payment and subscription lifecycle stable (existing flow is unchanged).
2. Workspace plan catalogue, quotas, read-only billing UI, authenticated web checkout, YooKassa payment/webhook lifecycle and operator full-refund flow are implemented on the feature branch.
3. Complete the documented compliance review for the actual sales surface and provider merchant account. The web checkout is disabled by default and must stay disabled until this is done.
4. Configure Telegram Login Widget, the exact HTTPS web origin/return URL, a strong session secret and the specific active SubPilot-owned YooKassa connection in the target environment.
5. Run a real YooKassa test-shop payment, duplicate/out-of-order webhook, full refund and partial-refund/manual-review scenario using owner-authorized sandbox credentials.
6. Design and implement recurring renewal, payment failure/grace, cancellation-at-period-end and any required provider scheduling as a separate lifecycle phase.
7. Run end-to-end renewal/access-expiry tests, security review and production acceptance before any deployment or enabling customer-facing checkout.

No merge to main or deployment is implied by this decision.
