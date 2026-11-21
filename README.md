# SubPilot

Telegram-first platform for paid communities, creators and agencies.

SubPilot gives each creator a project workspace and a dedicated Telegram bot. Agencies can manage multiple creators and projects from the central SubPilot bot. The platform is designed for paid subscriptions, access control, payments, paid interactions and audience tools.

## Product principles

- **Telegram-first:** the central SubPilot bot is the main control panel; a web dashboard is optional.
- **Multi-project:** one workspace can own multiple creator projects, each with its own Telegram bot, channels/groups and plans.
- **Agency-ready:** workspaces support multiple members with role-based access.
- **Separate payment domains:** creator revenue is separate from SubPilot's own subscription billing.
- **Provider adapters:** payment integrations are modular and enabled only for eligible merchants and compliant purchase flows.
- **Russia first, international-ready:** project country and transaction currency are stored independently.

## Stack

- Node.js 22+, TypeScript and pnpm workspaces
- Fastify API and grammY Telegram bots
- PostgreSQL and Prisma 7
- Redis (infrastructure for background jobs)
- AES-256-GCM encryption for bot tokens and provider credentials

## Local setup

1. Install Node.js 22.12+ and pnpm 10+.
2. Copy `.env.example` to `.env`.
3. Set `CONTROL_BOT_TOKEN` from @BotFather in both the central-bot and API environments (the API uses it to deliver owner notifications).
4. Generate `SECRETS_ENCRYPTION_KEY` with `openssl rand -base64 32`.
5. Set `PUBLIC_API_URL` to the public HTTPS origin of the API. Telegram webhooks cannot reach localhost.
6. Start PostgreSQL and Redis with `pnpm infra:up`.
7. Install dependencies with `pnpm install`.
8. Apply the initial migration with `pnpm db:migrate:deploy`.
9. Generate Prisma Client with `pnpm db:generate`.
10. Start the API and central bot with `pnpm dev`.

The API exposes `GET /health` and `GET /ready`. Project bot updates are received at `POST /webhooks/telegram/:botId` and authenticated with Telegram's secret-token header.

## Central control bot

Open the central bot with `/start` once. After that, use the inline button dashboard: projects, workspaces, agency creation, team members and invitations, project bots, tariff management, channels/groups and payment history. Tariff cards support editing the title, Stars price and duration, archiving/restoring, and linking/unlinking project channels and groups. SubPilot sends the project author and agency owner notifications about newly activated subscriptions, tariff expiry reminders (three days and one day before expiry), and subscription expiry. It does not expose a customer directory or individual customer cards. A tariff must retain at least one active destination. Text is requested only for values that need to be entered, such as a project name, bot token or tariff details.

The Telegram command menu includes `/start`, `/help` and the personal `/testnotifications` smoke test. Other administrative commands remain available as fallbacks, but normal operation is button-first.

The following commands remain available as an advanced fallback:

- `/start` — open the control panel.
- `/newproject Name` — create a project in the active workspace.
- `/projects` — list projects.
- `/createagency Name` — create an agency workspace.
- `/workspaces` and `/switchworkspace ID` — list/switch workspaces.
- `/invite [ADMIN|MANAGER|VIEWER]` — create a one-use, seven-day invite.
- `/members`, `/removemember TELEGRAM_ID` — manage workspace members.
- `/connectbot PROJECT_ID` — start connecting a project bot; send the BotFather token as the next message.
- `/chats PROJECT_ID`, `/linkchat PLAN_ID CHAT_ID`, `/unlinkchat PLAN_ID CHAT_ID` — manage plan destinations.
- `/createplan PROJECT_ID | Title | StarPrice | DurationDays` — create a Telegram Stars tariff. Use `0` for no fixed expiry.
- `/plans PROJECT_ID` — list plans.
- `/payments PROJECT_ID` — view recent payments.
- `/refundpayment PAYMENT_ID` — issue or reconcile a Telegram Stars refund; remaining paid subscription time is recalculated when payment snapshots allow it.
- `/testnotifications` — send four sample lifecycle notifications to your own private chat with the central bot. This smoke test does not contact project owners or subscribers.

The control bot deletes the BotFather token message on a best-effort basis. If the message remains visible, revoke the token in BotFather and issue a new one. Project-bot webhook activation requires `PUBLIC_API_URL` and a reachable HTTPS API.

## Platform operator commands

Global SubPilot plan-catalogue administration is separate from workspace OWNER/ADMIN roles. It is disabled by default and requires an explicit comma-separated allowlist of numeric Telegram user IDs in `PLATFORM_ADMIN_TELEGRAM_IDS`. Telegram usernames and workspace roles do not grant platform-operator access.

Available private-chat commands for allowlisted operators:

