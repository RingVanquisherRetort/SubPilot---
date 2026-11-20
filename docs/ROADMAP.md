# SubPilot roadmap

## Stage 1 — Foundation (current branch)

- [x] Create TypeScript monorepo.
- [x] Add API and central Telegram-bot applications.
- [x] Model workspaces, agency membership, projects, customer bots, chats, creator plans, subscriptions and separate billing ledgers.
- [x] Add local PostgreSQL/Redis infrastructure.
- [x] Add a minimal control-bot flow: register Telegram user, create personal workspace, create/list projects.
- [ ] Install dependencies and run typecheck/migrations in a configured environment.

## Stage 2 — Workspace and project management

- [x] Workspace selector and agency membership.
- [x] Create agency workspace from the central bot.
- [x] Invite teammates with role-scoped, one-use Telegram deep links that expire after seven days.
- [x] Persist each user's active workspace.
- [x] Enforce manager/admin permissions for project operations.
- Project creation/editing/archive.
- Add a project bot by token; verify with Telegram getMe.
- Encrypt bot tokens and register unique webhook secrets.
- Connect channels/groups and validate bot admin rights.

## Stage 3 — Subscription engine

- Create/edit/archive plans.
- Map plans to one or more connected chats.
- Create checkout attempts.
- Issue invite links after verified payment.
- Track subscription periods and revoke access after expiry/cancellation.
- Manual grants, manual revocation, trials and reminders.

## Stage 4 — Payments

- Define a provider adapter contract.
- Implement Telegram Stars for supported in-Telegram digital purchase flows.
- Add external provider adapters only for compliant checkout scenarios and eligible merchants/products.
- Verify webhook signatures and provider-side payment state.
- Add idempotency, refunds, reconciliation and payment history.
- Keep creator payments isolated from SubPilot platform billing.

Initial provider candidates for research: YooKassa, YooMoney, Prodamus, Robokassa, CloudPayments and Crypto Pay. Each requires a separate eligibility and integration assessment.

## Stage 5 — Monetization features

- Donations.
- Paid posts/messages.
- Timed paid conversations/consultations.
- Gift subscriptions.
- Promo codes and referral links.
- Giveaways.
- Subscriber cards and broadcasts.

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
