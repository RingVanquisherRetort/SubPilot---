# SubPilot audit register

**Audit branch:** `feat/subscription-lifecycle-ui`  
**Repository:** `RingVanquisherRetort/SubPilot---`  
**Audit snapshot:** `9679a697136d889a05dea62e62e9c21c87bcbd72`  
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
| Payment lifecycle | Pre-checkout validation, successful-payment activation, receipt deduplication, refunds and refund reconciliation are implemented for Telegram Stars. Invoice dispatch is serialized under the checkout advisory lock, and payment events are bound to the originating project bot. |
| Subscription lifecycle | Expiry, buyer reminders, retryable access delivery/revocation, owner notifications and PostgreSQL worker lease are implemented. Lease loss is handled fail-closed between lifecycle operations; a full lifecycle-worker competing-replica integration test remains open. |
| Payment eligibility | Telegram digital access is restricted to Stars by the policy gate; provider catalog entries do not make an adapter live. |
| Telegram webhooks | Project-bot webhook updates are serialized per bot with a PostgreSQL lease, recorded/deduplicated by update ID and sequence epoch, and protected against stale chat/member status updates. `setWebhook` uses `max_connections: 1` for newly configured project bots. |
| Payment separation | Creator payments, workspace billing and commission entries have separate database models/ledgers. Platform billing models and the 7-day/14% calculator are schema/utility groundwork only; no runtime platform billing flow exists. |

## 3. Defects to repair

| ID | Priority | Finding | Required closure |
|---|---|---|---|
| AUD-001 | Partially resolved | The worker treats a false heartbeat or heartbeat error as loss of ownership, stops subsequent lifecycle phases and checks lease ownership between batch items and Telegram access-delivery actions. If ownership is lost after a new invite is created, the invite is revoked instead of being persisted. | Add a PostgreSQL-backed integration test for competing lifecycle-worker lease owners and expiry. Current tests cover the guard state but not the full worker lease race. |
| AUD-002 | Resolved | The expiry message distinguishes complete revocation from partial/failed revocation and does not claim access was stopped when it may remain. | Implemented in `apps/api/src/subscription-messages.ts`; regression tests cover both outcomes. |
| AUD-003 | Medium | Owner-notification delivery stops after the configured attempt limit; failed records remain in the database, but there is no operator-facing exhausted-retry monitor/recovery path. | Provide a durable, observable failure state and an operator recovery path, or explicitly scope this out of the current release. |
| AUD-004 | Partially resolved | The test suite now includes central-bot invite-acceptance helper tests, owner-notification policy tests, Telegram update-order tests, PostgreSQL invoice-dispatch and webhook-lease integration tests. It still lacks full handler tests for central-bot role-gated callbacks, project-bot checkout/refunds and the complete lifecycle worker. | Add focused handler-level tests for critical transitions, permissions, webhook replay and retry behavior. |

| AUD-005 | Resolved | Stars pre-checkout and successful-payment handlers verify that the event came from the project bot recorded in invoice metadata, in addition to checking project, buyer, amount and currency. Legacy rows without the origin snapshot remain compatible. | Implemented in `apps/api/src/telegram-payment-origin.ts`; tests cover match, mismatch and legacy metadata. |
| AUD-006 | Resolved | Invoice dispatch records a start marker before calling Telegram, suppresses retries after ambiguous outcomes, and serializes concurrent dispatch claims with the same PostgreSQL advisory key used by checkout creation. The PostgreSQL test verified that three competing transactions produce one claim. | Implemented in `apps/api/src/project-bot-updates.ts`; state tests and PostgreSQL lock test pass. |
| AUD-007 | Resolved in code and CI | Webhook updates are serialized per project bot using the PostgreSQL `WorkerLease` table (5-minute lease, 1-minute heartbeat). Processed updates are recorded by `(projectBotId, sequenceEpoch, updateId)`; duplicate updates are acknowledged without re-running the handler. `chat_member` cursors are maintained per bot/chat/user and `my_chat_member` cursors per chat, so older state changes are ignored. Sequence epoch increments after seven days without updates to handle Telegram's documented random update-ID restart. | Implemented in `apps/api/src/index.ts`, `apps/api/src/telegram-webhook-lease.ts`, `apps/api/src/telegram-update-order.ts` and `apps/api/src/project-bot-updates.ts`; migration and unit/integration checks pass. Live Telegram webhook retry/order behavior is not yet exercised. |

| AUD-008 | Resolved | Owner notifications could be queued and delivered to a project creator after that user had been removed from the workspace. This could disclose subscription/payment activity to a former teammate. | Recipients are checked against current workspace membership when queued and rechecked immediately before sending; queued notifications for removed members are marked terminal. `owner-notifications-policy.test.ts` covers owner, active creator, removed creator and de-duplication. |

## 4. Explicitly not implemented / not enabled

| Area | Current status |
|---|---|
| External creator payment adapters (YooMoney, YooKassa, Prodamus, Robokassa, CloudPayments, Crypto Pay, etc.) | Not implemented. Catalog and adapter contracts are scaffolding only. |
| Manual payment-confirmation workflow | Not implemented. |
| Recurring Telegram Stars billing | Not implemented. Current Stars flow is one-time checkout. |
| SubPilot fixed-price workspace billing checkout and lifecycle | Not implemented; schema groundwork exists, but no complete billing flow. |
| 7-day / 14% experiment collection | Intentionally dormant; not connected to normal creator payment success. |
| Manual subscription grants/revocation and trial handling | Not implemented. |
| AuditLog application writes / audit-history UI | Not implemented; schema exists only. |
| Dead-letter monitoring and operator recovery | Not implemented. |
| Nemiling-listed monetization extensions such as donations, paid messages/conversations, gifts, promo/referral mechanics, giveaways and broadcasts | Not implemented; these remain outside the current subscription/access baseline. |

## 5. Test evidence and limitations

- The validated code snapshot `9679a69` completed migrations against clean PostgreSQL, generated Prisma Client, passed TypeScript checks and passed 56 tests (56 pass, 0 fail, 0 skipped). This includes PostgreSQL advisory-lock and webhook-lease integration tests.
- `docs/AUDIT.md` and later documentation changes have their own CI runs; verify the latest branch head rather than reusing an earlier green run.
- A green CI run validates the checks configured in `.github/workflows/ci.yml`; it does not prove live BotFather setup, actual Stars payment, Telegram chat permissions or end-to-end subscriber access behavior.
- No production merge or deployment is authorized by this audit.

## 6. Audit order

1. Complete AUD-001 and AUD-003/AUD-004.
2. Continue the full central-bot role/callback and project-bot payment/access handler review.
3. Verify the platform billing separation and document that workspace billing is not operational yet.
4. Add remaining focused PostgreSQL/handler regression tests where code review identifies a concrete risk.
5. Re-run CI on the final audited branch and update this register with evidence.
