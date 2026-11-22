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
- PlatformPaymentProviderConnection / PlatformPaymentWebhookEvent: globally managed SubPilot merchant credentials and a webhook ledger isolated from creator-owned provider connections and events.
- AuditLog: security-sensitive actions and important workspace changes.

## Two payment domains — never mix them

### Creator payments

A project owner creates a creator plan and connects a payment method available to that project. Payment credentials belong to the creator/project, not to SubPilot. Where the provider supports direct merchant settlement, the provider pays the creator under the creator's own provider agreement; SubPilot does not collect creator proceeds into a platform balance or run creator payouts. Each provider connection is scoped to one project.

SubPilot's primary commercial model is a fixed workspace subscription. Creator-payment volume is not subject to a default SubPilot transaction commission. Provider fees are separate and are charged under the provider's terms.

SubPilot registration is available to ordinary individuals. A creator's legal/merchant status is not a universal registration gate: the available payment methods are filtered by the selected provider's current onboarding requirements, the creator's declared merchant type, country, product and checkout surface. The research catalog in `packages/payments/src/provider-catalog.ts` is a discovery aid only; its seller/country matrix is based on Nemiling's public documentation and does not replace direct provider approval or legal review.

The first implemented checkout is a one-time Telegram Stars flow. The shared payment-policy gate classifies this as TELEGRAM_CHANNEL_ACCESS and rejects non-Stars providers before checkout:
- New in-Telegram digital-access plans are priced in whole Telegram Stars and use currency `XTR`.
- The buyer opens the project bot, lists plans with `/plans`, and starts checkout with `/buy PLAN_ID`.
- SubPilot creates a pending subscription and payment record before sending the invoice. Repeated `/buy` requests reuse the same pending payment without sending a second invoice message. Checkout creation and invoice-dispatch claiming use the same PostgreSQL advisory lock, so concurrent `/buy` updates cannot both claim the same invoice. Before calling Telegram, SubPilot records an invoice-dispatch marker; once Telegram responds, the message ID is recorded as well. If the request or message-ID persistence has an ambiguous outcome, repeated requests are suppressed and the buyer is asked to check the existing chat or contact `/paysupport` rather than risk a duplicate invoice. Unpaid Stars payments expire after 24 hours.
- A `pre_checkout_query` is accepted only when the payment is still pending and its project, buyer Telegram ID, currency and amount match the database record.
- The subscription is activated only after a `successful_payment` update. The Telegram charge ID and an idempotent receipt event are persisted.
- A connected chat is marked active only while the project bot is an administrator with both `can_invite_users` and `can_restrict_members`; these rights are required to issue invite links and later remove expired subscribers. The project bot creates one-person, 24-hour invite links for the connected chats selected by the plan. `chat_member` updates record completed joins. Each Stars payment snapshot records the project bot that issued the invoice, tariff title/duration and target chat IDs so refunds and access delivery can be associated with the originating bot and purchased configuration. When payment is confirmed, SubPilot creates an access-grant row for every destination in that immutable purchase snapshot, including destinations temporarily marked inactive. This preserves a retry target if the project bot has lost channel rights between invoice creation and payment; the lifecycle worker can retry once the bot regains rights. If a one-person invite is used by the wrong account, Telegram's explicit `INVITE_HASH_EXPIRED` response is treated as an already-expired link and SubPilot issues a replacement to the intended buyer. Buyers can request current links again with /access. Tariff browsing, terms and payment support are available only in the buyer's private chat with the project bot.
- A workspace owner/admin can refund a successful Stars payment from the central bot. Refund requests use a `REFUNDING` claim with a retry lease. A confirmed refund is recorded in the payment and webhook-event ledgers. The project bot also consumes Telegram's `refunded_payment` service message and validates the original invoice payload, charge ID, amount, currency, buyer chat and originating bot before reconciling an externally initiated refund; repeated messages are idempotent. If the direct Telegram response was lost, retrying the same command reconciles Telegram's `CHARGE_ALREADY_REFUNDED` response. The remaining entitlement is reconstructed from each successful payment's immutable `durationDays` snapshot. Legacy payments without that snapshot are not recalculated automatically. Access removal is delegated to the lifecycle worker.

