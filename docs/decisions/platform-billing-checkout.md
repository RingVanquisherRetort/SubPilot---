# SubPilot workspace billing checkout

**Status:** architecture proposal; not yet approved for production checkout  
**Reviewed:** 2026-11-21  
**Scope:** fixed-price SubPilot workspace subscriptions

## Current implementation boundary

The PlatformPlan catalogue can now be managed by explicitly allowlisted platform operators. Assigned plans are immutable, catalogue changes are audited, and plan assignment/deactivation operations share a row-lock protocol. Workspace quota enforcement is implemented.

The billing models are still schema groundwork only:
- WorkspaceBilling has no pending-checkout state or explicit cancellation-at-period-end state.
- PlatformPayment has no first-class relation to the plan being purchased, Telegram payer ID, or immutable checkout snapshot fields.
- No control-bot handler creates platform invoices, answers platform pre_checkout_query, processes platform successful_payment, cancels a recurring platform subscription, or reconciles refunds.
- No platform payment lifecycle worker or checkout expiry/recovery flow is implemented.

Creating a catalogue plan does not assign it, collect money or unlock quotas.

## Telegram policy and technical constraints

The SubPilot workspace service is configured and operated through a Telegram bot. If the workspace subscription is offered as a digital service inside that Telegram bot or a Mini App, Telegram's Bot Platform Developer Terms require digital goods and services in the TPA to be paid exclusively in Telegram Stars (XTR). See:
- https://telegram.org/tos/bot-developers
- https://core.telegram.org/bots/payments-stars

For recurring bot subscriptions, the current Bot API requires:
- currency = XTR;
- subscription_period = 2,592,000 seconds (30 days);
- a recurring subscription amount no greater than 10,000 Stars.

References:
- https://core.telegram.org/bots/api#sendinvoice
- https://core.telegram.org/bots/api#successfulpayment
- https://core.telegram.org/bots/api#edituserstarsubscription

The Bot API sends a pre_checkout_query before payment; the bot must answer within 10 seconds. On payment success, the bot receives successful_payment; recurring payments include fields such as is_recurring, is_first_recurring and subscription_expiration_date. The first Telegram payment charge ID is also required for refund/cancellation operations.

Telegram requires bots selling digital services to handle /paysupport requests. Stars refunds are performed with refundStarPayment; automatic renewal can be cancelled or re-enabled using editUserStarSubscription while the current period remains active. See:
- https://core.telegram.org/bots/payments-stars
- https://core.telegram.org/bots/api#refundstarpayment
- https://core.telegram.org/bots/api#edituserstarsubscription

These restrictions are current as checked on 2026-11-21. Re-check Telegram's documentation before enabling checkout.

## Recommended launch route

**Recommended for approval:** sell the SubPilot workspace subscription in the central control bot using recurring Telegram Stars, monthly only.

Under this route:
1. Price is stored and displayed as an integer number of XTR Stars. Do not convert XTR to RUB or infer a fiat value.
2. Recurring plans use exactly 30 days and stay within Telegram's current 10,000-Star per-period limit.
3. The owner/admin chooses an active catalogue plan from the private control bot and receives a Telegram invoice.
4. The bot answers pre-checkout only after checking the exact user, invoice payload, payment record, plan, amount, currency and current assignment state.
5. The workspace becomes ACTIVE only after a matching, verified successful_payment update is committed.
6. Renewal events are idempotently recorded as separate PlatformPayment rows; WorkspaceBilling.currentPeriodEnd is updated from Telegram's subscription-expiration timestamp.
7. Cancellation disables future renewal but does not revoke access before the paid period ends. The expiry worker then changes the workspace billing state and quota enforcement denies new resource activation.
8. Refunds are explicit, audited and tied to the stored Telegram charge ID. /paysupport must be available in the central bot.

This recommendation applies only to the workspace plan sold through Telegram. It does not change creator-side payments: creator revenue and creator Stars balances remain separate.

## Checkout data and transaction design

Before enabling the invoice button, add and test:
- a PENDING workspace billing/checkout state that never grants quota access;
- an explicit platformPlanId or immutable plan snapshot on each platform payment;
- the Telegram payer ID, first recurring charge ID and cancellation/renewal state on the workspace billing record;
- unique constraints/idempotency for Telegram payment charge IDs and invoice payloads;
- pending-invoice expiry and retry behavior;
- transactional plan assignment that locks the workspace row and PlatformPlan row in a consistent order;
- webhook/update replay protection and exact checks for XTR, integer amount and matching workspace/plan/user;
- a lifecycle worker for period expiry and reconciliation of Telegram subscription state.

The PlatformPlan catalogue may retain drafts for future non-Telegram channels, but a plan must not be offered for Telegram checkout unless its currency, amount and billing period satisfy the above Stars constraints.

## Commercial choices still requiring approval

No prices, free-trial duration, grace period, refund policy beyond Telegram's required payment support, or upgrade/downgrade proration rules are inferred by this proposal. Do not seed commercial plan tiers or assign plans automatically until these terms are approved.

If the intended sale is through a genuinely separate independent website rather than the Telegram TPA, that is a different checkout design and requires a separate compliance review of whether the product is genuinely independent from what the bot offers, promotes or fulfills. Do not use an external PSP as a workaround for Telegram's Stars requirement.
