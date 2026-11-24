# AUD-018 — controlled live Telegram acceptance

**Status:** NOT EXECUTED. This is an operator checklist, not evidence of a completed live test.

## Preconditions

- Use a dedicated private test channel, a project bot with administrator rights, a separate buyer test account and an owner/admin account. Never share bot tokens or real customer data in chat.
- Confirm the deployed test environment actually runs the current `audit-018/integration` code. Passing GitHub Actions does not mean the bot has been deployed.
- Keep the production-safe default: no automatic member ban. Never enable `TEST_TELEGRAM_AUTOMATIC_MEMBER_BAN` on a production environment.
- Record environment/version/commit SHA, chat ID (privately), test user IDs (privately), time, API result, DB state and screenshot or redacted logs. Do not use real payments unless specifically authorized.

## Acceptance cases

| ID | Procedure | Expected result |
| --- | --- | --- |
| TG-01 | Give a test buyer access, join the channel, then expire/cancel entitlement while the buyer remains joined. Run the access reconciliation worker. | The existing joined member is **not** automatically banned; unresolved membership remains parked as `MEMBER_MODERATION_REVIEW_REQUIRED`. The known invite URL is revoked. |
| TG-02 | As project owner/admin open **Подписки и доступ → 🔎 Ручная проверка**, select the parked case while buyer is still a member. | The bot does not confirm absence or close the case; no `ACCESS_MODERATION_REVIEW_CONFIRMED` audit. |
| TG-03 | Have the test buyer leave the channel, then repeat the case verification. | Telegram reports `left`; the bot confirms once, clears the parked case, writes one audit and queues reconciliation. |
| TG-04 | Create another parked case; have a human moderator ban the test buyer, then verify. | Telegram reports `kicked`; review may close only after DB entitlement/invite checks. It must **not** claim that the ban was issued by the moderator solely from `kicked`, and must not unban. |
| TG-05 | Renew the entitlement or issue a new active grant while a parked case is open. Retry verification. | An active entitlement prevents stale closure. Renewal alone never authorizes unban; a fresh explicit manual grant is tested separately in TG-09. |
| TG-06 | Temporarily revoke the project bot's ability to read membership or disconnect it, then verify; restore permissions and retry. | Failure remains visible and retryable; no premature confirmation. |
| TG-07 | Restart the **actual deployed** control bot and worker with a parked case present, then open the same review and complete it. | Case persists across process restart, operator can resume, and audit remains single-shot. This is **not** proven by an in-process test. |
| TG-08 | Re-enter with a new invite after the owner explicitly clears any human ban and authorizes access. | Only a current-scope invite can be issued; stale links must not restore access. |
| TG-09 | Ban the isolated test buyer, then issue a fresh manual grant as an authorized workspace administrator with Telegram restriction rights. | One scoped unban attempt, confirmed membership absence, fresh invitation delivery and successful join. Record the dispatch audit and invite delivery evidence without exposing the URL. |
| TG-10 | Repeat with a workspace administrator lacking Telegram restriction rights. | No unban dispatch; no access bypass. |
| TG-11 | Cancel the grant while the unban is in flight, using controlled test instrumentation only. | No stale invitation requeue or access restoration; document any remote unban that already occurred. |
| TG-12 | Simulate a lost unban response in the isolated test environment. | No automatic replay of the ambiguous mutation; fresh human authorization is required. |

## Automated evidence (not live acceptance)

CI run [45454540835](https://github.com/RingVanquisherRetort/SubPilot---/actions/runs/45454540835) passed at commit `36aff7368806f44d4377c801afa9baddfab39333`, including the explicit manual unban / fresh invite integration test. TG-09 through TG-12 remain unexecuted against live Telegram.

## Stars/payment acceptance (separate gate)

Use Telegram's supported test environment and isolated test credentials. Exercise first payment, duplicate delivery, buyer cancel/resume, administrative cancellation, missing/delayed update, and process restart after remote success but before local commit. For each case compare Telegram-side state, database state, customer access and deduplicated owner notification. Do not infer these from PostgreSQL mocks.

## Evidence and release decision

For every case mark **PASS / FAIL / BLOCKED**, with timestamp, version, operator and redacted evidence. Record any manual moderation and paid-access mismatch as an incident; do not auto-unban outside the fresh, explicitly authorized manual grant path.

AUD-018 may be proposed for closure only after all required gates pass or a named decision-maker explicitly accepts a documented exception. Merge to `main` and deployment require separate approval.
