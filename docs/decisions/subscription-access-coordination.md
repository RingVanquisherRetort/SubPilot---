# Subscription access coordination — open architecture review

**Status:** Open — active-scope reconciliation worker and leased invite delivery are implemented; expiry/member removal and recurring cancellation remain  
**Reviewed branch:** `feat/subscription-lifecycle-ui`  
**Reviewed implementation snapshot:** `f226305c655df2f1da388a329294db2ab142fe9b` (CI run `45074857282` passed clean and upgrade migrations, Prisma generation, typecheck and all 190 tests)
**Production status:** Not merged; no live Telegram/provider test has been run as part of this review.

## Why this review exists

The current subscription lifecycle deliberately serializes expiry and successful payment changes by locking the `Subscription` row. This prevents the simple race where expiry checks an old end date, a payment extends the same subscription, and the worker then revokes access based on stale data.

The first implementation had several remote-call/transaction couplings. The invite-delivery path has now been migrated, and the paths now have different transaction boundaries:

- `expireSubscriptions` still holds subscription/grant and customer/chat advisory locks while it may call `revokeChatInviteLink`, `getChatMember`, `banChatMember` and `unbanChatMember`.
- Manual recurring-subscription revocation in `revokeSubscriptionAccessManually` has been staged: credentials and the current subscription are snapshotted in a short transaction, `editUserStarSubscription` runs after commit, and a second short transaction re-authorizes, re-reads the subscription and commits cancellation/audit/revision state.
- `deliverSubscriptionAccess` has been migrated: it snapshots and conditionally finalizes in short transactions, while `getChatMember`, `revokeChatInviteLink` and `createChatInviteLink` execute outside interactive transactions under a durable customer/chat lease.
- The `ADMIN_EXCLUDED` stale-invite cleanup and compromised-invite/member-removal flows perform Telegram calls outside their short snapshot/finalization transactions, but are not yet all fenced by the durable scope lease.

The payment/refund handlers still serialize their local entitlement mutations on the subscription row. The migrated delivery path no longer holds that row lock while waiting for Telegram. Expiry/member removal can still delay subscription mutations. Recurring cancellation can leave local state behind if the process stops after Telegram confirms cancellation.

## Shared customer/chat coordination — first phase implemented

A transaction-scoped PostgreSQL advisory lock now uses the stable key `(customerId, connectedChatId)`, independent of subscription ID. The helper is exported from `@subpilot/payments` so both API and control-bot services use the same lock implementation.

The lock is acquired in the currently inspected paths before their access mutation/reconciliation:
- successful Telegram Stars payment, including both existing grant scopes and the new purchase's destination snapshot;
- delivery of an invite, recording that the buyer is already a member, and confirmation of a Telegram join against a still-current invite;
- expiry/admin-revocation membership reconciliation and the overlapping-entitlement query;
- Telegram `ADMIN_EXCLUDED` membership updates;
- manual/trial grant and manual revocation;
- recovery/rotation of a compromised invite after another Telegram user consumes it.

The manual grant path locks an existing subscription row before taking the scope lock, matching the payment/expiry lock order. New subscription rows are created inside the same transaction before their scope lock is taken. Multi-chat operations acquire distinct scope keys in sorted order.

PostgreSQL integration tests verify that two transactions using the same customer/chat scope serialize even when they represent different subscriptions, while unrelated scopes do not block one another.

This closes the previously identified gap where two different subscriptions could independently decide to change the same buyer's Telegram membership. It does **not** solve the long-transaction problem: the current advisory lock is transaction-scoped and is intentionally held across the existing Telegram calls until the second phase is implemented. Every additional access-changing path must continue to be audited for participation in this shared protocol.

## Constraints that a refactor must preserve

