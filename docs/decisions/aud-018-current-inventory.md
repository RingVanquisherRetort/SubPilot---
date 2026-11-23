# AUD-018 — verified source inventory (2026-11-23)

Reviewed branch: `feat/subscription-lifecycle-ui`  
Reviewed HEAD: `c36c1bdb0fa45ad4b24fd42b4e668e5fe52c907e`  
Status: **OPEN — source review in progress; no live Telegram acceptance**

This document records only behavior verified in the source at the exact HEAD above. It is not a claim that every access-changing callsite in the repository has been exhaustively enumerated.

## Current access-side-effect map

| Path | External Telegram effect | Transaction / coordination boundary | Recovery and remaining concern |
|---|---|---|---|
| `apps/api/src/subscription-lifecycle.ts` → `reconcileSubscriptionAccessRemoval` | Dispatches expiry and revoked-grant cleanup through the removal reconciler | Lifecycle pass lease plus customer/chat scope lease; removal reconciler takes short snapshot, claim and finalization transactions | Ordered lifecycle stages stop after lease loss. Remote requests already accepted by Telegram cannot be fenced by a local lease token. |
| `apps/api/src/subscription-access-removal.ts` | `revokeChatInviteLink`, `getChatMember`, then a five-minute `banChatMember` for an ordinary member in a channel/supergroup | Telegram calls are outside interactive DB transactions. Before the timed ban, a short transaction revalidates subscription, grant and scope revision, writes `MEMBER_BAN_IN_PROGRESS`, and inserts `TelegramRemovalIntent`. Groups fail closed to operator review. There is no automatic `unbanChatMember` in this implementation. | The marker prevents recovery from treating an ambiguous existing ban as safe to clear. A request already in flight at Telegram is not cancellable/fenced by the DB lease. The intent lets delivery wait for the timed removal deadline. |
| `apps/api/src/project-bot-updates.ts` — `deliverSubscriptionAccess` | `getChatMember`, `revokeChatInviteLink`, `createChatInviteLink` | Durable customer/chat scope lease; short snapshot and conditional-finalization transactions; external calls outside transactions. It checks unexpired `TelegramRemovalIntent` rows before membership lookup and schedules retry after the latest deadline. | Known unpersisted invite URLs are compensated. A process death after Telegram creates a link but before the response/URL is durably recorded is still an unknown-result window: the compensation worker cannot revoke a URL it never learned. |
| `apps/api/src/project-bot-updates.ts` — chat-member update, admin exclusion | `revokeChatInviteLink` after the DB marks the grant `ADMIN_EXCLUDED` | Grant and scope state are updated under DB locks, but the subsequent Telegram invite revocation is not performed under a claimed customer/chat scope lease. | Failed revocation is recorded for retry and the owner is notified. The external effect is not fully fenced against a newer invite generation; finalization is conditional on the exact invite URL. |
| `apps/api/src/project-bot-updates.ts` — wrong-user/stale invite entry | `revokeChatInviteLink`, `getChatMember`; no automatic member ban/removal in the reviewed branches | Invite and entitlement checks use short DB transactions/locks. The wrong-user branch deliberately escalates instead of removing membership. The stale-entry branch rechecks permission/overlap before notifying. | Invite revocation may be retried for admin-excluded grants. Membership removal is intentionally not attempted here because of moderator/concurrent-grant races. This webhook path is not fully coordinated by the durable scope lease. |
| `apps/api/src/buyer-stars-renewal.ts` via buyer callback/lifecycle | `editUserStarSubscription` | Desired state is stored first; a conditional claim is committed before Telegram I/O; confirmation is conditional on the claim and subscription snapshot. A superseded response queues the latest desired state for replay. | Ambiguous replies remain due for retry. A remote request can outlive its claim; the local requeue repairs toward the latest state but cannot make Telegram calls transactional. |
| `apps/api/src/late-stars-cancellation.ts` via successful receipt/lifecycle | `editUserStarSubscription(is_canceled: true)` | Durable due timestamp is claimed before Telegram I/O; finalization is conditional on the same due timestamp and cancelled subscription/original charge. | Ambiguous results remain due for retry. Duplicate/repeated Telegram replies and a process dying after remote confirmation but before local finalization still need dedicated acceptance/recovery coverage. |
| `apps/control-bot/src/manual-subscription-access-service.ts` | `editUserStarSubscription(is_canceled: true)` | The provider call is staged between local transactions rather than held inside the transaction. | Recheck current source and tests for the complete manual-revoke vs incoming-payment race and interrupted finalization; this row alone does not establish that race is closed. |

