ALTER TABLE "Subscription"
  ADD COLUMN "adminAccessRevokedAt" TIMESTAMP(3);

-- Older manually revoked paid subscriptions can be identified by their
-- access-grant history or an established Telegram Stars recurring anchor.
-- A timed-out pending invoice has neither and must remain eligible for a late
-- successful-payment update.
UPDATE "Subscription" AS subscription
SET "adminAccessRevokedAt" = COALESCE(subscription."cancelledAt", subscription."updatedAt")
WHERE subscription."status" = 'CANCELLED'
  AND subscription."cancelledAt" IS NOT NULL
  AND (
    subscription."telegramStarInitialChargeId" IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM "SubscriptionAccessGrant" AS access_grant
      WHERE access_grant."subscriptionId" = subscription."id"
    )
    OR EXISTS (
      SELECT 1
      FROM "AuditLog" AS audit
      WHERE audit."resourceType" = 'Subscription'
        AND audit."resourceId" = subscription."id"
        AND audit."action" IN (
          'SUBSCRIPTION_ACCESS_REVOKE_REQUESTED',
          'SUBSCRIPTION_ACCESS_REVOKE_CONFIRMED'
        )
    )
  );
