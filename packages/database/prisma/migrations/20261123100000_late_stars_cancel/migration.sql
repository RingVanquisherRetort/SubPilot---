ALTER TABLE "Subscription" ADD COLUMN "lateStarsCancelDueAt" TIMESTAMP(3), ADD COLUMN "lateStarsCancelBotId" TEXT;
CREATE INDEX "Subscription_lateStarsCancelDueAt_idx" ON "Subscription" ("lateStarsCancelDueAt");
UPDATE "Subscription" s SET "lateStarsCancelDueAt" = CURRENT_TIMESTAMP, "lateStarsCancelBotId" = p.metadata->>'projectBotId'
FROM "Payment" p WHERE s.status='CANCELLED' AND s."telegramStarSubscriptionState"='ACTIVE'
AND s."telegramStarInitialChargeId"=p."providerPaymentId" AND p."subscriptionId"=s.id AND p.provider='TELEGRAM_STARS'
AND p.metadata->>'projectBotId' IS NOT NULL;
