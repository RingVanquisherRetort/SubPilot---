# SubPilot architecture

## Product shape

SubPilot is a multi-tenant Telegram monetization platform inspired by the feature set of Nemiling, implemented independently.

There are two operating modes:
- **Creator workspace:** one author manages their own projects.
- **Agency workspace:** a team manages multiple creators and projects with role-based access.

The central SubPilot bot is the default control panel. A workspace can contain multiple projects. A project has one active Telegram bot, connected channels/groups, monetization plans and payment-provider connections. A workspace can manage multiple projects, each with its own bot and merchant connections.

## Main entities

- User: Telegram identity of an owner, agency teammate or operator.
- Workspace: personal creator account or agency.
- WorkspaceMember: role in a workspace (OWNER, ADMIN, MANAGER, VIEWER).
- Project: an independently configured creator/business instance.
- ProjectBot: Telegram bot token and identity attached to a project.
- ConnectedChat: channel/group where access is managed.
- CreatorPlan: price, currency, duration and target chats.
- ProjectCustomer: Telegram buyer known to a project.
- Project creator: the user who created a project; used as the individual author notification recipient.
- OwnerNotification: deduplicated, retryable delivery record for project-owner and author lifecycle alerts.
- Subscription: a buyer's access entitlement and its dates/status.
- PaymentProviderConnection: encrypted merchant credentials belonging to a creator project.
- Payment / PaymentWebhookEvent: creator-side payment and idempotent webhook record.
- PlatformPlan / WorkspaceBilling / PlatformPayment: SubPilot's own tariff catalogue, workspace subscription and payment ledger.
- AuditLog: security-sensitive actions and important workspace changes.

## Two payment domains — never mix them

### Creator payments

A project owner creates a creator plan and connects eligible payment-provider credentials to their project. The provider adapter creates a payment attempt and normalizes provider notifications before an entitlement is activated. Each provider connection is scoped to one project.

The first implemented checkout is a one-time Telegram Stars flow. The shared payment-policy gate classifies this as TELEGRAM_CHANNEL_ACCESS and rejects non-Stars providers before checkout:
- New in-Telegram digital-access plans are priced in whole Telegram Stars and use currency `XTR`.
- The buyer opens the project bot, lists plans with `/plans`, and starts checkout with `/buy PLAN_ID`.
- SubPilot creates a pending subscription and payment record before sending the invoice.
- A `pre_checkout_query` is accepted only when the payment is still pending and its project, buyer Telegram ID, currency and amount match the database record.
- The subscription is activated only after a `successful_payment` update. The Telegram charge ID and an idempotent receipt event are persisted.
- The project bot creates one-person, 24-hour invite links for the connected chats selected by the plan. `chat_member` updates record completed joins. Each Stars payment snapshot records the project bot that issued the invoice, tariff title/duration and target chat IDs so refunds and access delivery can be associated with the originating bot and purchased configuration. Buyers can request current links again with /access.
- A workspace owner/admin can review payments and refund a successful Stars payment from the central bot. Refund also cancels the subscription, revokes outstanding invite links and removes joined subscribers from the linked chats.

The shared provider package defines normalized checkout/event contracts and a registry for future integrations. The external adapters are not yet implemented.

The Stars checkout displays basic purchase disclosures before issuing an invoice and exposes /terms, /paysupport and /access. These are a technical baseline, not a substitute for project-specific buyer terms that a creator may need to supply. Payment records snapshot the selected tariff title, duration and connected chat IDs so later tariff edits do not silently rewrite an existing order. The refund flow preserves an entitlement when other successful payments remain on the same subscription; a full per-payment period ledger and exact recalculation after partial refunds are still required before refunds can be considered complete.

The platform must not mark a payment successful based only on a browser redirect or a client-side message. Provider status, project/customer scope, amount, currency and idempotency must be verified.

Whether funds settle directly to a creator or through a platform/marketplace arrangement depends on the provider's supported merchant model and contract. Do not assume every provider supports sub-merchants or direct settlement.

### SubPilot billing

SubPilot sells its own plans and usage-based services through a separate billing domain and ledger. Platform payments and platform-fee receivables must never be recorded as creator payments.

The optional **Start Without Upfront Cost** offer is a workspace-level introductory commercial offer:
- The workspace owner explicitly selects and accepts the offer before activation.
- The offer lasts seven calendar days from its persisted activation timestamp; creating additional projects does not restart it.
- SubPilot accrues a temporary 14% fee only on successful creator payments whose `paidAt` timestamp falls inside the half-open interval `[trialStartedAt, trialEndsAt)`.
- The fee is not a permanent payment surcharge and is not applied to other platform plans.
- Refunds reduce the net commission base. Duplicate payment events must not create duplicate fee entries.
- The commission calculation retains the original sale currency. In particular, an XTR-denominated fee is not silently treated as RUB: the conversion rule and collection route must be explicitly agreed and disclosed before an XTR commission can be invoiced.
- Creator Stars remain in the creator's Telegram balance. SubPilot records a separate receivable and collects it through its own approved billing flow; it does not debit or control the creator's Stars balance.
- The current payment package contains a decimal-safe introductory commission calculator. Persistent offer activation, an idempotent commission ledger, refund adjustments, invoice collection and the workspace UI remain separate implementation steps.

