# SubPilot architecture

## Product shape

SubPilot is a multi-tenant Telegram monetization platform inspired by the feature set of Nemiling, implemented independently.

There are two operating modes:
- **Creator workspace:** one author manages their own projects.
- **Agency workspace:** a team manages multiple creators and projects with role-based access.

The central SubPilot bot is the default control panel. A workspace can contain multiple projects. A project can have one or more Telegram bots, connected channels/groups, monetization plans and payment-provider connections.

## Main entities

- User: Telegram identity of an owner, agency teammate or operator.
- Workspace: personal creator account or agency.
- WorkspaceMember: role in a workspace (OWNER, ADMIN, MANAGER, VIEWER).
- Project: an independently configured creator/business instance.
- ProjectBot: Telegram bot token and identity attached to a project.
- ConnectedChat: channel/group where access is managed.
- CreatorPlan: price, currency, duration and target chats.
- ProjectCustomer: Telegram buyer known to a project.
- Subscription: a buyer's access entitlement and its dates/status.
- PaymentProviderConnection: encrypted merchant credentials belonging to a creator project.
- Payment / PaymentWebhookEvent: creator-side payment and idempotent webhook record.
- PlatformPlan / WorkspaceBilling / PlatformPayment: SubPilot's own tariff catalogue, workspace subscription and payment ledger.
- AuditLog: security-sensitive actions and important workspace changes.

## Two payment domains — never mix them

### Creator payments

A project owner connects eligible payment-provider credentials to their project. The provider adapter creates a payment attempt and verifies the provider's webhook before an entitlement is activated. Each provider connection is scoped to one project.

The platform must not mark a payment successful based only on a browser redirect or a client-side message. Webhook signatures, provider status, amount, currency and idempotency must be verified.

Whether funds settle directly to a creator or through a platform/marketplace arrangement depends on the provider's supported merchant model and contract. Do not assume every provider supports sub-merchants or direct settlement.

### SubPilot billing

SubPilot sells its own plans through a separate billing domain and ledger. Platform payments must never be recorded as creator payments. Platform plan limits are applied to workspaces, not to an individual creator's content transactions.

### Telegram and regional rules

The payment adapter interface is deliberately separate from the product entitlement engine. Telegram Stars are the native route for digital goods and services sold inside Telegram. External providers may only be enabled for a flow that is permitted by Telegram's current rules, provider contracts and the applicable jurisdiction. An external checkout must not be used as a mechanism to bypass Telegram requirements.

Provider eligibility is resolved per country, merchant type, currency and product category. A provider being technically integrated does not mean every workspace can use it.

## Telegram bot topology

- The **control bot** authenticates owners through Telegram and manages workspaces/projects.
- Each **project bot** belongs to one project and uses its own BotFather token.
- A project bot is verified with Telegram's getMe before activation.
- Project bots receive updates through the API webhook router.
- Bot tokens and provider credentials are encrypted at rest with an application-managed key. Plaintext secrets must never appear in logs or API responses.
- Channel/group connection requires the project bot to be added with the permissions needed for the selected feature.

## Reliability and security requirements

- All webhook handlers are idempotent.
- Payment status changes are monotonic and recorded in the payment ledger.
- Access is derived from subscription entitlements; payment events alone do not grant permanent access.
- Important actions are written to the audit log.
- Secrets are encrypted at rest and rotated through a controlled process.
- Workspace/project ownership is checked in every API operation.
- Background work (renewal reminders, expirations, webhook retries and broadcasts) runs through Redis-backed queues.
- Admin actions must be permission-checked; creator data is isolated by workspace/project scope.

## Internationalization

Russia is the first operating market, with RUB as the initial default currency. The data model stores currency and provider at transaction/project level so international markets can be added without making the database Russia-specific.

Thailand and the United States are future market candidates, not assumed to be enabled. Each market requires its own provider review, merchant onboarding, tax/consumer-law assessment and product eligibility rules before launch.
