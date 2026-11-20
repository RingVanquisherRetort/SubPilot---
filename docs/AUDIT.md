# SubPilot audit register

**Audit branch:** `feat/subscription-lifecycle-ui`  
**Repository:** `RingVanquisherRetort/SubPilot---`  
**Audit snapshot:** `b739ebc292f77a416f0fd895c582ea2156fcb766`  
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
| Clean PostgreSQL migration + Prisma generation + typecheck + unit tests | CI-tested on `b4e1385` | That run passed; documentation commits after it have their own CI runs pending at the time of this snapshot. |
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
| Payment lifecycle | Pre-checkout validation, successful-payment activation, receipt deduplication, refunds and refund reconciliation are implemented for Telegram Stars. |
| Subscription lifecycle | Expiry, buyer reminders, retryable access delivery/revocation, owner notifications and PostgreSQL worker lease are implemented. |
| Payment eligibility | Telegram digital access is restricted to Stars by the policy gate; provider catalog entries do not make an adapter live. |
| Payment separation | Creator payments, workspace billing and commission entries have separate database models/ledgers. |

## 3. Defects to repair

| ID | Priority | Finding | Required closure |
|---|---|---|---|
| AUD-001 | High | If lifecycle lease heartbeat renewal fails or reports that the lease was lost, the worker logs the condition but the active lifecycle pass continues. A second API replica could acquire the expired lease while the first pass is still working. | Stop the old pass safely when lease ownership is lost; add regression coverage for lease loss and multi-worker coordination. |
| AUD-002 | High | On subscription expiry, the buyer-facing message says access has been stopped even when one or more Telegram revocation operations failed. | Make buyer notification reflect actual revocation outcome; add tests for full and partial revocation failure. |
| AUD-003 | Medium | Owner-notification delivery stops after the configured attempt limit; failed records remain in the database, but there is no operator-facing exhausted-retry monitor/recovery path. | Provide a durable, observable failure state and an operator recovery path, or explicitly scope this out of the current release. |
| AUD-004 | Medium | The code-review surface is broader than the automated test suite: there are no dedicated tests for central-bot handlers, project-bot checkout/webhook flows, or the lifecycle worker. | Add focused regression tests around critical transitions, idempotency and permissions. |

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

- The last previously inspected successful CI run before the documentation-only audit corrections completed migrations against clean PostgreSQL, generated Prisma Client, passed TypeScript checks and passed 33 unit tests.
- The new documentation corrections trigger their own CI runs; their result must be checked before treating the current head as CI-green.
- A green CI run validates the checks configured in `.github/workflows/ci.yml`; it does not prove live BotFather setup, actual Stars payment, Telegram chat permissions or end-to-end subscriber access behavior.
- No production merge or deployment is authorized by this audit.

## 6. Audit order

1. Correct source/documentation mismatches.
2. Close AUD-001 and AUD-002 with regression tests.
3. Review all central-bot roles, commands and button callbacks.
4. Review project-bot checkout, webhooks, refunds and access grants.
5. Review lifecycle scheduling, retry behavior and notification delivery.
6. Review platform billing separation and the remaining implementation gaps.
7. Re-run CI on the final audited branch and update this register with evidence.

