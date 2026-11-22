CREATE TABLE "SubscriptionAccessScope" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "connectedChatId" TEXT NOT NULL,
    "desiredRevision" BIGINT NOT NULL DEFAULT 0,
    "appliedRevision" BIGINT NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubscriptionAccessScope_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SubscriptionAccessScope_customerId_fkey"
        FOREIGN KEY ("customerId") REFERENCES "ProjectCustomer"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SubscriptionAccessScope_connectedChatId_fkey"
        FOREIGN KEY ("connectedChatId") REFERENCES "ConnectedChat"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SubscriptionAccessScope_customerId_connectedChatId_key"
    ON "SubscriptionAccessScope"("customerId", "connectedChatId");
CREATE UNIQUE INDEX "SubscriptionAccessScope_leaseToken_key"
    ON "SubscriptionAccessScope"("leaseToken");
CREATE INDEX "SubscriptionAccessScope_nextAttemptAt_leaseExpiresAt_createdAt_idx"
    ON "SubscriptionAccessScope"("nextAttemptAt", "leaseExpiresAt", "createdAt");
CREATE INDEX "SubscriptionAccessScope_desiredRevision_appliedRevision_idx"
    ON "SubscriptionAccessScope"("desiredRevision", "appliedRevision");
