# Nemiling — product and integration reference

Reviewed: 20 November 2026  
Basis: Nemiling's public website, public knowledge base and public offer. This is a product/technical reference, not a legal opinion and not evidence of Nemiling's private implementation.

## 1. Product model

Nemiling positions itself as a Telegram monetization automation service, not as a bank, payment institution, merchant of record, or wallet. The public product model has a central management bot, @Nemilin_bot, plus a separate creator-owned Telegram bot for each project. The central bot is the owner's control panel; the creator bot talks to subscribers, accepts payments and manages access. The owner creates the bot in BotFather, passes its bot token to Nemiling and adds that bot as an administrator to the channel/group.

One owner account can manage multiple projects, each with its own settings, tariffs, bots and payment methods.

## 2. Monetization features documented publicly

The public product pages describe four primary formats:

1. Paid subscriptions to Telegram channels and groups. A tariff defines price, duration and target spaces. Access is granted after payment and revoked when the paid period ends unless renewed.
2. Paid messages in groups. Membership can be free while sending a message requires payment.
3. Paid conversations/consultations with a timer.
4. Donations, separate from subscription turnover limits.

Tariff options described include trials, one-time/non-renewing tariffs, limited seats, separate first-purchase and renewal prices, conditional eligibility, categories and sorting, an external direct tariff URL, lifetime access, and per-tariff switches for renewals and promo codes.

Other publicly listed features include promo codes, referral/UTM links, paid and free access links, gift subscriptions, API/webhooks, bot branding, media broadcasts, giveaways, payment pause, project transfer, custom expiry messages and a subscriber history/card. SubPilot should not copy the full subscriber dossier as a default: its current product direction is lighter-weight payment history and aggregate statistics.

## 3. Payment connection pattern

Nemiling's help centre lists YooMoney, YooKassa, Prodamus, Robokassa, CloudPayments, PayPal, Crypto Pay, Telegram Stars, Telegram Payments and semi-automatic payment methods. Availability depends on the merchant's country and legal status.

For the documented Robokassa setup:
- the creator registers their own merchant account;
- they generate merchant Password #1 and Password #2;
- the documented hash algorithm is MD5;
- they set the Result URL to https://nemiling.info/webhooks/robokassa;
- Robokassa sends the payment result to Nemiling's server;
- the bot then performs the Telegram-side action.

The public product description says the creator's payment provider processes the funds and pays them to the creator's account; Nemiling receives a technical confirmation and automates access. This is the important architectural pattern: creator-owned merchant connection + server-side signed webhook + idempotent payment record + entitlement activation. The platform does not need to collect the creator's funds into a shared balance.

The public payment-method page also distinguishes Telegram Payments (a BotFather-issued provider token and an in-Telegram payment form) from an independent hosted checkout / provider webhook. Those must not be represented as the same integration.

The public pages state that recurring charges are offered with YooKassa, CloudPayments, Robokassa and Prodamus. Other listed methods are described as requiring manual renewal. Crypto Pay is documented as a separate CryptoBot integration. Semi-automatic methods rely on an administrator's manual payment confirmation.

## 4. What the public offer says

The public offer dated 1 April 2026 is between the service provider and the project Administrator. It describes the service as organizing paid access to the Administrator's Telegram content and automating collection of payments for the Administrator through a payment system connected by the Administrator.

The offer also places responsibility for the Administrator's content and its compliance with applicable platform rules on the Administrator. This offer is a service agreement between Nemiling and the administrator; it should not be mistaken for a complete buyer-facing subscription contract or proof of Telegram approval for every payment route.

## 5. Telegram policy constraint — separate from observed Nemiling behaviour

The current Telegram Bot Platform Developer Terms distinguish physical goods/services from digital goods/services. Section 6.1 permits third-party payment providers for physical goods and services. Section 6.2 says transactions for digital goods and services offered through a Telegram bot or mini app must be conducted exclusively in Telegram Stars, and warns that use of alternative payment systems for digital goods/services may lead to notices, app inaccessibility in store versions or termination from the Bot Platform.

A paid subscription granting access to a closed Telegram channel/group is a digital-access scenario. Nemiling's public pages describe external providers for paid Telegram-channel subscriptions. That creates an apparent tension between the public Nemiling feature description and Telegram's published developer terms. The public material does not establish whether Nemiling has a special approval, relies on a different user journey, has received enforcement notices, or has another compliance basis. Therefore this reference must not assert either that Nemiling is violating the rules or that its method is approved.

For SubPilot, provider support must be separated from feature eligibility:
- Stars is the native payment path for digital access sold through the Telegram bot.
- A provider adapter can be reusable, but this alone does not make a payment route eligible for every product type.
- External provider checkout must not be built as a disguised route to bypass Telegram's Stars requirement for digital subscriptions sold inside Telegram.
- Any external provider flow must be separately reviewed against Telegram policy, the provider's merchant contract, country/merchant eligibility, consumer obligations, refunds and tax/receipt requirements before activation.

## 6. Implications for SubPilot architecture

The parts worth modelling closely are:
- one central control bot for an owner/agency workspace;
- a creator-owned bot per project;
- multiple projects under one workspace;
- payment connections scoped to a project and encrypted at rest;
- multiple payment methods attached to one project;
- webhook endpoints that authenticate the provider, validate amount/currency/order reference, deduplicate events and only then activate an entitlement;
- creator-direct settlement rather than a SubPilot custodial balance, where the provider actually supports that merchant model;
- recurring billing as a distinct capability requiring stored mandate/payment-method references, cancellation, retry and failed-payment handling;
- manual payment confirmation as a separate, explicitly audited method;
- tariff snapshots, renewals, trials, promo/referral links and direct tariff links;
- receipts/tax data supported by the provider and the merchant's jurisdiction.

## 7. Current SubPilot implementation state

Implemented in the current feature branch:
- central control bot and multiple workspaces/projects;
- project Telegram bots and connected chats;
- creator tariff catalogue;
- Telegram Stars one-time invoice, pre-checkout validation and successful-payment activation;
- Stars payment history and refund command;
- lifecycle expiry, buyer reminders and owner notifications;
- encrypted merchant-connection schema and a provider-adapter interface/registry;
- /terms and /paysupport in the Stars buyer bot.

Not yet implemented:
- YooKassa, YooMoney, Prodamus, Robokassa, CloudPayments, PayPal or Crypto Pay adapters;
- provider-specific credential setup, signature validation and webhook routes;
- recurring provider billing and mandate cancellation;
- manual payment-confirmation workflow;
- provider reconciliation, chargeback processing and per-payment subscription-period ledger;
- SubPilot's own platform billing checkout.

The provider enums and connection model are scaffolding only. They must not be marketed as live integrations.

## Public sources reviewed

- https://nemiling.info/about/
- https://nemiling.info/help/platyozhnye-sistemy/
- https://nemiling.info/help/platyozhnye-sistemy/robokassa/
- https://nemiling.info/help/platyozhnye-sistemy/telegram-payments/
- https://nemiling.info/help/platnye-podpiski/
- https://nemiling.info/help/platnye-podpiski/rekurrentnye-platezhi/
- https://nemiling.info/offer/
- https://telegram.org/tos/bot-developers
