# AUD-018 / Direction B — Telegram Stars payments and subscription recovery

**Branch:** `audit-018/payments-recovery`  
**Base commit:** `6f694b12640ef1d80128558fc42f76bd69d35650`  
**Scope:** B1–B5 only. No participant or invite-link implementation changes, no real payments, no deployment, no merge to `main`.  
**Status:** Implementation in progress; full CI result pending. AUD-018 remains open pending combined review of directions A and B.

## B1 — Purchase, invoice dispatch and first payment

- Purchase creation persists a pending payment and immutable invoice metadata (project bot, plan, destinations, recurring mode, terms) before calling Telegram.
- Invoice dispatch records a durable start marker before the external send. A lost response is treated as ambiguous and suppresses duplicate invoice sends.
- Pre-checkout validates the invoice anchor, originating project bot, buyer, amount, currency, project status and destination snapshot.
- Successful-payment processing is serialized on the subscription row and records a charge-keyed webhook event in the same transaction as payment/entitlement changes.
- Existing tests cover invoice dispatch state, checkout destination snapshots, bot-origin validation and PostgreSQL advisory-lock single-claim behavior.

**Remaining boundary:** Telegram's acceptance of an invoice whose send response was lost cannot be queried reliably from the local database. The safe policy is to avoid issuing a duplicate invoice and direct the buyer to the original bot message or support.

## B2 — Initial recurring charge and renewal

- First recurring charge is anchored by Telegram's original charge ID.
- Later charges are separate ledger rows keyed by their Telegram charge ID; the original invoice remains the payload anchor.
- Duplicate/reordered payment updates are serialized and deduplicated by the charge event key.
- A successful payment received after an administrative revoke is recorded for reconciliation but must not reopen or extend the entitlement.
- The new PostgreSQL regression test exercises a recurring renewal arriving while an admin cancellation intent is pending.

## B3 — Buyer cancellation and resumption

- Buyer cancel/resume is persisted as desired state before `editUserStarSubscription` is called.
- A durable due timestamp and claim fence allow lifecycle-worker retry after an ambiguous response or process restart.
- A stale worker may no longer clear a successor's live claim. If the successor has already finished, the stale response schedules a repair pass.
- A pending administrative cancellation blocks a buyer resume from overriding the administrator's desired state.
- Existing PostgreSQL coverage exercises ambiguous buyer cancellation and late buyer state changes; the new stale-worker/successor-claim test covers the overlapping remote-request boundary.

## B4 — Refund and entitlement recalculation

- Refund receipts are validated against the original invoice, charge, buyer, bot, currency and amount before reconciliation.
- Payment status, refund event dedupe and entitlement recalculation commit transactionally.
- Partial refunds preserve remaining paid periods; a full refund makes the subscription due for access reconciliation.
- An administratively cancelled subscription is not reopened by a refund. A pending admin cancellation is also preserved.
- Existing PostgreSQL coverage exercises partial/full refund, duplicate refund replay and administrative cancellation preservation.

## B5 — Administrative revoke versus payment/webhook and crash recovery

A dedicated durable intent now records:
- pending administrative cancellation;
- source project bot and due time;
- claim token;
- requesting actor and workspace;
- bounded retry count and constrained last-error code.

The manual revoke path commits this intent before Telegram I/O. The lifecycle worker retries due intents after restart. A confirmed `star_subscription` cancellation webhook wakes the worker immediately and invalidates an in-flight claim. Finalization rechecks the same subscription/charge/claim, marks the subscription cancelled, commits the desired access revision and records an audit event. Access is not revoked until Telegram cancellation is confirmed.

Payment renewals and refunds that arrive while this intent is pending cannot extend or restore the entitlement. Buyer resume is blocked while the administrative intent is pending.

Retry policy: 10 failed/unconfirmed attempts with bounded backoff; on exhaustion the intent remains pending but is no longer auto-polled, and an audit event records the exhausted retry budget. A later authorized manual retry resets the budget. No automatic access revocation occurs on an unconfirmed Telegram cancellation.

## Files changed in Direction B

- `apps/api/src/buyer-stars-renewal.ts`
- `apps/api/src/project-bot-updates.ts`
- `apps/api/src/subscription-access-removal-postgres.test.ts`
- `apps/api/src/subscription-lifecycle.ts`
- `apps/api/src/telegram-stars-refund-reconciliation.ts`
- `apps/control-bot/src/manual-subscription-access-service.ts`
- `apps/control-bot/src/manual-subscription-access-service.test.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261123140000_admin_stars_cancel_intent/migration.sql`
- `packages/payments/package.json`
- `packages/payments/src/admin-stars-cancellation.ts`
- `packages/payments/src/index.ts`
- `.github/workflows/ci.yml`

## New regression coverage

- A stale Stars worker cannot clear a successor claim while its Telegram request is in flight.
- An authenticated Stars cancellation webhook wakes a pending admin revoke for worker finalization.
- A recurring Stars payment arriving during admin cancellation is recorded but cannot restore access.
- Manual administrative cancellation survives a lost Telegram response and can be completed by the lifecycle worker after restart without relying on the webhook.

## Residual risks / acceptance limits

1. Telegram does not provide a database fencing token or compare-and-swap for `editUserStarSubscription`. Local claim tokens fence database finalization only. A remote request already in flight cannot be cancelled; retries converge toward the durable desired state.
2. If Telegram accepted cancellation but both its response and the authenticated subscription update are permanently lost, the worker retries the same cancellation intent. After 10 unconfirmed attempts it stops automatic retries and leaves an auditable pending intent for operator retry; the subscription remains active until confirmation.
3. Telegram Stars invoice creation, actual charge capture, real renewal timing, real refund delivery, webhook retry ordering and the remote effects of `editUserStarSubscription` cannot be proven by PostgreSQL mocks/CI.
4. No real Telegram or payment-provider operation was performed. Live acceptance remains a separate gated activity.
5. This document does not close AUD-018. Direction A and the combined P0 review remain required.
