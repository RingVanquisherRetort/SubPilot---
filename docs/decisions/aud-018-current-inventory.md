# AUD-018 — verified source inventory (2026-11-23)

Reviewed branch: `feat/subscription-lifecycle-ui`  
Reviewed HEAD: `05e239d576bc41603c37ebb3f2badb38f5dc24da`  
Status: **OPEN — CI green at reviewed HEAD; source review and live Telegram acceptance remain open**

This document records only behavior verified in the source at the exact HEAD above. It is not a claim that every access-changing callsite in the repository has been exhaustively enumerated.

## Current access-side-effect map

| Path | External Telegram effect | Transaction / coordination boundary | Recovery and remaining concern |
|---|---|---|---|
| `apps/api/src/subscription-lifecycle.ts` → `reconcileSubscriptionAccessRemoval` | Dispatches expiry and revoked-grant cleanup through the removal reconciler | Lifecycle pass lease plus customer/chat scope lease; removal reconciler takes short snapshot, claim and finalization transactions | Ordered lifecycle stages stop after lease loss. Remote requests already accepted by Telegram cannot be fenced by a local lease token. |
| `apps/api/src/subscription-access-removal.ts` | `revokeChatInviteLink`, `getChatMember`, then a five-minute `banChatMember` for an ordinary member in a channel/supergroup | Telegram calls are outside interactive DB transactions. Before the timed ban, a short transaction revalidates subscription, grant and scope revision, writes `MEMBER_BAN_IN_PROGRESS`, and inserts `TelegramRemovalIntent`. Groups fail closed to operator review. There is no automatic `unbanChatMember` in this implementation. | The marker prevents recovery from treating an ambiguous existing ban as safe to clear. A request already in flight at Telegram is not cancellable/fenced by the DB lease. The intent lets delivery wait for the timed removal deadline. |
| `apps/api/src/project-bot-updates.ts` — `deliverSubscriptionAccess` | `getChatMember`, `revokeChatInviteLink`, `createChatInviteLink` | Durable customer/chat scope lease; short snapshot and conditional-finalization transactions; external calls outside transactions. It checks unexpired `TelegramRemovalIntent` rows before membership lookup and schedules retry after the latest deadline. | Known unpersisted invite URLs are compensated. A process death after Telegram creates a link but before the response/URL is durably recorded is still an unknown-result window: the compensation worker cannot revoke a URL it never learned. |
| `apps/api/src/project-bot-updates.ts` — chat-member update, admin exclusion | `revokeChatInviteLink` after the DB marks the grant `ADMIN_EXCLUDED` | The transition locks the subscription, grant and customer/chat advisory scope, persists sticky `ADMIN_EXCLUDED`, and increments `desiredRevision`. The Telegram revoke then runs outside the transaction and without a claimed scope lease. | The call targets the exact invite URL captured by the transition; local cleanup also requires that same URL and `ADMIN_EXCLUDED` state. It does not ban/unban membership. This is not lease-token fencing, but source inspection does not show it can revoke a different replacement URL. Add an explicit replacement-generation race test before classifying it as a defect. |
| `apps/api/src/project-bot-updates.ts` — wrong-user/stale invite entry | `revokeChatInviteLink`, `getChatMember`; no automatic member ban/removal in the reviewed branches | The webhook revokes the exact invite URL from the update. Wrong-user recovery re-locks the scope and only resets the grant if its current URL still equals that captured URL and permission remains active. Stale-entry cleanup also conditions its DB update on the captured URL. | The remote call is outside the durable scope lease, but URL-specific targeting and compare-before-reset materially limit cross-generation impact. No automatic member ban/removal is attempted. Add deterministic tests proving a replacement URL survives a delayed old-URL revoke. |
| `apps/api/src/buyer-stars-renewal.ts` via buyer callback/lifecycle | `editUserStarSubscription` | Desired state is stored first; a conditional claim is committed before Telegram I/O; confirmation is conditional on the claim and subscription snapshot. A superseded response queues the latest desired state for replay. | Ambiguous replies remain due for retry. A remote request can outlive its claim; the local requeue repairs toward the latest state but cannot make Telegram calls transactional. |
| `apps/api/src/late-stars-cancellation.ts` via successful receipt/lifecycle | `editUserStarSubscription(is_canceled: true)` | Durable due timestamp is claimed before Telegram I/O; finalization is conditional on the same due timestamp and cancelled subscription/original charge. | Ambiguous results remain due for retry. Duplicate/repeated Telegram replies and a process dying after remote confirmation but before local finalization still need dedicated acceptance/recovery coverage. |
| `apps/control-bot/src/manual-subscription-access-service.ts` | `editUserStarSubscription(is_canceled: true)` | A short transaction snapshots the subscription, charge, bot credentials and access scopes; Telegram I/O runs after commit; a second transaction re-authorizes, re-reads and commits cancellation, audit and scope revisions. | A crash after Telegram confirms cancellation but before the second transaction commits leaves local subscription/access state unchanged. The Telegram star_subscription webhook can persist CANCELED, allowing a later retry to skip the remote call, but recovery currently depends on that update being received/processed. No dedicated crash-boundary test proves this path. |

