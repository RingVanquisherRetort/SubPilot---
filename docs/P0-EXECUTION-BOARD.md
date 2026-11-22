# SubPilot engineering execution backlog

Scope: branch `feat/subpilot-p0-race-regression`, forked from
`feat/subscription-lifecycle-ui` at `8eb4300557f46d5b532c617f720843a3c6f3200b`.
No changes to `main`, production deployment, payments, refunds or broadcasts.

## Verified baseline

- Baseline branch HEAD at start of investigation:
  `74106cae898d4fd554f49e22ba7e1d6df0d1e0dc`.
- Comparison against `main`: 874 commits ahead, zero behind, 167 changed
  files (GitHub compare endpoint at this snapshot).
- GitHub Actions run
  [45079831678](https://github.com/RingVanquisherRetort/SubPilot---/actions/runs/45079831678)
  completed successfully on that SHA: TypeScript, tests, clean PostgreSQL
  migrations and legacy upgrade validation.
- The upstream feature branch continued changing during review. Do not
  equate the baseline CI success with a green status for later commits.
- The existing `docs/ROADMAP.md` had seven explicit unchecked `- [ ]`
  top-level bullets when counted in this snapshot. Unchecked nested bullets,
  uncheckboxed stage-five items, and operational acceptance criteria are
  **not** included; this is not a definitive total remaining-work count.

## Priority-ordered execution board

| Priority | Work item | Owner | Status | Acceptance |
| --- | --- | --- | --- | --- |
| P0 | AUD-018: expiry and access removal through fenced per-customer/chat reconciliation | Engineering | In progress upstream; not accepted | No Telegram or provider I/O inside interactive DB transactions; all access effects fenced; expiry/renewal/revocation races tested and green |
| P0 | Renewal while Telegram membership lookup is in flight | Engineering | Regression test committed in this branch | Renewal transaction completes before Telegram call resumes; stale revoke never bans; newer desired revision remains due |
| P0 | Crash between ban/unban and moderation ownership ambiguity | Engineering + security review | Open | Crash/restart tests, fail-closed moderation ownership, operator recovery without unbanning third-party bans |
| P0 | Recurring cancellation vs paid webhook and worker lease loss | Engineering | Open | PostgreSQL concurrency tests, recovery after external success before DB commit, idempotency verified |
| P0 | Complete independent CI and live-test matrix | Engineering + QA | Open | Typecheck, unit, PostgreSQL integration, clean and upgrade migrations green; Telegram acceptance with test identities where applicable |
| P1 | Stable recurring, refund/chargeback, paid messages and consultations | Product + engineering | Blocked by P0 | End-to-end verified flows; creator payment ledgers isolated from platform and commission ledgers |
| P1 | Gifts and referral UX/API | Product + engineering | Blocked by P0 | Verified purchases, redemption, recovery, roles and audit |
| P2 | Promotions, segmentation, marketing, international payments and white-label | Product + legal/security | Requires commercial approval | Documented policy, privacy/consent, anti-abuse, approved external-provider model |

## Current P0 increment

File added:
`apps/api/src/subscription-access-removal-race-postgres.test.ts`.

The test uses a fake Telegram membership API blocked on a promise; it
simulates an atomic payment-side renewal and reconciliation revision while
removal is in flight. It asserts no ban/unban occurs after stale generation
detection, the access grant is not revoked, and the renewal is not blocked
by a long database transaction.

This test alone is **not** sufficient to close AUD-018. Integration and CI
results must be reviewed on the exact commit before marking acceptance.
Avoid changing the historical audit acceptance status until then.

## Security boundaries

Keep creator Stars flows, external-platform acquiring and commission
ledgers separate. The Telegram bot must use Stars for digital goods sold
inside Telegram. Platform YooKassa rollout stays fail-closed pending legal
and merchant review. Do not log tokens, Telegram user identifiers or
payment details. Do not infer moderation ban ownership from Telegram
member status alone.
