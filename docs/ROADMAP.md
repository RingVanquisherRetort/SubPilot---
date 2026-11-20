# SubPilot roadmap

## Stage 1 — Foundation (current branch)

- [x] Create TypeScript monorepo.
- [x] Add API and central Telegram-bot applications.
- [x] Model workspaces, agency membership, projects, customer bots, chats, creator plans, subscriptions and separate billing ledgers.
- [x] Add local PostgreSQL/Redis infrastructure.
- [x] Add a minimal control-bot flow: register Telegram user, create personal workspace, create/list projects.
- [x] Generate Prisma Client and apply the initial baseline against clean PostgreSQL in CI; run TypeScript checks and unit tests.

## Stage 2 — Workspace and project management

- [x] Workspace selector and agency membership.
- [x] Create agency workspace from the central bot.
- [x] Invite teammates with role-scoped, one-use Telegram deep links that expire after seven days.
- [x] Persist each user's active workspace.
- [x] Enforce manager/admin permissions for project operations.
- [x] Project creation, rename and archive/restore.
- [x] Add a project bot by token; verify with Telegram getMe.
- [x] Encrypt bot tokens and validate signed webhook secrets.
- [x] Receive my_chat_member updates and register channels/groups.
- [ ] Add interactive channel selection and feature-specific permission checks.

## Stage 3 — Subscription engine

- [x] Create plans with price, currency and duration.
- [x] Automatically link new plans to currently active project chats.
- [x] List, archive and restore plans.
- [x] List connected channels/groups and link/unlink individual chats on a plan.
- [x] Add buyer-facing button menu, tariff list and one-tap Stars checkout.
- [x] Create pending Telegram Stars invoice and subscription records.
- [x] Validate pre-checkout buyer, amount, currency and payment status.
- [x] Activate subscriptions only after successful_payment.
- [x] Persist idempotent payment receipts.
- [x] Issue one-person, 24-hour invite links for plan chats after verified payment.
- [x] Track joins against subscription grants.
- [x] Add payment history and Telegram Stars refund commands.
- [x] Add button-driven project navigation, plan creation, channel/payment views and workspace/team navigation.
- [ ] Add button-driven plan editing and advanced access-management controls.
- [x] Add scheduled expiry and access-revocation worker.
- [x] Send renewal reminders to buyers approximately three days and one day before expiry.
- [x] Queue new-subscriber, three-day, one-day and expiry notifications for project authors and agency owners.
- [x] Retry owner-notification delivery through the central bot with per-recipient deduplication.
- [x] Extend an active subscription when a buyer renews early.
- [ ] Add distributed job locking and delivery retry/dead-letter monitoring.
- [ ] Manual grants, manual revocation and trials.

## Stage 4 — Payments

- [x] Define a shared provider adapter contract and registry in packages/payments.
- [x] Implement one-time Telegram Stars checkout for in-Telegram digital access.
- [x] Verify pre-checkout data and require Telegram successful_payment before activation.
- [x] Add idempotent Stars receipt storage, payment history and refund handling.
- [ ] Add scheduled reconciliation and retry handling for failed access delivery.
- [ ] Implement external provider adapters only for compliant checkout scenarios and eligible merchants/products.
- [ ] Add recurring Stars subscriptions (Telegram currently constrains recurring bot invoices to a 30-day period).
- [ ] Keep creator payments isolated from SubPilot platform billing.

Initial provider candidates for research: YooKassa, YooMoney, Prodamus, Robokassa, CloudPayments and Crypto Pay. Each requires a separate eligibility and integration assessment.

## Stage 5 — Monetization features

- Donations.
- Paid posts/messages.
- Timed paid conversations/consultations.
- Gift subscriptions.
- Promo codes and referral links.
- Giveaways.
- Broadcasts (optional future feature; no subscriber directory or customer cards).

## Stage 6 — SubPilot billing

- Platform plan catalogue and feature limits.
- Workspace billing lifecycle.
- Separate platform payment adapters and invoices/receipts as required.
- Upgrade/downgrade, grace period and payment-failure handling.

## Stage 7 — Agency and analytics

- Multi-creator portfolio.
- Role-based team access.
- Creator/project switching.
- Revenue, renewals, churn and subscriber analytics.
- Audit history and exports.

## Stage 8 — International expansion

- English localization and multi-currency display.
- Market-specific provider configuration.
- United States and Thailand launch review.
- Merchant onboarding, tax and compliance requirements per market.