## Confirmed improvements at this HEAD

- Normal expiry/removal uses the durable customer/chat scope coordinator and short DB transactions; Telegram calls are outside interactive transactions.
- The removal path does not automatically unban. Ambiguous ban ownership is recorded and treated as operator-review state.
- The timed-removal intent is persisted before the Telegram request. Active paid delivery waits for the intent deadline, then re-reads Telegram membership and can issue a fresh return invite if the member is absent.
- A surviving Telegram ban blocks the return invite; the PostgreSQL test named `a moderator ban surviving the timed removal blocks a paid member's return invite` asserts no unban or invite call.
- Buyer Stars renewal and late initial Stars cancellation now use durable due/claim state and execute Telegram I/O outside the transaction. The older statement that these two project-bot calls remain inside interactive transactions is stale for this HEAD.

## Second-pass source findings at HEAD `05e239d`

- **Webhook invite revocation:** the admin-exclusion handler does acquire the customer/chat advisory lock while changing the grant and increments the durable desired revision in the same transaction. It then revokes the captured invite URL outside a claimed lease. The wrong-user and stale-entry handlers likewise target a captured URL; their later database transitions compare that URL against the current grant before clearing it. This is weaker than a full lease protocol, but it is not evidence that a stale webhook can revoke a different replacement URL. The remaining requirement is a deterministic delayed-old-revoke/replacement-link test, not an unproven assertion that all such calls are unsafe.
- **Invite-create unknown result:** the code requests a 24-hour expiry and member_limit 1; the link is sent to the buyer only after its URL is persisted and the current lease is revalidated. If Telegram creates the link but its response is lost, SubPilot never learns or sends that URL, so it cannot revoke it. This is an irreducible orphan-resource window with a bounded Telegram expiry, not a demonstrated buyer-access leak. Preserve this limitation in the operational policy; do not claim exact cleanup is possible.
- **Manual recurring revoke:** the control-bot path correctly keeps Telegram I/O outside DB transactions and rechecks admin rights, subscription identity and charge anchor before committing. If the process dies after Telegram confirms cancellation but before the second transaction commits, the local subscription remains active. The authenticated Telegram star_subscription update can set telegramStarSubscriptionState=CANCELED; a later manual retry then skips the remote call. This recovery dependency needs a PostgreSQL test covering both webhook-before-retry and delayed/missing-webhook behavior.
- **Stars subscription webhook routing:** the authenticated top-level subscription update is parsed and persisted directly. It now returns before grammY's ordinary update dispatcher, which does not route this custom update type and otherwise can throw when botInfo is not initialized. The PostgreSQL test exercises cancellation persistence and rejects an older subsequent update.
- **Manual revoke recovery test:** a simulated lost Telegram response leaves the local subscription active; after the authenticated webhook state is projected as CANCELED, retry completes the local administrative revoke without issuing another Telegram cancellation.
- **Invite-create lost-response test:** a simulated remote acceptance followed by a lost response returns no buyer link, leaves the grant URL empty, and confirms there is no URL available for compensation.
- **Stars retry state:** buyer renewal and late initial cancellation persist due/claim state before Telegram I/O. The late-cancellation PostgreSQL test already simulates a lost response after remote success and proves the cancelled subscription is not reopened. Broader buyer cancel/resume, payment webhook and admin-revoke orderings remain unproven.

