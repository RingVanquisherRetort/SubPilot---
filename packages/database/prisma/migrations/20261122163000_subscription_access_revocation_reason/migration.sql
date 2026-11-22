CREATE TYPE "SubscriptionAccessRevocationReason" AS ENUM (
    'SUBSCRIPTION_EXPIRED',
    'ADMIN_REVOKED',
    'ADMIN_EXCLUDED',
    'LEGACY_UNKNOWN'
);

ALTER TABLE "SubscriptionAccessGrant"
    ADD COLUMN "revocationReason" "SubscriptionAccessRevocationReason";

-- Existing revoked grants need a reason before the worker starts distinguishing
-- natural expiry from moderation/admin decisions. Unknown active-parent revokes
-- fail closed until an owner explicitly re-grants the destination.
UPDATE "SubscriptionAccessGrant" AS grant
SET "revocationReason" = CASE
    WHEN subscription."status"::text = 'EXPIRED'
        THEN 'SUBSCRIPTION_EXPIRED'::"SubscriptionAccessRevocationReason"
    WHEN subscription."status"::text = 'CANCELLED'
        THEN 'ADMIN_REVOKED'::"SubscriptionAccessRevocationReason"
    ELSE 'LEGACY_UNKNOWN'::"SubscriptionAccessRevocationReason"
END
FROM "Subscription" AS subscription
WHERE grant."subscriptionId" = subscription."id"
  AND grant."revokedAt" IS NOT NULL;