1. A paid renewal must win over an expiry transition that has not yet performed a final, current-state check.
2. A grant revoked for `SUBSCRIPTION_EXPIRED` may be restored by a paid renewal.
3. `ADMIN_REVOKED`, `ADMIN_EXCLUDED` and `LEGACY_UNKNOWN` must not be restored by an ordinary paid renewal.
4. `ADMIN_EXCLUDED` stale invite cleanup remains retryable even if the parent subscription is active, expired or cancelled.
5. Ending one subscription must not remove Telegram membership still authorized by another active subscription for the same customer/chat.
6. Existing Telegram moderation bans must not be undone as a side effect of expiry processing or paid invite delivery.
7. Existing bounded retry/backoff and dead-letter behavior must remain intact.
8. Lifecycle/webhook worker lease loss must not allow a stale worker to finalize state as though it still owned the operation.
9. All mutations that can change the desired Telegram state for the same customer/chat must participate in the same coordination protocol.

## Second phase: durable scope coordinator and out-of-transaction Telegram work

Do not replace the current scope lock with an unlocked read followed by an API call. The second phase must preserve customer/chat serialization while releasing database transactions before Telegram requests.

### Durable coordinator foundation — implemented

The selected storage primitive is `SubscriptionAccessScope`, unique by `(customerId, connectedChatId)`. It stores:

- `desiredRevision` and `appliedRevision` as monotonic PostgreSQL `BIGINT` generations;
- a unique lease token and lease expiry, so an expired or superseded worker cannot finalize;
- retry scheduling, attempt count and a safe error code;
- foreign keys to the project customer and connected chat, with cascade cleanup.

`requestSubscriptionAccessReconciliation` increments the desired revision in the same caller-supplied transaction as an entitlement mutation. `claimNextSubscriptionAccessScope` atomically takes one due scope with `FOR UPDATE SKIP LOCKED`. Heartbeat, success and failure operations are fenced by the current token and unexpired lease. When a newer revision appears while a Telegram operation is in flight, completing the older revision leaves the scope immediately due for another pass rather than marking it settled. Failure stores only a constrained error code; raw provider or Telegram error text is not persisted.

The migration is `20261122200000_subscription_access_scope_lease`. PostgreSQL integration coverage verifies revision coalescing, targeted and background claims, single-owner claims, lease renewal, a new desired revision arriving while a Telegram operation is in flight, stale-owner rejection after lease transfer, retry scheduling, active-entitlement filtering and error-code sanitization. CI run `45073562936` passed migration validation against clean and upgraded PostgreSQL databases, Prisma generation, typecheck and 190/190 tests.

Desired revisions are enqueued transactionally for successful Telegram Stars payment/renewal, manual and trial grants, manual revocation, expiry revocation, Telegram Stars refund reconciliation and selected invite-recovery transitions. The lifecycle worker now consumes up to 25 due scopes per pass when a current active, non-revoked grant exists. It selects an overlapping active entitlement and the source project bot, then calls `deliverSubscriptionAccess` with the already-claimed lease. The delivery function validates the lease and current permission in short transactions; Telegram member lookup and invite revoke/create calls run outside transactions. A heartbeat renews the lease; finalization checks token and revision; a link created after permission changes is revoked as compensation and is not returned as valid access.

**Important:** the active-scope worker handles active-grant delivery/recovery only. Expired/cancelled/admin-revoked membership removal is still performed by the legacy expiry path, which calls Telegram while an interactive DB transaction is open. The manual recurring-cancellation endpoint now calls Telegram between two short transactions, but the payment-webhook-vs-admin-revocation race and process recovery after Telegram confirmation but before local finalization still need dedicated tests/design. Selected admin-exclusion and compromised-invite cleanup calls are outside transactions but are not all fenced by the durable scope lease; AUD-018 therefore remains open.

### Findings from the f226305c review