## Latest CI validation

GitHub Actions run [45123755090](https://github.com/RingVanquisherRetort/SubPilot---/actions/runs/45123755090) completed successfully for code HEAD `05e239d`: validate passed typecheck and unit tests; upgrade-validation passed legacy schema recreation, forward migrations, data/backfill checks and migration-history verification. This is CI evidence only; no live Telegram/payment API was called.

## P0 risks still open

1. **Remote moderation interleaving during a timed ban.** The DB lease cannot be passed to Telegram as a fencing token. A five-minute ban request may still be outstanding after local ownership/revision changes. Existing tests cover a replacement worker waiting on a persisted removal intent, a moderator exclusion committed while the timed ban is in flight, and a moderator ban that remains after the timed removal; they do not prove every Telegram-side ordering of a moderator action against a delayed ban request. Do not claim this race is eliminated.
2. **Stars/payment ordering and manual revoke recovery.** PostgreSQL coverage now proves the webhook's CANCELED state projection, stale-update rejection, and retry recovery when that state arrives before the operator retry. Still required are payment webhook vs administrative revoke, buyer cancel/resume vs manual revoke, delayed remote responses, duplicate/reordered events, and the manual-revoke path when the webhook is delayed or absent.

## P1 / bounded residuals

1. **Webhook invite URL-generation coverage.** Admin-exclusion and wrong-user/stale-entry handlers revoke captured invite URLs outside a claimed scope lease. The source compares the same URL before local cleanup, so a stale request is not shown to revoke a different replacement URL. Add a delayed-old-URL/replacement-URL test to verify that guarantee.
2. **Invite-create unknown-result window.** If Telegram creates a link but the response is lost, SubPilot cannot know or revoke the URL. The request is one-member, expires after 24 hours, and the URL is not sent before persistence. A PostgreSQL regression test now proves that no URL is exposed or falsely queued for compensation in this case. Keep this as a bounded orphan-resource limitation in the operational policy.

## Required next engineering steps

1. Add deterministic tests for delayed/in-flight timed ban versus moderator permanent ban, renewal/new scope revision and stale worker response. If Telegram semantics cannot guarantee moderator precedence, document the safest product behavior rather than claiming a DB lease can fence Telegram.
2. Add PostgreSQL concurrency and recovery tests for Stars/payment webhook/manual revoke: payment webhook versus admin revoke, buyer cancel/resume versus manual revoke, delayed remote responses, duplicate/reordered events, and webhook arriving after the retry has already begun.
3. Add a delayed old-invite-revoke versus manual re-grant/replacement-invite test; prove the new URL and newer grant state survive.
4. Preserve the documented 24-hour/one-member/not-sent-before-persistence bound for the create-invite unknown-result case.
5. Re-run complete CI on any later code change. No P0 closure, merge to `main`, or production deployment is authorized by this document.
 
## Validation boundary

The branch source was inspected through GitHub at the SHA above. No local test command was run as part of this source inventory, no live Telegram/payment API was contacted, and no production data or secrets were accessed.


## Verification update — 2026-11-23 (integration branch)

The earlier source inventory and CI section above describe the historical HEAD `05e239d`; they are not the latest verification baseline. Subsequent work on `audit-018/integration` has added:

- PostgreSQL tests using the actual `processSuccessfulStarsPayment` handler: a renewal receipt after durable admin-cancel intent, duplicate charge/event idempotency, and an in-flight receipt waiting on the admin's subscription row lock. Owner-review notifications are deduplicated per charge. CI passed at [45254175621](https://github.com/RingVanquisherRetort/SubPilot---/actions/runs/45254175621) (`d794e618`).
- Authenticated Stars buyer cancellation/resume updates, stale update ordering, and newer/older sequence epochs while an admin cancellation remains pending. CI passed at [45254989889](https://github.com/RingVanquisherRetort/SubPilot---/actions/runs/45254989889) (`89c086ff`).
- Recovery from a persisted Telegram cancellation confirmation with pending admin intent after a simulated worker crash: local cancellation and audit finalize without repeating Telegram I/O, and repeated recovery does not duplicate the audit event. CI passed at [45255458268](https://github.com/RingVanquisherRetort/SubPilot---/actions/runs/45255458268) (`8451fd57`).
- A delayed in-flight Telegram membership ban racing with paid renewal. The test asserts stale database finalization is fenced and reconciliation remains due; it explicitly **does not** claim to undo the already-issued Telegram ban. At the time of this note, [45257239067](https://github.com/RingVanquisherRetort/SubPilot---/actions/runs/45257239067) (`0de64de7`) has upgrade-validation success but validate/unit tests are still running.

**Residual safety boundary:** Telegram has no DB revision or fencing-token support for a ban already in flight. A newer paid entitlement may be correct in SubPilot while Telegram still applies an older removal; automatic unbanning could override human moderation. Treat this as an unresolved P0 product/operational tradeoff requiring explicit policy and live controlled tests. The old-invite-URL/replacement-URL race remains a separate P1 acceptance case. These CI runs do not authorize closing AUD-018, deploying, or merging to `main`.


## Acceptance matrix refresh — 2026-11-23

| Area | Automated evidence | Remaining acceptance |
| --- | --- | --- |
| Stars receipt vs admin cancellation | Real receipt handler, concurrent subscription row lock, duplicate charge/event and owner notice: CI `d794e618` passed | Live provider ordering, missing webhook and operator response to unexpected charges |
| Buyer Stars cancel/resume vs admin intent | Authenticated state updates, out-of-order update IDs and sequence epochs: CI `89c086ff` passed | Live Telegram timing and delayed external responses |
| Admin Stars recovery after confirmation | Durable intent with pre-recorded `CANCELED` projection; worker finalizes once without another Telegram call: CI `8451fd57` passed | Process death before webhook confirmation, persistent API failures and alerting |
| In-flight membership ban vs paid renewal | Old worker is fenced from finalizing the renewed grant; reconciliation remains due: CI `0de64de7` passed | Already-issued Telegram ban may still take effect; no automatic unban without proving moderation ownership |
| Old invite URL vs replacement | Delayed expiry cleanup revokes only the captured old URL; replacement grant survives: CI `ad70044e` passed | Authenticated webhook admin-exclusion and wrong-user paths require their own handler-level race tests |
| Moderator-exclusion cleanup vs manual re-grant | New PostgreSQL test `a9ffb6cd` exercises delayed cleanup and replacement grant | CI `45258664267` pending at time of this update; separate live moderation acceptance |

**Do not infer closure from passing simulations.** Keep AUD-018 OPEN until live controlled moderation/Stars acceptance and an explicit operator policy for unresolved remote ban ownership are reviewed. A remote ban cannot be cancelled transactionally by a newer PostgreSQL revision; automatic unban can erase a human moderator's action. Continue preserving the one-member, 24-hour, not-sent-before-persistence boundary for unknown-result invite creation.


## Operator runbook: renewed access after an ambiguous Telegram removal

This is an **interim safety policy**, not proof that Telegram's remote race is solved.

1. If a subscription is paid/ACTIVE but the subscriber remains `kicked` after a delayed removal, **do not automatically unban**. A Telegram moderator may have placed a newer permanent ban while SubPilot's timed removal was in flight.
2. Preserve the current entitlement and the pending customer/chat reconciliation revision in PostgreSQL. Keep the affected grant visible for moderation review; do not mark the old worker's Telegram mutation as successful merely because the database revision advanced.
3. Notify the channel administrator that the paid entitlement and Telegram membership disagree. Ask them to inspect the current Telegram moderation state and determine whether the ban is intentional. A missing or ambiguous Telegram response is **not** evidence of permission to unban.
4. If the administrator confirms a deliberate ban, retain the exclusion and do not send a replacement invite. Resolve billing/refund obligations through the existing subscription policy; do not claim that the paid user has channel access.
5. Only after the administrator explicitly authorizes re-entry and removes any Telegram ban should SubPilot issue a fresh one-member invite under the current scope revision. The buyer must join through that invite. Re-read membership after the action and do not reuse a stale link.
6. Record the decision, affected subscription/chat/customer, observed membership status and the authorized operator action in the incident/audit trail. Reconcile any pending scope; if Telegram remains ambiguous, keep the case open rather than silently restoring membership.

### Test evidence vs handler-level gap

The expiry-worker PostgreSQL tests `ad70044e` and `a9ffb6cd` prove URL-specific remote revocation and replacement-URL preservation for **`reconcileSubscriptionAccessRemoval`**. They do **not** exercise the `chat_member` webhook's admin-exclusion and wrong-user/stale-entry branches in `project-bot-updates.ts`. Those branches capture an invite URL and compare it before clearing a grant, but still need deterministic handler-level tests where the old Telegram call is delayed and a new manual grant is committed concurrently. Keep this as an explicit P1 acceptance gap rather than marking all invite paths complete.

The `a9ffb6cd` CI run [45258664267](https://github.com/RingVanquisherRetort/SubPilot---/actions/runs/45258664267) and matrix update `7dd92611` run [45258954810](https://github.com/RingVanquisherRetort/SubPilot---/actions/runs/45258954810) both passed. These are simulated PostgreSQL tests and migration validation, not live Telegram confirmation.


## Acceptance checkpoint — 2026-11-24 (moderation review rollout)

This checkpoint supersedes the older claim above that the production lifecycle still issues timed member bans. The current integration branch **does not automatically ban joined members in production**: it revokes known invite links and parks unresolved membership in `MEMBER_MODERATION_REVIEW_REQUIRED`. The former timed-ban path requires both `NODE_ENV=development` and `TEST_TELEGRAM_AUTOMATIC_MEMBER_BAN=true` for isolated testing. This is a deliberate safety tradeoff: a still-joined expired subscriber requires an operator to resolve membership in Telegram. Do not advertise automatic removal of joined members as a production-ready guarantee.

The control bot now exposes **Подписки и доступ → Ручная проверка** to authorized administrators. A confirmation checks Telegram membership, locks the subscription/grant/scope, rejects changed revisions and active entitlements, requires revoked or expired invite links, and writes an audit record only when absence was observed. A Telegram `kicked` observation is not proof of a moderator-issued ban; commit `2e0008a1` removed that provenance inference and `b15ad323` added a PostgreSQL regression. Both passed CI.

Commit `0764fe72` adds a PostgreSQL regression for renewal during an outstanding Telegram membership lookup; CI passed. Commit `09074e35` adds two-operator concurrent confirmation coverage; its CI was still running when this checkpoint was authored. Recheck its final conclusion before treating it as accepted.

### Remaining sign-off gates (do not silently waive)

1. **Automated CI:** confirm `09074e35` passes the full validate and upgrade-validation workflows; investigate and fix any failure.
2. **Real Telegram membership:** on an isolated test channel, verify an expired *joined* subscriber is parked without a bot ban; verify an authorized operator sees the case, can confirm only after Telegram reports `left`/`kicked`, and cannot close a still-present member. Verify that an explicit human ban is never automatically lifted. Record test channel, timestamps, actions, and expected/observed states without publishing bot tokens.
3. **Real Telegram Stars:** exercise payment vs admin cancellation, buyer resume/cancel, delayed/missing authenticated update, duplicate notification, and restart recovery. Compare actual Telegram state, subscription DB state, and owner notifications; do not rely on simulated API alone.
4. **Restart recovery and alerting:** prove parked review cases survive a fresh process and remain visible, owner notifications are delivered, and retry/confirmation is idempotent across restart. Include a failed Telegram membership lookup and recovery.
5. **Product decision:** approve the operator-dependent joined-member removal policy and document its service-level implications; otherwise redesign before production. Explicitly accept the bounded 24-hour/one-member unknown-result invite orphan window.
6. **Release control:** obtain explicit authorization for closing AUD-018 and for any subsequent merge to `main` or deployment. These are separate decisions.

**Status: AUD-018 OPEN.** No live Telegram/Stars acceptance or production rollout is claimed by this checkpoint.