- `/platformplans [page]` — list the global catalogue in pages of 10 and show how many workspaces are assigned to each plan.
- `/platformplan CODE | Title | Price | Currency | PeriodDays | Projects | Members | PlansPerProject | ConnectedChatsPerProject | Description` — create or update an unassigned plan. Use `*` for explicitly unlimited quotas and `0` to disable a resource. Currency is a three-letter uppercase code; price is stored as a decimal string with up to two fractional digits. A plan already assigned to any workspace is immutable; publish changed terms under a new code.
- `/platformplanstatus CODE active|off` — activate a catalogue item or disable it only when no workspaces are assigned to it.

Every catalogue mutation is written to the audit log. An empty or malformed allowlist fails closed. Workspace-plan assignment is intentionally not exposed yet: the product still needs approved trial/paid activation rules and payment-lifecycle handling. Merely creating a catalogue item does not bill or assign it to any workspace. SubPilot workspace billing targets a separate external-acquiring flow (not Telegram Stars), with its own provider connection, payment ledger and lifecycle. Checkout and workspace-plan assignment are not implemented yet. The exact sales surface must pass a Telegram-policy review before activation; see `docs/decisions/platform-billing-checkout.md`.

## Buyer flow

Each connected project bot exposes a button-first buyer interface:

- `/start` — opens the subscription menu.
- **View subscriptions** — opens an inline tariff list.
- **Select a tariff** — opens the Stars invoice.
- Renewal reminders include a **Renew subscription** button.

The `/plans` and `/buy PLAN_ID` commands remain as an advanced fallback, but are not required for normal purchases.

For a digital subscription sold inside Telegram, the invoice uses `XTR`. Before accepting payment, SubPilot checks the pending payment, buyer Telegram ID, amount and currency. A subscription is activated only after a Telegram `successful_payment` update.

After payment, the project bot creates a one-person invite link for each active channel/group attached to the tariff. Each invite expires after 24 hours; joins are recorded from `chat_member` updates. Refunds can be initiated from the central bot using `/refundpayment`.

The API starts a lifecycle worker after the database and HTTP server are ready. It sends buyer renewal reminders approximately three days and one day before expiry, queues owner/author notifications for those milestones and expiry, extends an existing active subscription when a buyer renews early, expires subscriptions on schedule, revokes unused invite links and removes joined subscribers from connected chats. Owner notifications are delivered by the central control bot and retried with backoff. Removal requires the project bot to retain the necessary administrator rights. Configure `CONTROL_BOT_TOKEN` for the API service as well as the control-bot service. The lifecycle worker polls once per minute and uses a PostgreSQL-backed lease with heartbeat so only one API replica runs a lifecycle pass at a time. Failed operations remain retryable; exhausted owner-notification attempts are retained in the database but do not yet have a dedicated dead-letter monitoring or operator-recovery interface.

**Important current limitations:** external provider adapters, SubPilot workspace checkout/lifecycle, donations, paid messages and consultation billing are still in development. Creator-side digital access sold through a Telegram bot or Mini App remains subject to Telegram's Stars requirement; SubPilot's own external-acquiring checkout must use a separately reviewed compliant sales surface. The lifecycle worker and button flows need integration testing against a configured PostgreSQL database and real Telegram bots before production use. Do not treat the current checkout as production-ready until database migrations, bot runtime, payment tests and access-expiry handling have been tested in a configured environment.

## Database migrations

A full initial Prisma baseline is stored in `packages/database/prisma/migrations/0_init`.

For a new, empty PostgreSQL database, configure `DATABASE_URL` and run:

```bash
pnpm infra:up
pnpm db:migrate:deploy
pnpm db:generate
```

For a database that already contains the exact schema represented by `0_init`, take a backup and inspect the schema first, then mark the baseline as applied instead of trying to create the tables again:

```bash
pnpm --filter @subpilot/database exec prisma migrate resolve --applied 0_init --config prisma.config.ts
```

Do not run the baseline against a populated database as a fresh migration. If the existing database differs from the baseline, reconcile it with a reviewed migration before deploying. In production, use `pnpm db:migrate:deploy`; use `pnpm db:migrate` only in development when creating new migrations.

## Repository layout

- `apps/api` — HTTP API and project-bot webhook handler.
- `apps/control-bot` — central SubPilot bot for creators and agencies.
- `packages/database` — Prisma schema and database client.
- `packages/payments` — shared payment provider contracts and registry.
- `packages/security` — secret encryption/decryption.
- `docs/ARCHITECTURE.md` — architecture and security boundaries.
- `docs/ROADMAP.md` — implementation sequence.

## Current status

Foundation, workspace management, project-bot webhooks, creator plan management, the first Telegram Stars one-time purchase flow, subscription lifecycle processing and owner notifications are implemented in the development branch. External provider integrations, recurring billing and several monetization features remain on the roadmap. Live Telegram delivery and deployment to a configured server still require environment setup and smoke testing.
