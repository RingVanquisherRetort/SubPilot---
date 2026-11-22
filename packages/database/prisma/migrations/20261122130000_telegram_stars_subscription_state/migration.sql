CREATE TYPE "TelegramStarSubscriptionState" AS ENUM ('ACTIVE', 'CANCELED', 'FAILED');

ALTER TABLE "Subscription"
    ADD COLUMN "telegramStarInitialChargeId" TEXT,
    ADD COLUMN "telegramStarSubscriptionState" "TelegramStarSubscriptionState",
    ADD COLUMN "telegramStarSubscriptionLastUpdateId" INTEGER,
    ADD COLUMN "telegramStarSubscriptionSequenceEpoch" INTEGER;

CREATE UNIQUE INDEX "Subscription_telegramStarInitialChargeId_key"
    ON "Subscription"("telegramStarInitialChargeId");

CREATE INDEX "Subscription_telegramStarSubscriptionState_endsAt_idx"
    ON "Subscription"("telegramStarSubscriptionState", "endsAt");
