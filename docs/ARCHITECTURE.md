# SubPilot architecture

## Product shape

SubPilot is a multi-tenant Telegram monetization platform inspired by the feature set of Nemiling, implemented independently.

There are two operating modes:
- **Creator workspace:** one author manages their own projects.
- **Agency workspace:** a team manages multiple creators and projects with role-based access.

The central SubPilot bot is the default control panel and is restricted to private chats so workspace invitations, member data, payment history and administrative actions are not exposed in groups. Its text-entry actions are mutually exclusive and expire after five minutes. A workspace can contain multiple projects. A project has one active Telegram bot, connected channels/groups, monetization plans and payment-provider connections. New tariff purchases are available only while the project is ACTIVE; PAUSED and ARCHIVED projects do not expose new checkouts. A workspace can manage multiple projects, each with its own bot and merchant connections.

## Main entities

- User: Telegram identity of an owner, agency teammate or operator.
- Workspace: personal creator account or agency.
- WorkspaceMember: role in a workspace (OWNER, ADMIN, MANAGER, VIEWER).
- Project: an independently configured creator instance, including a declared merchant type used to filter payment-method options.
- ProjectBot: Telegram bot token and identity attached to a project.
- ConnectedChat: channel/group where access is managed.
- CreatorPlan: price, currency, duration and target chats.
- ProjectCustomer: Telegram buyer known to a project.
- Project creator: the user who created a project; used as the individual author notification recipient.
- OwnerNotification: deduplicated, retryable delivery record for project-owner and author lifecycle alerts.
- Subscription: a buyer's access entitlement and its dates/status.
- PaymentProviderConnection: encrypted merchant credentials belonging to a creator project. Registration in SubPilot is open to ordinary individuals; payment-method eligibility is evaluated separately for each project and provider.
- Payment / PaymentWebhookEvent: creator-side payment and idempotent webhook record.
- PlatformPlan / WorkspaceBilling / PlatformPayment: SubPilot's own tariff catalogue, workspace subscription and payment ledger.
- AuditLog: security-sensitive actions and important workspace changes.

## Two payment domains — never mix them

### Creator payments

A project owner creates a creator plan and connects a payment method available to that project. Payment credentials belong to the creator/project, not to SubPilot. Where the provider supports direct merchant settlement, the provider pays the creator under the creator's own provider agreement; SubPilot does not collect creator proceeds into a platform balance or run creator payouts. Each provider connection is scoped to one project.

SubPilot's primary commercial model is a fixed workspace subscription. Creator-payment volume is not subject to a default SubPilot transaction commission. Provider fees are separate and are charged under the provider's terms.

SubPilot registration is available to ordinary individuals. A creator's legal/merchant status is not a universal registration gate: the available payment methods are filtered by the selected provider's current onboarding requirements, the creator's declared merchant type, country, product and checkout surface. The research catalog in `packages/payments/src/provider-catalog.ts` is a discovery aid only; its seller/country matrix is based on Nemiling's public documentation and does not replace direct provider approval or legal review.

The first implemented checkout is a one-time Telegram Stars flow. The shared payment-policy gate classifies this as TELEGRAM_CHANNEL_ACCESS and rejects non-Stars providers before checkout:
- New in-Telegram digital-access plans are priced in whole Telegram Stars and use currency `XTR`.
- The buyer opens the project bot, lists plans with `/plans`, and starts checkout with `/buy PLAN_ID`.
- SubPilot creates a pending subscription and payment record before sending the invoice.
- A `pre_checkout_query` is accepted only when the payment is still pending and its project, buyer Telegram ID, currency and amount match the database record.
- The subscription is activated only after a `successful_payment` update. The Telegram charge ID and an idempotent receipt event are persisted.
- A connected chat is marked active only while the project bot is an administrator with both `can_invite_users` and `can_restrict_members`; these rights are required to issue invite links and later remove expired subscribers. The project bot creates one-person, 24-hour invite links for the connected chats selected by the plan. `chat_member` updates record completed joins. Each Stars payment snapshot records the project bot that issued the invoice, tariff title/duration and target chat IDs so refunds and access delivery can be associated with the originating bot and purchased configuration. Buyers can request current links again with /access. Tariff browsing, terms and payment support are available only in the buyer's private chat with the project bot.
- A workspace owner/admin can refund a successful Stars payment from the central bot. Refund requests use a `REFUNDING` claim with a retry lease. A confirmed refund is recorded in the payment and webhook-event ledgers. The project bot also consumes Telegram's `refunded_payment` service message and validates the original invoice payload, charge ID, amount, currency, buyer chat and originating bot before reconciling an externally initiated refund; repeated messages are idempotent. If the direct Telegram response was lost, retrying the same command reconciles Telegram's `CHARGE_ALREADY_REFUNDED` response. The remaining entitlement is reconstructed from each successful payment's immutable `durationDays` snapshot. Legacy payments without that snapshot are not recalculated automatically. Access removal is delegated to the lifecycle worker.

