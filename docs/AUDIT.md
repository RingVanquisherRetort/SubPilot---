# SubPilot audit register

**Audit branch:** `feat/subscription-lifecycle-ui`  
**Repository:** `RingVanquisherRetort/SubPilot---`  
**Code snapshot reviewed:** `40c151e31814c2652cc5bf1f660cdbc37b7c0eab` (the audit document is updated in a subsequent commit)  
**Base branch:** `main` is intentionally untouched.  
**Purpose:** close the previously requested implementation audit and repair existing behavior; this register is not a new feature roadmap.

## Status meanings

- **Code-confirmed** — the implementation was inspected in source. This does not imply a live Telegram test.
- **CI-tested** — exercised by the current automated test suite / CI run.
- **Defect** — source review identified behavior that needs correction and a regression test.
- **Not implemented** — absent or explicitly described as a future item.

## 1. Repository and documentation

| Item | Status | Evidence / note |
|---|---|---|
| Feature branch remains separate from `main` | Code-confirmed | No merge or deployment performed. |
| Clean PostgreSQL migration + Prisma generation + test suite | CI-tested | Run `44839157646` on `9679a69` passed migrations, Prisma generation, typecheck and 56 tests (56 pass, 0 fail, 0 skipped). |
| README lifecycle-worker description | Corrected | README now describes PostgreSQL lease coordination instead of the obsolete single-process-only instruction. |
| Roadmap channel selection and subscription permissions | Corrected | Interactive channel selection and invite/restrict permission checks are implemented. |
| Roadmap plan editing and plan/chat linking | Corrected | Button-driven title/price/duration editing and linking/unlinking are implemented. |
| Roadmap distributed lifecycle lock | Corrected | PostgreSQL-backed lifecycle lease and heartbeat exist. |
| Roadmap dead-letter monitoring | Still open | Retries exist, but no dedicated dead-letter monitoring or operator recovery interface. |

## 2. Code-confirmed existing functionality

These items have been inspected in source; the table does not claim that every scenario has an automated test.