The shared provider package defines normalized checkout/event contracts, a registry for future integrations and a conservative provider-availability catalog. Only Telegram Stars are currently implemented for this product flow; YooMoney, Crypto Pay, manual confirmation and merchant-only providers are candidates, not enabled integrations.

Telegram's digital-goods rules take precedence over the provider catalog: paid access to Telegram channels/groups and other digital goods/services offered or fulfilled by a bot/Mini App must use Telegram Stars. The presence of an external provider credential does not bypass that rule.

The Stars checkout displays basic purchase disclosures before issuing an invoice and exposes /terms, /paysupport and /access. These are a technical baseline, not a substitute for project-specific buyer terms that a creator may need to supply. Payment records snapshot the selected tariff title, duration and connected chat IDs so later tariff edits do not silently rewrite an existing order. The refund flow removes only the refunded payment's paid period when the remaining successful payments have duration snapshots. If legacy payments lack those snapshots, existing subscription dates are preserved and manual review is required rather than guessing.

The platform must not mark a payment successful based only on a browser redirect or a client-side message. Provider status, project/customer scope, amount, currency and idempotency must be verified.

Whether funds settle directly to a creator or through a platform/marketplace arrangement depends on the provider's supported merchant model and contract. Do not assume every provider supports sub-merchants or direct settlement.

### SubPilot billing

SubPilot sells its own plans through a separate workspace-billing domain and ledger. Platform payments and platform-fee receivables must never be recorded as creator payments.

The platform acquiring path uses a dedicated global `PlatformPaymentProviderConnection`, separate from creator `PaymentProviderConnection` records. Platform credentials are encrypted at rest; payment records preserve workspace/plan identity, immutable plan, price, currency and period snapshots, provider connection and checkout reference. Webhook events are deduplicated in `PlatformPaymentWebhookEvent`, never mixed with creator `PaymentWebhookEvent` records. Allowlisted operators can manage SubPilot-owned provider connections from the central bot; new/rotated credentials remain PENDING until provider verification, and credential-version compare-and-set prevents a stale verification response from activating rotated credentials.

The feature branch implements an authenticated independent-web checkout:
- `GET /billing` and `GET /billing/return` serve the purchase and return page.
- Telegram Login Widget data is validated server-side; the website issues a short-lived signed HttpOnly/Secure session cookie.
- Checkout and payment-status routes require an authenticated workspace OWNER/ADMIN. The browser cannot choose the provider connection or classify the sales surface.
- The server selects the configured active SubPilot-owned YooKassa connection and active plan. Origin checks, idempotency and a per-workspace non-terminal payment guard prevent cross-origin initiation and replacement/double charges.
- A redirect is informational only. Workspace access/period changes happen only after YooKassa is re-queried through authenticated API credentials and the matching payment webhook is reconciled against provider payment ID, local payment reference, amount and currency.
- Full refunds are requested by allowlisted operators with `/platformrefund PAYMENT_ID`. Access is adjusted only after a verified full-refund event and exact paid-period reconciliation. Partial refunds, mismatched amounts and non-contiguous/ambiguous periods remain in the manual-review queue.
- Checkout is fail-closed by default. The feature flags are not legal approval; the actual sales surface and the relation of the SaaS offer to the Telegram bot/Mini App must receive documented policy/compliance review before enabling it.

Workspace billing is **one-time payment with manual renewal**. The customer intentionally starts a new checkout to purchase the next period. Automatic recurring charges, stored-card mandates and automatic charge retries are out of scope. The branch has CI coverage with provider HTTP fakes; no real merchant account, merchant acceptance, fiscal receipts or production PSP transaction has been exercised. Keep customer-facing checkout disabled until the owner-authorized YooKassa test-store journey and compliance checks are complete.


#### Workspace plan feature limits

The `PlatformPlan.features` JSON field uses a versioned configuration. Version 1 requires all four limit keys:

```json
{
  "schemaVersion": 1,
  "limits": {
    "projects": 3,
    "members": 1,
    "plansPerProject": 5,
    "connectedChatsPerProject": 2
  }
}
```

Each value is a non-negative safe integer; `null` explicitly means unlimited. The validator rejects unsupported versions, missing or unknown keys, and malformed values. Pure evaluators check workspace-wide project/member quotas separately from per-project plan/chat quotas. The private control bot has a read-only workspace billing screen showing whether a plan is assigned, current billing status, live project/member counts, and per-project active-plan/active-chat counts. Projects in ARCHIVED state and archived creator plans are excluded from those counts; only active connected chats count. An invalid feature configuration is shown as a warning rather than being treated as unlimited.

