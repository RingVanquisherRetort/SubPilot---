# SubPilot roadmap

## Stage 1 — Foundation (current branch)

- [x] Create TypeScript monorepo.
- [x] Add API and central Telegram-bot applications.
- [x] Model workspaces, agency membership, projects, customer bots, chats, creator plans, subscriptions and separate billing ledgers.
- [x] Add local PostgreSQL/Redis infrastructure.
- [x] Add a minimal control-bot flow: register Telegram user, create personal workspace, create/list projects.
- [x] Generate Prisma Client and apply the initial baseline against clean PostgreSQL in CI; run TypeScript checks and unit tests.
- [x] Verify forward migration compatibility from the original baseline using representative legacy records and assert data preservation/backfills in CI.

## Stage 2 — Workspace and project management

- [x] Workspace selector and agency membership.
- [x] Create agency workspace from the central bot.
- [x] Invite teammates with role-scoped, one-use Telegram deep links that expire after seven days.
- [x] Enforce the full OWNER/ADMIN/MANAGER/VIEWER permission matrix for role changes; only owners can appoint administrators, admins can manage managers/viewers, and self/owner role changes are blocked.
- [x] Perform workspace role changes, member removal, invite creation/revocation and Telegram-ID member-directory reads through workspace-row-locked transactions with fresh actor-role validation; audit sensitive mutations and restrict `/members` to OWNER/ADMIN.
- [ ] Smoke-test invite, role-change, removal and unauthorized callback/command scenarios with real Telegram accounts for every workspace role.
- [x] Persist each user's active workspace.
- [x] Enforce manager/admin permissions for project operations.
- [x] Add project-scoped MANAGER/VIEWER access for agency projects; agency OWNER/ADMIN retain full access, responsible creators receive implicit MANAGER access only to their assigned project, and other members require explicit project membership.
- [x] Add transactional `/projectmembers`, `/setprojectmember` and `/removeprojectmember` controls; enforce same-agency membership, audit changes and revoke project access atomically when a workspace member is removed.
- [x] Backfill existing agency MANAGER/VIEWER workspace permissions to current projects during migration to preserve access during upgrade.
- [x] Project creation, rename and archive/restore.
- [x] Store a project-level creator merchant category (individual, self-employed, individual entrepreneur or legal entity) and expose it in the payment-method settings.
- [x] Add one active project bot by token; verify with Telegram getMe and enforce one active bot per project.
- [x] Encrypt bot tokens and validate signed webhook secrets.
- [x] Receive my_chat_member updates and register channels/groups.
- [x] Add interactive channel selection and permission checks required for subscription access (invite users and restrict members).

## Stage 3 — Subscription engine

- [x] Create plans with price, currency and duration.
- [x] Automatically link new plans to currently active project chats.
- [x] List, archive and restore plans.
- [x] List connected channels/groups and link/unlink individual chats on a plan.
- [x] Add buyer-facing button menu, tariff list and one-tap Stars checkout.
- [x] Create pending Telegram Stars invoice and subscription records.
- [x] Validate pre-checkout buyer, amount, currency and payment status.
- [x] Display purchase terms before a Stars invoice; expose /terms and /paysupport.
- [x] Activate subscriptions only after successful_payment.
- [x] Persist idempotent payment receipts.
- [x] Issue one-person, 24-hour invite links for plan chats after verified payment.
- [x] Track joins against subscription grants and verify the entrant against the buyer's Telegram ID.
- [x] Detect existing chat membership and track leave/kick updates.
- [x] Let buyers request current invite links again with /access.
- [x] Add payment history and Telegram Stars refund commands.
- [x] Add button-driven project navigation, plan creation, channel/payment views and workspace/team navigation.
- [x] Add button-driven plan editing (title, Stars price, duration) and plan-to-chat linking/unlinking.
- [x] Add advanced access-management controls beyond the current subscription lifecycle: button-driven owner/admin panel for active subscriptions, manual/trial grants, confirmed early revocation and failed-delivery recovery.
- [x] Add scheduled expiry and access-revocation worker.
- [x] Send renewal reminders to buyers approximately three days and one day before expiry.
- [x] Queue new-subscriber, three-day, one-day and expiry notifications for project authors and agency owners.
- [x] Retry owner-notification delivery through the central bot with per-recipient deduplication.
- [x] Extend an active subscription when a buyer renews early.
- [x] Add PostgreSQL-backed distributed lifecycle-worker lease locking across API replicas.
- [x] Retry failed owner-notification and access-delivery operations.
- [x] Add dead-letter monitoring, alerting and operator recovery for exhausted owner notifications and subscription access delivery (10-attempt ceiling, owner alert, workspace-scoped operator retry).
- [x] Manual time-limited/lifetime grants, one-time trials, active-subscription listing and audited early revocation for workspace OWNER/ADMIN; overlapping active entitlements preserve access.