## Confirmed improvements at this HEAD

- Normal expiry/removal uses the durable customer/chat scope coordinator and short DB transactions; Telegram calls are outside interactive transactions.
- The removal path does not automatically unban. Ambiguous ban ownership is recorded and treated as operator-review state.
- The timed-removal intent is persisted before the Telegram request. Active paid delivery waits for the intent deadline, then re-reads Telegram membership and can issue a fresh return invite if the member is absent.
- A surviving Telegram ban blocks the return invite; the PostgreSQL test named `a moderator ban surviving the timed removal blocks a paid member's return invite` asserts no unban or invite call.
- Buyer Stars renewal and late initial Stars cancellation now use durable due/claim state and execute Telegram I/O outside the transaction. The older statement that these two project-bot calls remain inside interactive transactions is stale for this HEAD.

## P0 risks still open

1. **Remote moderation interleaving during a timed ban.** The DB lease cannot be passed to Telegram as a fencing token. The current five-minute ban is a remote side effect that may still be outstanding after local ownership/revision changes. Existing tests cover a replacement worker waiting on a persisted removal intent and a moderator ban that remains after the timed removal; they do not prove every ordering of a moderator action against a delayed/in-flight Telegram ban request. Do not claim this race is eliminated.
2. **Invite-create unknown-result window.** Telegram invite creation has no local atomic commit with the DB write. The current compensation works only after the response has supplied the URL. Process death or a lost response between remote creation and URL persistence can leave an untracked, one-member, expiring invite. Define bounded exposure and operational policy; do not claim exact automatic cleanup is possible without a Telegram-supported lookup/idempotency primitive.
3. **Webhook invite-security fencing.** Admin-exclusion and wrong-user/stale-entry paths still perform Telegram invite revocation outside the common scope lease. Their local finalization is conditional, but external side effects need an explicit stale-generation policy and race tests.
4. **Stars/payment ordering.** Durable intents improve crash recovery, but add PostgreSQL race tests for payment webhook vs administrative revoke, buyer cancel/resume vs manual revoke, delayed remote responses, duplicate/reordered events, and the late initial receipt path.
5. **Manual revocation recovery.** Verify a durable retry/operator path if Telegram confirms cancellation but the process dies before local audit/revision finalization.

## Required next engineering steps

1. Add deterministic tests for each ordering of (a) timed ban request delayed, (b) moderator permanent ban, (c) renewal/new scope revision, and (d) stale worker response. If Telegram semantics cannot guarantee moderator precedence, choose and document the safest product behavior rather than asserting a false guarantee.
2. Add crash-boundary tests for invite creation: before request, Telegram accepted but response lost, URL received but DB write failed, lease superseded, and compensation failure. Document the irreducible unknown-result window.
3. Fence webhook invite revocation by the same customer/chat generation protocol, or explicitly prove why a conditional URL-specific revoke cannot invalidate a newer credential.
4. Add PostgreSQL concurrency and process-recovery tests for Stars/manual revoke/webhook interactions.
5. Re-run the complete CI workflow on the final audited SHA. No P0 closure, merge to `main`, or production deployment is authorized by this document.

## Validation boundary

The branch source was inspected through GitHub at the SHA above. No local test command was run as part of this source inventory, no live Telegram/payment API was contacted, and no production data or secrets were accessed.
