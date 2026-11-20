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
- [x] Add one active project bot by token; verify with Telegram getMe and enforce one active bot per project.
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
- [x] Display purchase terms before a Stars invoice; expose /terms and /paysupport.
- [x] Activate subscriptions only after successful_payment.
- [x] Persist idempotent payment receipts.
- [x] Issue one-person, 24-hour invite links for plan chats after verified payment.
- [x] Track joins against subscription grants and verify the entrant against the buyer's Telegram ID.
- [x] Detect existing chat membership and track leave/kick updates.
- [x] Let buyers request current invite links again with /access.
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
- [x] Add a conservative provider catalog with creator merchant-type/country research hints and per-product Telegram policy evaluation.
- [x] Add a product/surface-aware Telegram payment eligibility policy and enforce it in the creator Stars checkout.
- [x] Implement one-time Telegram Stars checkout for in-Telegram digital access.
- [x] Verify pre-checkout data and require Telegram successful_payment before activation.
- [x] Add idempotent Stars receipt storage, payment history and refund handling.
- [x] Persist pending access-delivery records and retry failed invite delivery through the lifecycle worker.
- [ ] Add delivery dead-letter monitoring, reconciliation and operator recovery.
- [ ] Implement external provider adapters only for compliant checkout scenarios and eligible merchants/products.
- [ ] Add recurring Stars subscriptions (Telegram currently constrains recurring bot invoices to a 30-day period).
- [ ] Keep creator payments isolated from SubPilot platform billing.

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
- [ ] Implement workspace billing lifecycle, payment status transitions and grace periods.
- [ ] Add separate platform billing adapters, invoices/receipts and reconciliation as required.
- [ ] Reconsider the 14% offer only after a separate legal, provider, currency and commercial review; do not debit creator Stars.
- [ ] Upgrade/downgrade, grace period and payment-failure handling.

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