### AUD-018 access coordination — branch hardening (23 November 2026)

- [x] Replace normal expiry Telegram calls inside interactive transactions with short expiry/revision and finalization transactions, plus the durable customer/chat lease.
- [x] Revalidate overlapping entitlements after claiming the lease and fence stale revocation outcomes by generation/token.
- [x] Bring ADMIN_EXCLUDED stale-invite cleanup under the same lease without removing moderator bans.
- [x] Persist a temporary-ban intent before the Telegram removal sequence; never auto-unban an ambiguous moderation state after a crash.
- [x] Add PostgreSQL concurrency tests for in-flight renewal, overlapping access, excluded invites and ban ambiguity.
- [x] Distinguish explicitly absent members from Telegram transport/permission failures before invite delivery.
- [ ] Eliminate remaining project-bot recurring Stars Telegram API calls inside transactions and implement durable crash recovery for cancellation/re-enable.
- [ ] Fence compromised-invite recovery, stale-join ejection and all remaining access-changing webhook side effects.
- [ ] Add Telegram Stars webhook-vs-manual-revocation and worker crash/restart integration tests, plus live Telegram acceptance.
- [ ] Close AUD-018 after fresh end-to-end CI and operator recovery review; **P1 and P2 monetization remain gated until then**.

## Stage 4 — Payments

- [x] Define a shared provider adapter contract and registry in packages/payments.
- [x] Add a conservative provider catalog with creator merchant-type/country research hints and per-product Telegram policy evaluation.
- [x] Add a product/surface-aware Telegram payment eligibility policy and enforce it in the creator Stars checkout.
- [x] Implement one-time Telegram Stars checkout for in-Telegram digital access.
- [x] Verify pre-checkout data and require Telegram successful_payment before activation.
- [x] Add idempotent Stars receipt storage, payment history and refund handling.
- [x] Persist pending access-delivery records and retry failed invite delivery through the lifecycle worker.
- [x] Add access-delivery dead-letter monitoring, owner alert, bounded retries and audited workspace-scoped operator recovery.
- [ ] Implement external provider adapters only for compliant checkout scenarios and eligible merchants/products.
- [x] Subscribe project-bot webhooks to Telegram's subscription state updates and persist ordered ACTIVE/CANCELED/FAILED transitions for recurring Stars checkouts.
- [x] Implement recurring Stars checkout via Telegram invoice links (30-day period), per-charge payment ledger records, Telegram-expiry-based extensions, charge-level idempotency, renewal refund reconciliation and buyer cancellation/re-enable controls.
- [ ] Complete live recurring Stars acceptance with a configured project bot and buyer account, including successful first payment, automatic renewal, buyer cancellation/re-enable, failed renewal, refund and access expiry.
- [x] Keep creator payments isolated from SubPilot platform billing through separate payment, workspace-billing and commission ledgers.

Initial research candidates for creators who are individuals: YooMoney, Crypto Pay and manual confirmation. Nemiling's public matrix lists these for physical persons, but this is reference information only. SubPilot adapters and provider approvals remain pending. YooKassa, Prodamus, Robokassa and CloudPayments are retained as candidates for merchant types listed by the reference matrix (for example, self-employed, individual entrepreneurs or legal entities). None of these external methods can be used to sell Telegram channel/group access or other digital goods/services offered or fulfilled by a Telegram bot/Mini App; Stars remain required. See docs/decisions/creator-payment-model.md.

## Stage 5 — Monetization features

- Donations.
- Paid posts/messages.
- Timed paid conversations/consultations.
- Gift subscriptions.
- Promo codes and referral links.
- Giveaways.
- Broadcasts (optional future feature; no subscriber directory or customer cards).

## Stage 6 — SubPilot billing