The shared provider package defines normalized checkout/event contracts, a registry for future integrations and a conservative provider-availability catalog. Only Telegram Stars are currently implemented for this product flow; YooMoney, Crypto Pay, manual confirmation and merchant-only providers are candidates, not enabled integrations.

Telegram's digital-goods rules take precedence over the provider catalog: paid access to Telegram channels/groups and other digital goods/services offered or fulfilled by a bot/Mini App must use Telegram Stars. The presence of an external provider credential does not bypass that rule.

The Stars checkout displays basic purchase disclosures before issuing an invoice and exposes /terms, /paysupport and /access. These are a technical baseline, not a substitute for project-specific buyer terms that a creator may need to supply. Payment records snapshot the selected tariff title, duration and connected chat IDs so later tariff edits do not silently rewrite an existing order. The refund flow removes only the refunded payment's paid period when the remaining successful payments have duration snapshots. If legacy payments lack those snapshots, existing subscription dates are preserved and manual review is required rather than guessing.

The platform must not mark a payment successful based only on a browser redirect or a client-side message. Provider status, project/customer scope, amount, currency and idempotency must be verified.

Whether funds settle directly to a creator or through a platform/marketplace arrangement depends on the provider's supported merchant model and contract. Do not assume every provider supports sub-merchants or direct settlement.

### SubPilot billing

SubPilot sells its own plans and usage-based services through a separate billing domain and ledger. Platform payments and platform-fee receivables must never be recorded as creator payments.

The **Start Without Upfront Cost** offer (seven days followed by a 14% commission) is retained as an isolated commercial experiment and is not part of the default launch pricing or creator checkout flow:
- The primary launch model is fixed workspace billing; there is no default SubPilot percentage on creator transactions.
- The seven-day/14% calculator and related schema/ledger groundwork are dormant experimental components. They must not be invoked from the normal payment success path.
- Do not activate the offer, create receivables or collect a fee until the product terms, legal model, eligible merchant/payment scenarios, currency treatment and collection mechanism have been reviewed and explicitly approved.
- In particular, never infer a RUB value from an XTR amount and never debit or control a creator's Telegram Stars balance.

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
- The API lifecycle worker checks active subscriptions once per minute, cancels unpaid Telegram Stars invoices after 24 hours, retries pending/expired invite delivery (with a five-minute retry delay), sends one reminder around three days and one around one day before expiry, and expires due subscriptions.
- When a buyer renews before expiry, the existing entitlement is extended from its current end date instead of creating overlapping subscriptions.
- On expiry, unused invite links are revoked and joined subscribers are removed from the connected chats. Failed removals remain pending for a later worker retry.
- Successful first activation queues a new-subscriber alert for the workspace creator and project creator. In a personal workspace these are normally the same user, so only one message is queued.
- Three-day and one-day expiry reminders, plus the expiry event, are queued for the same recipients through the central control bot. Queue creation is idempotent per event/recipient and delivery retries use backoff; a Telegram send that succeeds immediately before a database acknowledgement failure can still be delivered twice.
- Each lifecycle pass acquires a PostgreSQL-backed lease with a five-minute expiry and one-minute heartbeat. Only one API replica can run the lifecycle pass at a time; a crashed worker releases naturally when its lease expires.
- Channel/group connection requires the project bot to be added with the permissions needed for the selected feature.

## Reliability and security requirements

- All webhook handlers are idempotent. Telegram Stars receipts are deduplicated by the Telegram charge ID.
- Payment transitions use conditional database updates and are recorded in the payment and webhook-event ledgers. A verified Telegram `successful_payment` receipt can reconcile a stale invoice previously marked `CANCELLED`; charge IDs are deduplicated.
- Access is derived from subscription entitlements; payment events alone do not grant permanent access.
- Fixed-term subscription expiry, buyer reminders, abandoned Stars checkout cleanup, invite revocation and removal of joined members are implemented in the lifecycle worker. Failed Telegram operations remain retryable while the access grant is unrevoked. PostgreSQL lease coordination prevents concurrent lifecycle passes across API replicas.
- AuditLog schema is present, but application write calls are not implemented yet; audit history remains a known product gap.
- Secrets are encrypted at rest and rotated through a controlled process.
- Workspace/project ownership is checked in every API operation.
- Lifecycle work currently uses a database-backed polling worker rather than Redis. PostgreSQL leases coordinate API replicas; a durable queue may still be considered later if throughput or scheduling requirements outgrow this design.
- Admin actions must be permission-checked; creator data is isolated by workspace/project scope.

## Internationalization

Russia is the first operating market, with RUB as the initial default currency. The data model stores currency and provider at transaction/project level so international markets can be added without making the database Russia-specific.

Thailand and the United States are future market candidates, not assumed to be enabled. Each market requires its own provider review, merchant onboarding, tax/consumer-law assessment and product eligibility rules before launch.
