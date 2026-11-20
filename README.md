# SubPilot

Telegram-first platform for paid communities, creators and agencies.

SubPilot gives each creator a branded Telegram bot and a project workspace. Agencies can manage multiple creators and projects from one place. The platform includes subscription access, payment integrations, paid interactions, audience tools and platform billing.

## Product principles

- **Telegram-first:** the central SubPilot bot is the primary control panel. A web dashboard is optional, not required for the core workflow.
- **Multi-project:** one workspace can own multiple creator projects; each project can connect its own Telegram bot and channels/groups.
- **Agency-ready:** workspaces support multiple members and role-based access.
- **Two separate payment domains:** payments collected by creators are separate from payments for SubPilot plans.
- **Provider adapters:** payment integrations are modular. Availability, merchant eligibility, settlement and Telegram rules are checked per provider, country and product type.
- **Russia first, international-ready:** Russian ruble is the initial default; currency and country are stored per project/payment for later expansion.

## Stack

- Node.js 22+
- TypeScript + pnpm workspaces
- Fastify API
- grammY Telegram bot framework
- PostgreSQL + Prisma ORM 7
- Redis for background jobs and webhook processing

## Local setup

1. Install Node.js 22.12+ and pnpm 10+.
2. Copy .env.example to .env.
3. Set CONTROL_BOT_TOKEN from @BotFather.
4. Generate SECRETS_ENCRYPTION_KEY with: openssl rand -base64 32.
5. Set PUBLIC_API_URL to the public HTTPS origin of the API (for example, https://api.example.com). Telegram webhooks require a reachable HTTPS endpoint.
6. Start infrastructure: pnpm infra:up.
7. Install dependencies: pnpm install.
8. Generate the database client: pnpm db:generate.
9. Apply the development schema: pnpm db:migrate.
10. Start the API and central bot: pnpm dev.

The API health endpoint is GET /health; database readiness is GET /ready. Project bot webhooks are received at POST /webhooks/telegram/:botId and authenticated with Telegram's secret-token header.\n\nIn the control bot, use /start, /newproject Project name and /projects. Create an agency with /createagency Name, list and switch spaces with /workspaces and /switchworkspace ID. Owners/admins can create one-use, seven-day team invitations with /invite [ADMIN|MANAGER|VIEWER].\n\nTo connect a project bot, use /connectbot PROJECT_ID in a private chat and then send its BotFather token as the next message. The token message is deleted on a best-effort basis; if it remains visible, revoke the token in BotFather and issue a new one. With PUBLIC_API_URL configured, SubPilot installs a signed webhook and detects channels/groups when the bot is added as an administrator. Create plans with /createplan PROJECT_ID | Title | Price | DurationDays (0 means no expiry), list them with /plans PROJECT_ID, and archive/restore them with /archiveplan and /restoreplan.

## Repository layout

- apps/api — HTTP API and webhook entry point.
- apps/control-bot — central SubPilot bot used by creators and agencies.
- packages/database — Prisma schema and database client.
- docs/ARCHITECTURE.md — system boundaries and product architecture.
- docs/ROADMAP.md — implementation sequence.

## Current status

Foundation stage. The repository contains the initial monorepo, database model and a minimal central-bot onboarding flow. Payment execution, customer bots, channel access automation and agency management are subsequent stages.