Quota-sensitive mutations serialize on the workspace row using a row lock and READ COMMITTED transactions, then query the latest usage before writing. Project and creator-plan creation are checked in both command and button flows. Workspace member limits are checked when an invitation is accepted (not when a link is issued); the invite claim and membership insert roll back together if the quota is full; the invited user sees a quota message and can retry the still-unused link after capacity is freed. Restoring archived projects checks the workspace project cap and the active creator-plan/active-chat caps inside the project; restoring an archived creator plan also consumes a per-project plan slot. Telegram-confirmed chat activation/reactivation locks the workspace row and checks the per-project active-chat limit; malformed configurations and inactive platform subscriptions fail closed. Existing workspaces without an assigned platform billing record remain temporarily grandfathered and are not blocked. Existing active chats remain active while Telegram permissions remain valid; new/reactivated chats must fit the quota.

Global catalogue administration is restricted to the numeric Telegram IDs configured in `PLATFORM_ADMIN_TELEGRAM_IDS`; workspace OWNER/ADMIN roles do not grant these powers. Operators can list, create/update and activate/deactivate catalogue records in the private control bot. Each catalogue mutation and status transition is audited. A plan referenced by any `WorkspaceBilling` record cannot be edited or deactivated; changed commercial terms require a new plan code. Future workspace-assignment logic must serialize against changes to the corresponding `PlatformPlan` record.

The workspace checkout route is still a pending product decision. If it is sold as a digital service inside the SubPilot Telegram bot/Mini App, Telegram's current rules require Stars (XTR); recurring Bot API invoices currently support a 30-day period and up to 10,000 Stars per period. See [platform billing checkout decision](decisions/platform-billing-checkout.md) for the recommended route, official references and missing lifecycle work. Never infer a RUB amount from XTR.

This is enforcement groundwork, not an operational billing product: approved commercial prices/quota values, workspace-to-plan assignment, platform checkout, billing lifecycle and payment reconciliation remain pending. Catalogue management itself is available to allowlisted operators. Creator payment transactions are not charged or debited by this quota layer. No commercial prices or quota values are hard-coded.

The **Start Without Upfront Cost** offer (seven days followed by a 14% commission) is retained as an isolated commercial experiment and is not part of the default launch pricing or creator checkout flow:
- The primary launch model is fixed workspace billing; there is no default SubPilot percentage on creator transactions.
- The seven-day/14% calculator and related schema/ledger groundwork are dormant experimental components. They must not be invoked from the normal payment success path.
- Do not activate the offer, create receivables or collect a fee until the product terms, legal model, eligible merchant/payment scenarios, currency treatment and collection mechanism have been reviewed and explicitly approved.
- In particular, never infer a RUB value from an XTR amount and never debit or control a creator's Telegram Stars balance.

Platform plan limits are applied to workspaces, not to an individual creator's content transactions. Creator payments, platform subscription payments and platform commission receivables remain separate accounting domains.

### Manual subscription access and entitlement safety

The `Subscription.grantType` field distinguishes `PAID`, `MANUAL` and `TRIAL` subscriptions. Historical rows default to `PAID`; manual/trial entitlements are not represented as successful payment records. The central control bot exposes workspace OWNER/ADMIN-only operations in private chat:
- `/grantaccess PROJECT_ID | TELEGRAM_USER_ID | PLAN_ID | DAYS` grants a time-limited or lifetime entitlement. Repeating a manual grant for the same customer and plan extends the same active manual subscription rather than creating duplicate rows.
- `/trialaccess PROJECT_ID | TELEGRAM_USER_ID | PLAN_ID | DAYS` issues a trial. If DAYS is omitted, the plan's `trialDays` is used. A customer can receive one trial per project customer/plan, and an existing active subscription on that plan blocks a trial.
- `/activesubscriptions PROJECT_ID` lists active subscriptions and their IDs.
- `/revokeaccess SUBSCRIPTION_ID` marks an active subscription CANCELLED and records an audit event. The lifecycle worker revokes unused invite links and removes the subscriber from chats; this request does not bypass the normal worker/Telegram permission checks.

