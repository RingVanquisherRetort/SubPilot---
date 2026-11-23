ALTER TABLE "Subscription"
  ADD COLUMN "buyerStarsBotId" TEXT,
  ADD COLUMN "buyerStarsChargeId" TEXT,
  ADD COLUMN "buyerStarsCanceled" BOOLEAN,
  ADD COLUMN "buyerStarsDueAt" TIMESTAMP(3),
  ADD COLUMN "buyerStarsClaim" TEXT;
CREATE INDEX "Subscription_buyerStarsDueAt_idx" ON "Subscription"("buyerStarsDueAt");
