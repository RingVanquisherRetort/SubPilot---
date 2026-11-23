# AUD-018 / Direction B — Telegram Stars payments and subscription recovery

**Branch:** `audit-018/payments-recovery`  
**Base commit:** `6f694b12640ef1d80128558fc42f76bd69d35650`  
**Scope:** B1–B5 only. No participant or invite-link implementation changes, no real payments, no deployment, no merge to `main`.  
**Status:** B1–B5 implementation complete; full CI green at code HEAD `6e26c36b819932b196a84b110f76bb2e42a0a427`. AUD-018 remains open pending combined review of directions A and B.

## B1 — Purchase, invoice dispatch and first payment

- Purchase creation persists a pending payment and immutable invoice metadata (project bot, plan, destinations, recurring mode, terms) before calling Telegram.
- Invoice dispatch records a durable start marker before the external send. A lost response is treated as ambiguous and suppresses duplicate invoice sends.
- A pending invoice with any dispatch marker is not locally expired or automatically reissued: Telegram provides no local cancellation/fencing primitive for an already-sent invoice. Only never-dispatched pending payments are expired. Existing legacy cancelled-but-dispatched records are also treated as ambiguous and block replacement invoices.
- A successful late receipt can reactivate an invoice-timed-out subscription. An explicit adminAccessRevokedAt marker distinguishes an administrative revoke from an invoice timeout, so a late payment cannot silently become a paid-but-unfulfilled order.
- Pre-checkout validates the invoice anchor, originating project bot, buyer, amount, currency, project status and destination snapshot.
- Successful-payment processing is serialized on the subscription row and records a charge-keyed webhook event in the same transaction as payment/entitlement changes.
- Existing tests cover invoice dispatch state, checkout destination snapshots, bot-origin validation and PostgreSQL advisory-lock single-claim behavior.
- PostgreSQL webhook coverage now exercises first recurring charge activation/anchor persistence and late successful-payment recovery after local invoice timeout; duplicate first-charge delivery remains one ledger event.

**Remaining boundary:** Telegram's acceptance of an invoice whose send response was lost cannot be queried reliably from the local database. The safe policy is to avoid issuing a duplicate invoice and direct the buyer to the original bot message or support.

## B2 — Initial recurring charge and renewal

- First recurring charge is anchored by Telegram's original charge ID.
- Later charges are separate ledger rows keyed by their Telegram charge ID; the original invoice remains the payload anchor.
- Duplicate/reordered payment updates are serialized and deduplicated by the charge event key.
- A successful payment received after an administrative revoke is recorded for reconciliation but must not reopen or extend the entitlement.
- PostgreSQL tests exercise both an ordinary recurring renewal (including duplicate replay) and a renewal arriving while an admin cancellation intent is pending.

## B3 — Buyer cancellation and resumption

- Buyer cancel/resume is persisted as desired state before `editUserStarSubscription` is called.
- A durable due timestamp and claim fence allow lifecycle-worker retry after an ambiguous response or process restart.
- A stale worker may no longer clear a successor's live claim. If the successor has already finished, the stale response schedules a repair pass.
- A pending administrative cancellation blocks a buyer resume from overriding the administrator's desired state.
- Confirmed manual revocation writes adminAccessRevokedAt; successful-payment processing checks this explicit marker rather than treating every CANCELLED subscription as an admin revoke. Legacy markers are backfilled from access grants, recurring anchors and audit history.
- Existing PostgreSQL coverage exercises ambiguous buyer cancellation and late buyer state changes; the new stale-worker/successor-claim test covers the overlapping remote-request boundary.

## B4 — Refund and entitlement recalculation

- Refund receipts are validated against the original invoice, charge, buyer, bot, currency and amount before reconciliation.
- Payment status, refund event dedupe and entitlement recalculation commit transactionally.
- Partial refunds preserve remaining paid periods; a full refund makes the subscription due for access reconciliation.
- An administratively cancelled subscription is not reopened by a refund. A pending admin cancellation is also preserved.
- PostgreSQL coverage exercises partial/full refund, duplicate refund replay and administrative cancellation preservation. An end-to-end Stars refund-handler test now validates the actual webhook route and duplicate delivery.

## B5 — Administrative revoke versus payment/webhook and crash recovery

A dedicated durable intent now records:
- pending administrative cancellation;
- source project bot and due time;
- claim token;
- requesting actor and workspace;
- bounded retry count and constrained last-error code.

The manual revoke path commits this intent before Telegram I/O. The lifecycle worker retries due intents after restart. A confirmed `star_subscription` cancellation webhook wakes the worker immediately and invalidates an in-flight claim. Finalization rechecks the same subscription/charge/claim, marks an active subscription cancelled (or preserves a naturally expired/cancelled status), commits the desired access revision and records an audit event. Access is not revoked until Telegram cancellation is confirmed.