- `reconcileSubscriptionAccessRemoval` has no callers or direct integration tests. The running expiry job still executes the old transaction. The unused function snapshots overlapping permissions before claiming a lease, so it can claim a newer revision and act on the earlier snapshot. Its final database check cannot undo a completed removal.
- `MEMBER_UNBAN_FAILED` records an earlier failure. It cannot identify who imposed the ban currently visible in Telegram. Connecting this retry to expiry could clear a subsequent moderator ban.
- Delivery must withhold both a link and an already-joined result until the worker confirms its own revision. A successor can settle a different revision. A restricted non-member is an administrative exclusion on both delivery and departure.
- Compensation for an invite created after its grant changed is best effort. Failed cleanup in the stale-result branch has no durable per-link retry record. The active-scope worker also needs to respect the per-grant dead-letter state.
- Two project-bot Stars paths still await `editUserStarSubscription` inside a transaction holding the subscription row lock. One handles a buyer cancelling or resuming renewal. The other handles a late initial recurring receipt on an administratively cancelled subscription. Both need durable recovery and ordering with the payment webhook, in addition to the staged control-bot operation.
- Delivery currently continues after any `getChatMember` exception. Distinguish a confirmed non-member from a transport or permissions failure before relying on that lookup to enforce moderation.
- The payments test entry point discovers all package test files, including the retry/backoff tests.

### Remaining integration work

- Migrate normal expiry/member removal to the durable customer/chat lease. Snapshot the current entitlement, joined/member state, overlapping active grants and moderation state in a short transaction; commit before Telegram; then perform invite revoke and membership removal outside the transaction.
- Add a PostgreSQL race test for a successful payment webhook arriving while staged manual revocation is awaiting Telegram. Define how to recover safely if Telegram confirms cancellation but the final DB transaction fails or the process exits.
- Every entitlement mutation must increment the desired revision in the same transaction. Continue auditing any chat/member/invite state transition that changes the desired state.
- Finalize only when the operation token/revision still matches. If a newer revision was committed while the external operation was in flight, do not overwrite it; schedule reconciliation toward the latest state.
- Keep per-invite-link cleanup distinct from member-removal operations. Revoking an old link must not clear a newer link stored by a later delivery.
- Treat moderation exclusion as a durable deny state. Only an explicit authorized re-grant flow may change that state.
- Define the worker's recovery behavior when its lease expires during an already in-flight Telegram request. A lease token cannot fence Telegram itself, because Telegram does not receive it; conditional finalization and a compensating reconciliation pass must make stale responses harmless.


## Required regression scenarios

- Expiry versus renewal: renewal wins before an expiry operation is committed; no stale revoke is launched.
- In-flight revoke versus renewal: the older Telegram operation completes after a renewal; final database state and recovery work preserve the renewed entitlement.
- Cross-subscription overlap: a second active subscription is created/renewed for the same customer/chat while the first subscription expires; the first expiry must not remove membership still required by the second.
- Admin exclusion versus payment: the grant stays denied after a paid event; stale invite cleanup remains retryable without restoring the grant.
- Link replacement race: a cleanup for an old invite cannot erase a newer invite URL.
- Worker lease loss during an external call: a stale worker cannot commit a stale result; the successor can converge the desired state.
- Duplicate/retried operations: repeated delivery, expiry, admin-exclusion and Telegram webhook events converge idempotently.
- Transient Telegram failures: bounded retry, per-grant isolation and dead-letter behavior remain correct.
- Existing moderation state: kicked and restricted non-member states are preserved.

## Closure criteria

- No interactive database transaction spans a Telegram network call in subscription delivery, expiry/member-removal or recurring-cancellation paths.
- The customer/chat scope is coordinated and durably fenced across every operation that can change Telegram membership or invitation state.
- In-flight stale results are conditionally ignored and reconciled; no active entitlement is silently stranded.
- Admin/moderation denials remain sticky unless explicitly re-authorized.
- All required PostgreSQL race tests, unit tests, typecheck and migration-upgrade validation pass.
- Live Telegram acceptance is a separate later step; green CI must not be described as a live Telegram test.