Manual grants create pending `SubscriptionAccessGrant` rows, which are delivered by the existing lifecycle worker using the project's primary bot. Delivery failures use the normal bounded retry/dead-letter mechanism. On expiry or early revocation, the worker checks for another current active subscription for the same customer and chat. If one exists, membership is preserved while the ending subscription's unused invite is revoked. This prevents ending one overlapping plan from removing access still granted by another plan.

### Telegram and regional rules

The payment adapter interface is deliberately separate from the product entitlement engine. The policy gate evaluates product type, checkout surface, Telegram association and provider. Paid access to Telegram channels/groups is always classified as TELEGRAM_CHANNEL_ACCESS and requires an in-Telegram Stars checkout. Other digital goods/services offered, promoted or fulfilled by the Telegram bot/Mini App also require Stars. An independent website product may be evaluated separately only when it is genuinely not offered, promoted or fulfilled by the Telegram TPA; this is not an external-checkout route for Telegram channel access. Telegram Stars are not the route for physical goods/services. Eligible physical goods/services may use third-party payment providers under Telegram's Bot Payments rules.

The gate is a Telegram product-policy check, not merchant approval. Provider eligibility is also resolved per country, merchant type, currency, product category, provider contract, tax/receipt obligations and adapter capabilities. A provider being technically integrated does not mean every workspace can use it. See docs/decisions/telegram-payment-eligibility.md for the research and decision record.

## Telegram bot topology