Payment renewals and refunds that arrive while this intent is pending cannot extend or restore the entitlement. Buyer resume is blocked while the administrative intent is pending.

Retry policy: 10 failed/unconfirmed attempts with bounded backoff; on exhaustion the intent remains pending but is no longer auto-polled, and an audit event records the exhausted retry budget. A later authorized manual retry resets the budget, including when the subscription has naturally expired while the intent was pending. No automatic access revocation occurs on an unconfirmed Telegram cancellation.

## Files changed in Direction B

- `apps/api/src/buyer-stars-renewal.ts`
- `apps/api/src/project-bot-updates.ts`
- `apps/api/src/subscription-access-removal-postgres.test.ts`
- `apps/api/src/subscription-lifecycle.ts`
- `apps/api/src/telegram-stars-refund-reconciliation.ts`
- `apps/api/src/telegram-stars-refund-reconciliation-postgres.test.ts`
- `apps/api/src/telegram-invoice-state.ts`
- `apps/api/src/telegram-invoice-state.test.ts`
- `apps/control-bot/src/manual-subscription-access-service.ts`
- `apps/control-bot/src/manual-subscription-access-service.test.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261123140000_admin_stars_cancel_intent/migration.sql`
- `packages/database/prisma/migrations/20261123150000_admin_access_revocation_marker/migration.sql`
- `packages/payments/package.json`
- `packages/payments/src/admin-stars-cancellation.ts`
- `packages/payments/src/index.ts`
- `.github/workflows/ci.yml`

## New regression coverage

- A stale Stars worker cannot clear a successor claim while its Telegram request is in flight.
- A successful Stars payment arriving after the local pending-payment timeout reactivates the entitlement unless an explicit admin-revocation marker exists.
- The first recurring charge creates the durable original-charge anchor and activates exactly once; a later recurring charge creates one period-specific ledger row and extends to Telegram's expiration date.
- A successful Stars payment arriving after a confirmed admin revoke remains recorded but cannot reopen access.
- PostgreSQL stale-payment cleanup leaves any possibly dispatched invoice pending and cancels only never-dispatched payments; invoice-state unit tests cover the ambiguity gate.
- A pending admin cancellation prevents a buyer resume from changing the desired Telegram state back to active.
- An authenticated Stars cancellation webhook wakes a pending admin revoke for worker finalization.
- A recurring Stars payment arriving during admin cancellation is recorded but cannot restore access.
- A refund arriving while an admin cancellation intent is pending cannot recalculate or reopen the entitlement.
- The authenticated Telegram Stars refund handler reconciles the original charge and ignores duplicate delivery.
- Manual administrative cancellation survives a lost Telegram response and can be completed by the lifecycle worker after restart without relying on the webhook.
- The admin cancellation retry budget exhausts after 10 unconfirmed attempts, remains auditable, and can be explicitly retried after natural expiry.

## CI validation

GitHub Actions run [45151832794](https://github.com/RingVanquisherRetort/SubPilot---/actions/runs/45151832794) passed on code HEAD `6e26c36b819932b196a84b110f76bb2e42a0a427`:
- `validate`: TypeScript typecheck passed; 230 tests passed, 0 failed, 0 skipped.
- `upgrade-validation`: clean PostgreSQL migrations, Prisma generation, legacy baseline recreation, forward migration and data/backfill validation passed.

This is automated PostgreSQL/CI evidence only, not a live Telegram or payment acceptance test.

## Residual risks / acceptance limits

1. Telegram does not provide a database fencing token or compare-and-swap for `editUserStarSubscription`. Local claim tokens fence database finalization only. A remote request already in flight cannot be cancelled; retries converge toward the durable desired state.
2. If Telegram accepted cancellation but both its response and the authenticated subscription update are permanently lost, the worker retries the same cancellation intent. After 10 unconfirmed attempts it stops automatic retries and leaves an auditable pending intent for operator retry; the entitlement remains in its current state (ACTIVE or naturally EXPIRED) until confirmation.
3. Telegram Stars invoice creation, actual charge capture, real renewal timing, real refund delivery, webhook retry ordering and the remote effects of `editUserStarSubscription` cannot be proven by PostgreSQL mocks/CI.
4. A dispatched invoice cannot be revoked by the local worker. It is therefore retained as pending indefinitely and blocks automatic replacement; if the buyer cannot find the original invoice message, operator support is required. A payment received after an explicit admin revoke is recorded and flagged for review; the local system cannot prevent Telegram from charging an already-issued invoice.
5. No real Telegram or payment-provider operation was performed. Live acceptance remains a separate gated activity.
6. This document does not close AUD-018. Direction A and the combined P0 review remain required.
