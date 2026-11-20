# SubPilot

Telegram-first platform for paid communities, creators and agencies.

SubPilot gives each creator a project workspace and a dedicated Telegram bot. Agencies can manage multiple creators and projects from the central SubPilot bot. The platform is designed for paid subscriptions, access control, payments, paid interactions and audience tools.

## Product principles

- **Telegram-first:** the central SubPilot bot is the main control panel; a web dashboard is optional.
- **Multi-project:** one workspace can own multiple creator projects, each with its own Telegram bot, channels/groups, plans and customers.
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
3. Set `CONTROL_BOT_TOKEN` from @BotFather.
4. Generate `SECRETS_ENCRYPTION_KEY` with `openssl rand -base64 32`.
5. Set `PUBLIC_API_URL` to the public HTTPS origin of the API. Telegram webhooks cannot reach localhost.
6. Start PostgreSQL and Redis with `pnpm infra:up`.
7. Install dependencies with `pnpm install`.
8. Generate Prisma Client with `pnpm db:generate`.
9. Apply the development schema with `pnpm db:migrate`.
10. Start the API and central bot with `pnpm dev`.

The API exposes `GET /health` and `GET /ready`. Project bot updates are received at `POST /webhooks/telegram/:botId` and authenticated with Telegram's secret-token header.

## Central control bot

Open the central bot with `/start` once. After that, use the inline button dashboard: projects, workspaces, agency creation, team members and invitations, project bots, tariff management, channels/groups, subscribers and payment history. Tariff cards support editing the title, Stars price and duration, archiving/restoring, and linking/unlinking project channels and groups. The subscriber list opens customer cards with Telegram identity, subscription status and expiry dates, and recent payment history. A tariff must retain at least one active destination. Text is requested only for values that need to be entered, such as a project name, bot token or tariff details.

The Telegram command menu is intentionally reduced to `/start` and `/help`. The underlying commands remain available for administration and troubleshooting, but normal operation is button-first.

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
- `/refundpayment PAYMENT_ID` — issue a Telegram Stars refund and cancel the entitlement.

The control bot deletes the BotFather token message on a best-effort basis. If the message remains visible, revoke the token in BotFather and issue a new one. Project-bot webhook activation requires `PUBLIC_API_URL` and a reachable HTTPS API.

## Buyer flow

Each connected project bot exposes a button-first buyer interface:

- `/start` — opens the subscription menu.
- **View subscriptions** — opens an inline tariff list.
- **Select a tariff** — opens the Stars invoice.
- Renewal reminders include a **Renew subscription** button.

The `/plans` and `/buy PLAN_ID` commands remain as an advanced fallback, but are not required for normal purchases.

For a digital subscription sold inside Telegram, the invoice uses `XTR`. Before accepting payment, SubPilot checks the pending payment, buyer Telegram ID, amount and currency. A subscription is activated only after a Telegram `successful_payment` update.

After payment, the project bot creates a one-person invite link for each active channel/group attached to the tariff. Each invite expires after 24 hours; joins are recorded from `chat_member` updates. Refunds can be initiated from the central bot using `/refundpayment`.

The API starts a lifecycle worker after the database and HTTP server are ready. It sends renewal reminders approximately three days and one day before expiry, extends an existing active subscription when a buyer renews early, expires subscriptions on schedule, revokes unused invite links and removes joined subscribers from connected chats. Removal requires the project bot to retain the necessary administrator rights. The current worker is in-process; deploy a single API worker instance until distributed job locking is introduced.

**Important current limitations:** Telegram Stars recurring billing, external provider adapters, donations, paid messages and consultation billing are still in development. The lifecycle worker and button flows need integration testing against a configured PostgreSQL database and real Telegram bots before production use. Do not treat the current checkout as production-ready until database migrations, bot runtime, payment tests and access-expiry handling have been tested in a configured environment.

## Repository layout

- `apps/api` — HTTP API and project-bot webhook handler.
- `apps/control-bot` — central SubPilot bot for creators and agencies.
- `packages/database` — Prisma schema and database client.
- `packages/payments` — shared payment provider contracts and registry.
- `packages/security` — secret encryption/decryption.
- `docs/ARCHITECTURE.md` — architecture and security boundaries.
- `docs/ROADMAP.md` — implementation sequence.

## Current status

Foundation, workspace management, project-bot webhooks, creator plan management and a first Telegram Stars one-time purchase flow are implemented in the development branch. External provider integrations, recurring billing, subscription expiry automation and several monetization features remain on the roadmap.
