CREATE TYPE "SubscriptionGrantType" AS ENUM ('PAID', 'MANUAL', 'TRIAL');

ALTER TABLE "Subscription"
ADD COLUMN "grantType" "SubscriptionGrantType" NOT NULL DEFAULT 'PAID';

CREATE INDEX "Subscription_customerId_planId_grantType_createdAt_idx"
ON "Subscription"("customerId", "planId", "grantType", "createdAt");