| Area | Confirmed behavior |
|---|---|
| Central bot privacy | Middleware rejects group/channel updates and keeps the control panel private-chat-only. |
| Workspace and team | Personal/agency workspaces, membership roles, invitations and workspace switching are implemented. |
| Project management | Project create/list/rename/archive/restore and project access checks are implemented. |
| Project bot connection | Token is checked with Telegram `getMe`, encrypted at rest, one active bot per project is enforced, webhook setup requires HTTPS. |
| Tariff management | Create/list/edit/archive/restore and plan-to-chat linking/unlinking are implemented in button and fallback command flows. |
| Connected chats | `my_chat_member` events register channels/groups; a chat is active for subscription access only when required invite/restrict rights are present. |
| Buyer flow | Private-chat plan browsing, purchase terms, Stars invoice, /access and /paysupport flows are implemented. |
| Payment lifecycle | Pre-checkout validation, successful-payment activation, receipt deduplication, refunds and refund reconciliation are implemented for Telegram Stars. Invoice dispatch is serialized under the checkout advisory lock; payment events are bound to the originating project bot. A paid entitlement now persists grants for all destinations in the purchase snapshot, including temporarily inactive chats, so retries can recover them when permissions return. |
| Subscription lifecycle | Expiry, buyer reminders, retryable access delivery/revocation, owner notifications and PostgreSQL worker lease are implemented. Lease loss is handled fail-closed between lifecycle operations; a full lifecycle-worker competing-replica integration test remains open. |
| Payment eligibility | Telegram digital access is restricted to Stars by the policy gate; provider catalog entries do not make an adapter live. |
| Telegram webhooks | Project-bot webhook updates are serialized per bot with a PostgreSQL lease, recorded/deduplicated by update ID and sequence epoch, and protected against stale chat/member status updates. `setWebhook` uses `max_connections: 1` for newly configured project bots. |
| Payment separation | Creator payments, workspace billing and commission entries have separate database models/ledgers. Platform billing models remain separate. A strict versioned quota parser/evaluator and read-only workspace billing screen are implemented. Workspace-row-locked quota enforcement covers project/member/creator-plan creation, invitation acceptance, restoration of archived projects (including the project's active-plan and active-chat caps), restoration of creator plans, and Telegram-confirmed active-chat activation/reactivation. PostgreSQL race tests cover quota contention and invite rollback; the chat activation policy has unit and PostgreSQL integration tests. Allowlisted global platform-plan catalogue administration is implemented with audit logging and immutability once assigned. Authenticated independent-web checkout, Telegram Login Widget verification, short-lived signed sessions, YooKassa webhook reconciliation and operator-only full refunds are implemented behind a fail-closed launch gate. Manual renewal is the intended model; automatic recurring billing is explicitly out of scope. Live merchant onboarding, policy approval and real provider sandbox acceptance remain open. |

## 3. Defects to repair

| ID | Priority | Finding | Required closure |
|---|---|---|---|
| AUD-001 | Resolved in code and CI | All five subscription lifecycle stages now run through a dedicated fail-closed lease runner. Heartbeat renewals cannot overlap; a false renewal or error permanently ends ownership for that pass, prevents later stages from starting, and releases only the caller's own lease ID. PostgreSQL integration tests verify that a second worker cannot start concurrently, loss of ownership during a stage stops subsequent stages, and a stale worker cannot release a successor's lease. | Implemented in `apps/api/src/subscription-lifecycle-runner.ts` and wired into `apps/api/src/subscription-lifecycle.ts`. CI run `44940142109` passed clean PostgreSQL migrations, Prisma generation, typecheck and 140 tests. Live multi-replica load testing remains an operational check. |
| AUD-002 | Resolved | The expiry message distinguishes complete revocation from partial/failed revocation and does not claim access was stopped when it may remain. | Implemented in `apps/api/src/subscription-messages.ts`; regression tests cover both outcomes. |
| AUD-003 | Partially resolved | Owner-notification delivery stops after 10 attempts and preserves the unsent record and last error. The central bot has `/failednotifications` and `/retrynotification ID` commands scoped to the active workspace and restricted to owners/admins. Automated tests cover policy and queue behavior; acceptance testing through a real Telegram bot remains open. | Exercise exhausted retry, error visibility, workspace isolation, role denial and successful requeue through the real central bot. |
| AUD-004 | Partially resolved | The test suite now includes central-bot invite-acceptance helper tests, owner-notification policy tests, Telegram update-order tests, PostgreSQL invoice-dispatch and webhook-lease integration tests. It still lacks full handler tests for central-bot role-gated callbacks, project-bot checkout/refunds and the complete lifecycle worker. | Add focused handler-level tests for critical transitions, permissions, webhook replay and retry behavior. |

| AUD-005 | Resolved | Stars pre-checkout and successful-payment handlers verify that the event came from the project bot recorded in invoice metadata, in addition to checking project, buyer, amount and currency. Legacy rows without the origin snapshot remain compatible. | Implemented in `apps/api/src/telegram-payment-origin.ts`; tests cover match, mismatch and legacy metadata. |
| AUD-006 | Resolved | Invoice dispatch records a start marker before calling Telegram, suppresses retries after ambiguous outcomes, and serializes concurrent dispatch claims with the same PostgreSQL advisory key used by checkout creation. The PostgreSQL test verified that three competing transactions produce one claim. | Implemented in `apps/api/src/project-bot-updates.ts`; state tests and PostgreSQL lock test pass. |
| AUD-007 | Resolved in code and CI | Webhook updates are serialized per project bot using the PostgreSQL `WorkerLease` table (5-minute lease, 1-minute heartbeat). Processed updates are recorded by `(projectBotId, sequenceEpoch, updateId)`; duplicate updates are acknowledged without re-running the handler. `chat_member` cursors are maintained per bot/chat/user and `my_chat_member` cursors per chat, so older state changes are ignored. Sequence epoch increments after seven days without updates to handle Telegram's documented random update-ID restart. | Implemented in `apps/api/src/index.ts`, `apps/api/src/telegram-webhook-lease.ts`, `apps/api/src/telegram-update-order.ts` and `apps/api/src/project-bot-updates.ts`; migration and unit/integration checks pass. Live Telegram webhook retry/order behavior is not yet exercised. |

| AUD-008 | Resolved | Owner notifications could be queued and delivered to a project creator after that user had been removed from the workspace. This could disclose subscription/payment activity to a former teammate. | Recipients are checked against current workspace membership when queued and rechecked immediately before sending; queued notifications for removed members are marked terminal. `owner-notifications-policy.test.ts` covers owner, active creator, removed creator and de-duplication. |
| AUD-009 | Resolved | A successful payment could fail to create an access-grant row for a destination that became inactive between invoice creation and successful payment. Without a row, the lifecycle worker had nothing to retry after bot permissions were restored. | Payment activation now persists access grants for all connected destinations in the immutable purchase snapshot, including inactive ones. `subscription-grant-persistence.test.ts` verifies inactive IDs are retained. |
| AUD-010 | Resolved | When an unauthorized user consumed a one-person invite link, Telegram's `INVITE_HASH_EXPIRED` response during revocation was treated as a revocation failure. The original buyer could be left without a fresh link. | Treat the explicit expired-hash response as a completed revocation, mark the compromised grant revoked, and issue a replacement link. Uses the existing `isTelegramInviteAlreadyRevoked` classifier covered by package tests. |

| AUD-011 | Implemented in code and CI; operational acceptance open | SubPilot workspace billing has an independently authenticated web checkout, Telegram Login Widget verification, short-lived signed sessions, server-side workspace/provider/plan authorization, YooKassa webhook reconciliation, period snapshots and an allowlisted operator full-refund workflow. Manual renewal is the intended model; automatic recurring charges are explicitly out of scope. | Snapshot `8ef6708` passed CI run `44928943716` with 138 tests. Provider HTTP calls use deterministic fakes; no live merchant account was exercised. Keep checkout fail-closed until the actual sales surface has documented compliance approval and the owner-authorized YooKassa test-shop journey is completed. |

| AUD-012 | Implemented in code and CI; Telegram acceptance open | Subscription access delivery previously retried indefinitely without an operator-visible terminal state. Each `SubscriptionAccessGrant` now stores attempt count, next retry time, last safe error code and dead-letter time. The lifecycle worker applies bounded exponential backoff (capped at 60 minutes), stops at 10 failures and queues a deduplicated workspace-owner alert. Workspace OWNER/ADMIN users can inspect dead letters with `/faileddeliveries` and request a scoped, audited retry with `/retrydelivery ID`. | Implemented in `packages/payments/src/access-delivery-retry.ts`, `apps/api/src/project-bot-updates.ts`, `apps/api/src/subscription-lifecycle.ts` and `apps/control-bot/src/workspace-access-delivery-service.ts`. CI run `44940898392` passed clean PostgreSQL migration, Prisma generation, typecheck and 141 tests; the PostgreSQL test records ten real failure transitions, verifies the owner alert, workspace isolation, manual recovery and audit entry. Real Telegram delivery/permissions still need smoke testing. |

| AUD-013 | Implemented in code and CI; Telegram acceptance open | Workspace OWNER/ADMIN users can manually grant time-limited or lifetime access, issue one-time trials, list active subscriptions and request early revocation from the central bot. Paid, manual and trial subscriptions have separate `grantType` values; manual/trial grants do not create fake payment rows. Trials are limited to one per project customer and plan. Revocation is queued through the normal lifecycle worker. If another current subscription still grants access to the same chat, membership is preserved and only the ending entitlement's unused invite link is revoked. | Implemented in `apps/control-bot/src/manual-subscription-access-service.ts`, `apps/control-bot/src/bot.ts`, `apps/api/src/subscription-lifecycle.ts` and `apps/api/src/subscription-access-revocation.ts`. CI run `44941775456` passed clean PostgreSQL migrations, Prisma generation, typecheck and 143 tests, including manual grant/extension, trial reuse rejection, role authorization, cancellation/audit records and overlapping-entitlement lookup. Real Telegram permissions and invitation delivery still require smoke testing. |

## 4. Explicitly not implemented / not enabled

| Area | Current status |
|---|---|
| External creator payment adapters (YooMoney, YooKassa, Prodamus, Robokassa, CloudPayments, Crypto Pay, etc.) | Not implemented. Catalog and adapter contracts are scaffolding only. |
| Manual payment-confirmation workflow | Not implemented. |
| Recurring Telegram Stars billing | Not implemented. Current Stars flow is one-time checkout. |
| SubPilot fixed-price workspace billing | Partially implemented: authenticated web checkout, YooKassa success webhook, period extension, full-refund reconciliation, audit logs and manual-review queue exist. Manual one-time renewal is the intended model; automatic recurring charges are out of scope. Real merchant sandbox validation and activation approval are not complete. |
| 7-day / 14% experiment collection | Intentionally dormant; not connected to normal creator payment success. |
| Manual subscription grants/revocation and trial handling | Implemented: `/grantaccess`, `/trialaccess`, `/activesubscriptions` and `/revokeaccess` with OWNER/ADMIN checks, audit logs, unique trial policy and worker-driven revocation. Real Telegram acceptance remains open. |
| AuditLog application writes / audit-history UI | Not implemented; schema exists only. |
| Subscription access-delivery dead-letter monitoring and operator recovery | Implemented: bounded retries, owner alert, workspace-scoped `/faileddeliveries` and audited `/retrydelivery`. Other delivery/notification classes still require their own live acceptance checks. |
| Nemiling-listed monetization extensions such as donations, paid messages/conversations, gifts, promo/referral mechanics, giveaways and broadcasts | Not implemented; these remain outside the current subscription/access baseline. |

## 5. Test evidence and limitations

- The validated code snapshot `9679a69` completed migrations against clean PostgreSQL, generated Prisma Client, passed TypeScript checks and passed 56 tests (56 pass, 0 fail, 0 skipped). This includes PostgreSQL advisory-lock and webhook-lease integration tests.
- `docs/AUDIT.md` and later documentation changes have their own CI runs; verify the latest branch head rather than reusing an earlier green run.
- Code snapshot `7e824d0` completed CI run `44867867807`: clean PostgreSQL migrations, Prisma Client generation, TypeScript checks and 68 tests (68 pass, 0 fail, 0 skipped). The run includes the PostgreSQL lifecycle-lease ownership/expiry integration test. The audit-document-only commit is validated separately.
- Latest platform billing snapshot `8ef6708f1b6e92669d7d3235a5d9ae4e2c72df35` completed CI run `44928943716`: clean PostgreSQL migrations, Prisma Client generation, TypeScript typecheck and 138 tests passed (138 pass, 0 fail, 0 skipped). This includes HTTP route authorization/fail-closed tests, Telegram Login Widget/session tests and a PostgreSQL YooKassa-style integration test covering idempotent checkout, cross-browser retry reuse, payment confirmation, period extension, full refund restoring the previous trial period, partial-refund manual review, and blocking new checkout while refund processing is unresolved. Provider HTTP calls use a deterministic test fake; no live merchant credentials or production PSP account were exercised.
- Manual access lifecycle snapshot `40c151e31814c2652cc5bf1f660cdbc37b7c0eab` completed CI run `44941775456`: clean PostgreSQL migrations, Prisma generation, typecheck and 143 tests passed (143 pass, 0 fail, 0 skipped). PostgreSQL tests cover manual grant and extension, no fake payment record, single-use trial enforcement, OWNER/ADMIN authorization, audited cancellation and preserving a chat entitlement when another active subscription still covers that customer/chat.
- Lifecycle runner snapshot `9fb8493627606567f8b4a42381969cf2d6c8e706` completed CI run `44940142109`: clean PostgreSQL migrations, Prisma generation, typecheck and 140 tests passed (140 pass, 0 fail, 0 skipped). PostgreSQL integration tests cover competing workers, loss of lease during an in-flight stage, stopping later stages and protecting a successor's lease from stale release.
- Latest access-delivery dead-letter snapshot `8d4283546285deca77a302bbcf4fe922b1d1d993` completed CI run `44940898392`: clean PostgreSQL migrations, Prisma generation, typecheck and 141 tests passed (141 pass, 0 fail, 0 skipped). It covers the retry schedule/threshold, real DB transition to dead-letter, owner alert, workspace isolation, audited manual retry and reset back to the worker queue. No real Telegram or merchant API was contacted by these CI tests.
- A green CI run validates the checks configured in `.github/workflows/ci.yml`; it does not prove live BotFather setup, actual Stars payment, Telegram chat permissions or end-to-end subscriber access behavior.
- Workspace quota enforcement snapshot `b0e781d5` completed CI run `44889861256`: clean PostgreSQL migrations, Prisma Client generation, TypeScript checks, and 98 tests passed (98 pass, 0 fail, 0 skipped). The run includes PostgreSQL concurrency tests for project, member/invite, creator-plan and connected-chat quotas; project restoration with nested plan/chat caps; creator-plan restoration; Telegram chat activation/reactivation; and quota-error classification for invite feedback.
- Platform catalogue snapshot `6f74aa9f5f` completed CI run `44890855197`: clean PostgreSQL migrations, Prisma Client generation, TypeScript checks, and 108 tests passed (108 pass, 0 fail, 0 skipped). It includes platform-operator allowlist tests, strict plan-input validation, PostgreSQL tests for audit atomicity and immutable assigned plans, a race test proving plan assignment and deactivation serialize on the same `PlatformPlan` row lock, and paginated catalogue listing.
- No production merge or deployment is authorized by this audit.

## 6. Audit order

1. Complete AUD-001 and AUD-003/AUD-004.
2. Continue the full central-bot role/callback and project-bot payment/access handler review.
3. Verify the platform billing separation and document that workspace billing is not operational yet.
4. Add remaining focused PostgreSQL/handler regression tests where code review identifies a concrete risk.
5. Re-run CI on the final audited branch and update this register with evidence.
