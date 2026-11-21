ALTER TABLE "SubscriptionAccessGrant"
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "deliveryLastError" TEXT,
  ADD COLUMN "deliveryFailedAt" TIMESTAMP(3);

CREATE INDEX "SubscriptionAccessGrant_revokedAt_deliveryAttempts_deliveryNextAttemptAt_idx"
  ON "SubscriptionAccessGrant"("revokedAt", "deliveryAttempts", "deliveryNextAttemptAt");
