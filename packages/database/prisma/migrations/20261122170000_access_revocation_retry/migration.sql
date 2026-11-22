ALTER TABLE "SubscriptionAccessGrant"
    ADD COLUMN "revocationAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "revocationNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "revocationLastError" TEXT;

CREATE INDEX "SubscriptionAccessGrant_revokedAt_revocationNextAttemptAt_revocationAttempts_idx"
    ON "SubscriptionAccessGrant"("revokedAt", "revocationNextAttemptAt", "revocationAttempts");

CREATE INDEX "SubscriptionAccessGrant_revocationReason_revocationNextAttemptAt_idx"
    ON "SubscriptionAccessGrant"("revocationReason", "revocationNextAttemptAt");
