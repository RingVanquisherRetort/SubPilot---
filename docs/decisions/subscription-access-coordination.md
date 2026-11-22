# Subscription access coordination — open architecture review

**Status:** Open — design and implementation required  
**Reviewed branch:** `feat/subscription-lifecycle-ui`  
**Reviewed code snapshot:** `adffff67daf859e14f73c77703ec57512eecf1cf`  
**Production status:** Not merged; no live Telegram/provider test has been run as part of this review.

## Why this review exists

The current subscription lifecycle deliberately serializes expiry and successful payment changes by locking the `Subscription` row. This prevents the simple race where expiry checks an old end date, a payment extends the same subscription, and the worker then revokes access based on stale data.

The serialization currently spans remote Telegram API calls, however. That means database transactions can remain open while the worker or payment handler waits on Telegram. The issue exists in more than one path:

- `expireSubscriptions` holds the subscription and grant locks while it may call `revokeChatInviteLink`, `getChatMember`, `banChatMember` and `unbanChatMember`.
- The `ADMIN_EXCLUDED` stale-invite cleanup path also calls `revokeChatInviteLink` inside an interactive transaction.
- `deliverSubscriptionAccess` holds the subscription transaction open while it may call `getChatMember`, `revokeChatInviteLink` and `createChatInviteLink`.

The payment/refund handlers lock the same subscription row. As a result, a slow Telegram response can delay a payment, refund or other subscription mutation for the duration of the transaction. A database rollback also cannot roll back a Telegram API side effect that already succeeded.

## Additional cross-subscription race to close

The expiry path checks whether another active grant exists for the same customer and connected chat. That check protects the ordinary, already-committed overlapping-subscription case.

It does not currently acquire a common lock for the customer/chat pair or lock every competing subscription/grant before acting on Telegram membership. Another subscription can therefore be activated and create its grant after the overlap query but while the expiry worker is carrying out the Telegram removal. The current per-subscription row lock does not serialize two different subscriptions belonging to the same customer.

This is a correctness concern because Telegram membership is shared by all of a customer's entitlements for a particular chat, even though the grant rows are stored per subscription.

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

## Target design to evaluate

Do not replace the current row lock with an unlocked read followed by an API call. A two-phase flow needs a durable operation record and a shared customer/chat coordination boundary.

A viable direction to prototype:

- Introduce a stable coordination identity for `(customerId, connectedChatId)`, independent of subscription ID.
- In a short database transaction, acquire that scope, re-read all relevant active entitlements and grant/moderation state, then persist a desired-state revision plus a uniquely identified operation/outbox record.
- Perform Telegram API calls outside the database transaction.
- Finalize only when the operation/revision still matches. If a newer revision won while the external operation was in flight, do not overwrite it; enqueue or perform a compensating reconciliation toward the latest desired state.
- Keep per-invite-link cleanup distinct from member-removal operations. Revoking an old link must not clear a newer link stored by a later delivery.
- Treat moderation exclusion as a durable deny state. Only an explicit authorized re-grant flow may change that state.
- Define how a worker lease expiry interacts with an already in-flight Telegram request. A lease token alone cannot fence Telegram itself, because Telegram does not receive the token; a stale response must be made harmless through conditional finalization and reconciliation.

The exact storage model (coordination row, operation/outbox table, generation fields, or a combination) must be selected only after the concurrency tests below demonstrate the required behavior. Do not add migration fields speculatively.

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

- No interactive database transaction spans a Telegram network call in the subscription delivery/revocation paths.
- The customer/chat scope is coordinated across every operation that can change Telegram membership or invitation state.
- In-flight stale results are conditionally ignored and reconciled; no active entitlement is silently stranded.
- Admin/moderation denials remain sticky unless explicitly re-authorized.
- All required PostgreSQL race tests, unit tests, typecheck and migration-upgrade validation pass.
- Live Telegram acceptance is a separate later step; green CI must not be described as a live Telegram test.