- The **control bot** authenticates owners through Telegram and manages workspaces/projects.
- Each **project bot** belongs to one project and uses its own BotFather token.
- A project bot is verified with Telegram's getMe before activation. SubPilot allows one active bot per project, matching the Nemiling project model and keeping invite creation, renewal reminders, refunds and expiry operations on the same bot.
- Project bots receive `my_chat_member`, `message`, `pre_checkout_query` and `chat_member` updates through POST /webhooks/telegram/:botId. Telegram's X-Telegram-Bot-Api-Secret-Token header is SHA-256 hashed and compared in constant time with the stored hash before any update is processed.
- The project bot token is encrypted at rest with AES-256-GCM. The webhook secret itself is never stored in plaintext; only its hash is stored. Plaintext secrets must never appear in logs or API responses.
- On connection, the control bot validates the token with getMe and installs a webhook at PUBLIC_API_URL. This must be a publicly reachable HTTPS origin. Newly configured project webhooks set `max_connections: 1`; the API still enforces per-bot serialization in PostgreSQL, independent of Telegram's delivery concurrency.
- Incoming project-bot updates are serialized with a PostgreSQL `WorkerLease` keyed by project bot (five-minute lease, one-minute heartbeat). If another API replica is handling an update for that bot, the endpoint returns HTTP 503 so Telegram can retry instead of running the handler concurrently. The lease is released by its owner only; an expired lease can be claimed after a crash.
- Each update is recorded in `TelegramWebhookUpdate` with `(projectBotId, sequenceEpoch, updateId)` as its idempotency key. A completed duplicate is acknowledged without re-running its handler; failed attempts retain attempt count and error class for a Telegram retry. The record is marked processed only after the handler returns successfully.
- Telegram documents `update_id` as sequential and useful for recognizing duplicates/out-of-order delivery, but says the next identifier becomes random after at least a week without updates. SubPilot increments `sequenceEpoch` after that idle interval, so a reset identifier is not mistaken for a duplicate from the previous sequence. See the [Telegram Bot API Update documentation](https://core.telegram.org/bots/api#update).
- Stateful membership events also use entity-specific cursors: `my_chat_member` tracks the latest bot-rights state per connected chat; `chat_member` tracks the latest state per project bot, chat and Telegram user. This prevents an older membership event from overwriting a newer one. Unrelated events (for example, a delayed payment event) are not dropped solely because a different update had a larger global update ID.
- Telegram retries unsuccessful webhook deliveries, but its Bot API says incoming updates are retained for no longer than 24 hours. This is not an exactly-once guarantee: external side effects that succeed immediately before a processing/acknowledgement failure can be repeated on retry. See the [Telegram Bot API webhook documentation](https://core.telegram.org/bots/api#setwebhook).
- The project bot subscribes to `my_chat_member` updates. When it is added or removed, the API upserts the connected chat and marks it active only when the bot has the permissions required for subscription access.
- `pre_checkout_query` validates a Stars invoice against the pending payment record; `successful_payment` is the only event that activates a paid entitlement.
- Invite links are generated per subscription/chat, expire after 24 hours and have a one-member limit. Their joins are tracked by `chat_member` updates.
- The API lifecycle worker checks active subscriptions once per minute, cancels unpaid Telegram Stars invoices after 24 hours, retries pending/expired invite delivery (with a five-minute retry delay), sends one reminder around three days and one around one day before expiry, and expires due subscriptions.
- When a buyer renews before expiry, the existing entitlement is extended from its current end date instead of creating overlapping subscriptions.
- On expiry, unused invite links are revoked and joined subscribers are removed from the connected chats. Failed removals remain pending for a later worker retry.
- Successful first activation queues a new-subscriber alert for the workspace creator and project creator. In a personal workspace these are normally the same user, so only one message is queued.
- Three-day and one-day expiry reminders, plus the expiry event, are queued for the workspace owner and project creator only while they remain members of that workspace. Membership is checked both when queuing and again immediately before delivery, so a removed teammate does not keep receiving queued owner alerts. Queue creation is idempotent per event/recipient and delivery retries use backoff; a Telegram send that succeeds immediately before a database acknowledgement failure can still be delivered twice.
- Each lifecycle pass acquires a PostgreSQL-backed lease with a five-minute expiry and one-minute heartbeat. Only one API replica can run the lifecycle pass at a time; a crashed worker releases naturally when its lease expires.
- Channel/group connection requires the project bot to be added with the permissions needed for the selected feature.

## Reliability and security requirements

- Project-bot webhook envelopes are durably deduplicated by bot, sequence epoch and Telegram `update_id`; stateful membership mutations also use per-entity ordering cursors. Telegram Stars receipts are independently deduplicated by the Telegram charge ID. This provides retry-safe handling for the persisted transitions, not a blanket exactly-once guarantee for every external Bot API side effect.
- Payment transitions use conditional database updates and are recorded in the payment and webhook-event ledgers. A verified Telegram `successful_payment` receipt can reconcile a stale invoice previously marked `CANCELLED`; charge IDs are deduplicated.
- Access is derived from subscription entitlements; payment events alone do not grant permanent access.
- Fixed-term subscription expiry, buyer reminders, abandoned Stars checkout cleanup, invite revocation and removal of joined members are implemented in the lifecycle worker. Failed Telegram operations remain retryable while the access grant is unrevoked. PostgreSQL lease coordination prevents concurrent lifecycle passes across API replicas.
- AuditLog writes are emitted by high-impact workspace and project mutation services. The central bot exposes per-project `/auditlog` history and agency-wide `/agencyaudit` plus CSV export; agency history is visible to OWNER/ADMIN and to members with an effective project MANAGER role (responsible-creator assignment or explicit ProjectMember MANAGER grant); a project VIEWER grant alone is insufficient. Returned records omit raw metadata, and CSV cells are protected against spreadsheet formulas. Audit coverage of every state transition is not yet exhaustive.

Agency analytics are exposed by `/agencystats [DAYS]`. The report deduplicates subscriber identities across projects by Telegram ID, reports current/new subscriptions, trials/manual grants, expiries/cancellations and period churn, classifies renewal payments from non-refunded paid charges, and keeps gross/refund/net revenue separate by currency. Per-project results include the responsible creator. OWNER/ADMIN receive workspace-wide analytics; other members receive only non-archived projects where they have effective project MANAGER access. Results are aggregate-only and do not expose subscriber cards.
- Secrets are encrypted at rest and rotated through a controlled process.
- Workspace/project ownership is checked in every API operation.
- Lifecycle work currently uses a database-backed polling worker rather than Redis. PostgreSQL leases coordinate API replicas; a durable queue may still be considered later if throughput or scheduling requirements outgrow this design.
- Admin actions must be permission-checked; creator data is isolated by workspace/project scope.

## Internationalization

Russia is the first operating market, with RUB as the initial default currency. The data model stores currency and provider at transaction/project level so international markets can be added without making the database Russia-specific.

Thailand and the United States are future market candidates, not assumed to be enabled. Each market requires its own provider review, merchant onboarding, tax/consumer-law assessment and product eligibility rules before launch.