- [x] Keep the seven-day/14% concept and calculator isolated as a research experiment; it is not connected to the default creator payment flow.
- [ ] Build the fixed-price platform plan catalogue and workspace feature limits (primary launch revenue model).
  - [x] Define and validate versioned workspace quota configuration for projects, members, plans and connected chats.
  - [x] Add a pure evaluator for a complete workspace usage snapshot and requested quota increments.
  - [ ] Define the initial plan tiers, commercial prices and quota values.
  - [x] Add allowlisted operator commands to inspect, create/update and activate/deactivate catalogue items; audit all mutations and freeze plan terms after the first workspace assignment.
  - [ ] Populate the catalogue with approved commercial tiers and assign a plan to each workspace.
  - [x] Add a read-only control-bot screen for assigned-plan status and live workspace/per-project usage.
  - [x] Enforce workspace project/member limits and per-project creator-plan limits in control-bot mutation paths using workspace-row-locked transactions, including archived-resource restoration.
  - [x] Enforce per-project active connected-chat limits on Telegram-confirmed activation/reactivation using the same workspace lock.
  - [x] Audit resource mutation paths and add PostgreSQL race tests for project/member/plan/chat quotas, invite acceptance and archived-resource restoration, plus Telegram chat activation policy tests.
  - [x] Add allowlisted operator commands to inspect, create/update and activate/deactivate catalogue items; audit all mutations and freeze plan terms after first workspace assignment.
  - [x] Fix the product direction: SubPilot workspace billing targets external acquiring, separate from creator payment flows (Nemiling-style provider architecture).
  - [ ] Confirm a compliant sales surface for the digital SaaS subscription; Telegram's Bot Platform Terms require Stars for digital goods/services sold through a bot or Mini App.
  - [ ] Select and verify an external PSP for SubPilot as merchant (SaaS category, recurring billing, webhooks, refunds, settlement, receipts and onboarding).
  - [ ] Approve commercial terms (currency, billing period, trial, grace period, cancellation, refunds and proration).
  - [x] Add a dedicated platform acquiring-connection model and webhook-event ledger, separate from creator project connections and payment events.
  - [x] Add platform payment workspace/plan references, immutable plan terms snapshots, checkout references, expiry and refund retry fields.
  - [x] Add allowlisted operator commands to list, add, rotate, verify and disable SubPilot-owned PSP connections; encrypt credentials and audit all mutations without storing secrets in audit metadata.
  - [x] Add provider credential verification contract and credential-version compare-and-set to prevent stale verification from activating rotated credentials.
  - [x] Add a provider-agnostic normalized-event guard for exact payment-reference, provider payment ID, amount and currency matching; route duplicate and out-of-order events safely.
  - [x] Implement authenticated independent-web SubPilot workspace checkout, YooKassa payment verification, idempotency, manual one-time renewal, full-refund period reconciliation and operator manual-review queue (live merchant sandbox and compliance approval remain open).
  - [ ] Complete owner-authorized YooKassa test-store payment/refund validation and verify merchant onboarding, receipts and reconciliation before customer-facing activation.
- [x] Implement one-time workspace payment status transitions, paid-period extension and period-aware full-refund handling. Manual renewal is the product decision; automatic recurring charges/grace scheduling are not required.
- [x] Add the separate hosted YooKassa platform checkout and reconciliation path; creator payment records/credentials remain isolated. Live merchant acceptance, invoices/receipts and production reconciliation remain to be validated.
- [ ] Reconsider the 14% offer only after a separate legal, provider, currency and commercial review; do not debit creator Stars.
- [ ] Decide whether upgrade/downgrade, proration or grace-period behavior is needed after commercial policy approval. The current launch model is manual one-time renewal, holds plan switches during an unexpired paid period for manual review, and has no automatic renewal/grace scheduler.

## Stage 7 — Agency and analytics

- [x] Multi-creator portfolio: assign each agency project to a responsible workspace creator and list projects grouped by creator.
- [x] Role-based workspace access (OWNER/ADMIN/MANAGER/VIEWER) plus project-scoped MANAGER/VIEWER permissions for agency workspaces.
- [x] Creator/project navigation: agency portfolio, project list and project detail selection.
- [x] Agency-wide analytics in `/agencystats [DAYS]`: active/new subscriptions, cross-project unique subscribers, trials/manual grants, expiry/cancellation churn, renewal payments, refunds and currency-separated gross/refund/net totals, with per-project/creator breakdown. Results follow effective project MANAGER scope.
- [x] Agency-wide audit history and CSV exports in the central bot; OWNER/ADMIN see the full workspace feed, while other members see only projects where they have effective MANAGER access (responsible-creator assignment or explicit ProjectMember MANAGER grant); a ProjectMember VIEWER grant alone is insufficient.
- [ ] Live Telegram acceptance test for workspace roles, project-member assignment/removal, creator assignment, unauthorized project access, and cleanup after a member is removed.

## Stage 8 — International expansion

- English localization and multi-currency display.
- Market-specific provider configuration.
- United States and Thailand launch review.
- Merchant onboarding, tax and compliance requirements per market.