Platform plan limits are applied to workspaces, not to an individual creator's content transactions. Creator payments, platform subscription payments and platform commission receivables remain separate accounting domains.

### Telegram and regional rules

The payment adapter interface is deliberately separate from the product entitlement engine. The policy gate evaluates product type, checkout surface, Telegram association and provider. Paid access to Telegram channels/groups is always classified as TELEGRAM_CHANNEL_ACCESS and requires an in-Telegram Stars checkout. Other digital goods/services offered, promoted or fulfilled by the Telegram bot/Mini App also require Stars. An independent website product may be evaluated separately only when it is genuinely not offered, promoted or fulfilled by the Telegram TPA; this is not an external-checkout route for Telegram channel access. Telegram Stars are not the route for physical goods/services. Eligible physical goods/services may use third-party payment providers under Telegram's Bot Payments rules.

The gate is a Telegram product-policy check, not merchant approval. Provider eligibility is also resolved per country, merchant type, currency, product category, provider contract, tax/receipt obligations and adapter capabilities. A provider being technically integrated does not mean every workspace can use it. See docs/decisions/telegram-payment-eligibility.md for the research and decision record.

## Telegram bot topology

- The **control bot** authenticates owners through Telegram and manages workspaces/projects.
- Each **project bot** belongs to one project and uses its own BotFather token.
- A project bot is verified with Telegram's getMe before activation. SubPilot allows one active bot per project, matching the Nemiling project model and keeping invite creation, renewal reminders, refunds and expiry operations on the same bot.
- Project bots receive `my_chat_member`, `message`, `pre_checkout_query` and `chat_member` updates through POST /webhooks/telegram/:botId. Telegram's X-Telegram-Bot-Api-Secret-Token header is SHA-256 hashed and compared in constant time with the stored hash before any update is processed.
- The project bot token is encrypted at rest with AES-256-GCM. The webhook secret itself is never stored in plaintext; only its hash is stored. Plaintext secrets must never appear in logs or API responses.
- On connection, the control bot validates the token with getMe and installs a webhook at PUBLIC_API_URL. This must be a publicly reachable HTTPS origin.
- The project bot subscribes to `my_chat_member` updates. When it is added or removed, the API upserts the connected chat and marks it active only when the bot has administrator/creator status.
- `pre_checkout_query` validates a Stars invoice against the pending payment record; `successful_payment` is the only event that activates a paid entitlement.
- Invite links are generated per subscription/chat, expire after 24 hours and have a one-member limit. Their joins are tracked by `chat_member` updates.
- The API lifecycle worker checks active subscriptions once per minute, retries pending/expired invite delivery (with a five-minute retry delay), sends one reminder around three days and one around one day before expiry, and expires due subscriptions.
- When a buyer renews before expiry, the existing entitlement is extended from its current end date instead of creating overlapping subscriptions.
- On expiry, unused invite links are revoked and joined subscribers are removed from the connected chats. Failed removals remain pending for a later worker retry.
- Successful first activation queues a new-subscriber alert for the workspace creator and project creator. In a personal workspace these are normally the same user, so only one message is queued.
- Three-day and one-day expiry reminders, plus the expiry event, are queued for the same recipients through the central control bot. Deliveries are idempotent per event/recipient and retry with backoff.
- The current worker is process-local and assumes one API instance. Multiple replicas require distributed locking before deployment.
- Channel/group connection requires the project bot to be added with the permissions needed for the selected feature.

## Reliability and security requirements

- All webhook handlers are idempotent. Telegram Stars receipts are deduplicated by the Telegram charge ID.
- Payment status changes are monotonic and recorded in the payment ledger and webhook-event ledger.
- Access is derived from subscription entitlements; payment events alone do not grant permanent access.
- Fixed-term subscription expiry, buyer reminders, invite revocation and removal of joined members are implemented in the in-process lifecycle worker. Failed Telegram operations remain retryable while the access grant is unrevoked; multiple API replicas still require distributed locking.
- AuditLog schema is present, but application write calls are not implemented yet; audit history remains a known product gap.
- Secrets are encrypted at rest and rotated through a controlled process.
- Workspace/project ownership is checked in every API operation.
- Subscription expiry and renewal reminders currently run in a single in-process API worker. Migration to Redis-backed queues and distributed locking is required before horizontal scaling.
- Admin actions must be permission-checked; creator data is isolated by workspace/project scope.

## Internationalization

Russia is the first operating market, with RUB as the initial default currency. The data model stores currency and provider at transaction/project level so international markets can be added without making the database Russia-specific.

Thailand and the United States are future market candidates, not assumed to be enabled. Each market requires its own provider review, merchant onboarding, tax/consumer-law assessment and product eligibility rules before launch.
