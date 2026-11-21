CREATE TYPE "PlatformPaymentProvider" AS ENUM (
  'YOOKASSA',
  'YOOMONEY',
  'PRODAMUS',
  'ROBOKASSA',
  'CLOUDPAYMENTS',
  'CRYPTO_PAY'
);

CREATE TABLE "PlatformPaymentProviderConnection" (
  "id" TEXT NOT NULL,
  "provider" "PlatformPaymentProvider" NOT NULL,
  "label" TEXT NOT NULL,
  "environment" "ProviderEnvironment" NOT NULL DEFAULT 'LIVE',
  "credentialsEncrypted" TEXT NOT NULL,
  "publicConfig" JSONB,
  "status" "ProviderConnectionStatus" NOT NULL DEFAULT 'PENDING',
  "lastVerifiedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformPaymentProviderConnection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PlatformPayment"
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "platformPlanId" TEXT,
  ADD COLUMN "providerConnectionId" TEXT,
  ADD COLUMN "externalCheckoutId" TEXT,
  ADD COLUMN "checkoutUrl" TEXT,
  ADD COLUMN "planCodeSnapshot" TEXT,
  ADD COLUMN "planTitleSnapshot" TEXT,
  ADD COLUMN "billingPeriodDaysSnapshot" INTEGER,
  ADD COLUMN "initiatedByTelegramId" BIGINT,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "refundedAt" TIMESTAMP(3),
  ADD COLUMN "refundAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "refundAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refundLastError" TEXT;

UPDATE "PlatformPayment" AS payment
SET
  "workspaceId" = billing."workspaceId",
  "platformPlanId" = billing."platformPlanId",
  "planCodeSnapshot" = plan."code",
  "planTitleSnapshot" = plan."title",
  "billingPeriodDaysSnapshot" = plan."billingPeriodDays"
FROM "WorkspaceBilling" AS billing
JOIN "PlatformPlan" AS plan ON plan."id" = billing."platformPlanId"
WHERE payment."workspaceBillingId" = billing."id";

ALTER TABLE "PlatformPayment"
  ALTER COLUMN "workspaceId" SET NOT NULL,
  ALTER COLUMN "platformPlanId" SET NOT NULL,
  ALTER COLUMN "planCodeSnapshot" SET NOT NULL,
  ALTER COLUMN "planTitleSnapshot" SET NOT NULL,
  ALTER COLUMN "billingPeriodDaysSnapshot" SET NOT NULL,
  ALTER COLUMN "workspaceBillingId" DROP NOT NULL;

ALTER TABLE "PlatformPayment"
  DROP CONSTRAINT "PlatformPayment_workspaceBillingId_fkey";

ALTER TABLE "PlatformPayment"
  ADD CONSTRAINT "PlatformPayment_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformPayment_platformPlanId_fkey"
    FOREIGN KEY ("platformPlanId") REFERENCES "PlatformPlan"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformPayment_providerConnectionId_fkey"
    FOREIGN KEY ("providerConnectionId") REFERENCES "PlatformPaymentProviderConnection"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "PlatformPayment_workspaceBillingId_fkey"
    FOREIGN KEY ("workspaceBillingId") REFERENCES "WorkspaceBilling"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "PlatformPaymentProviderConnection_provider_label_key"
  ON "PlatformPaymentProviderConnection"("provider", "label");
CREATE INDEX "PlatformPaymentProviderConnection_provider_status_idx"
  ON "PlatformPaymentProviderConnection"("provider", "status");

CREATE UNIQUE INDEX "PlatformPayment_providerConnectionId_providerPaymentId_key"
  ON "PlatformPayment"("providerConnectionId", "providerPaymentId");
CREATE INDEX "PlatformPayment_workspaceId_status_createdAt_idx"
  ON "PlatformPayment"("workspaceId", "status", "createdAt");
CREATE INDEX "PlatformPayment_platformPlanId_idx"
  ON "PlatformPayment"("platformPlanId");

CREATE TABLE "PlatformPaymentWebhookEvent" (
  "id" TEXT NOT NULL,
  "providerConnectionId" TEXT NOT NULL,
  "dedupeKey" TEXT,
  "providerEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "signatureVerifiedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  CONSTRAINT "PlatformPaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformPaymentWebhookEvent_dedupeKey_key"
  ON "PlatformPaymentWebhookEvent"("dedupeKey");
CREATE UNIQUE INDEX "PlatformPaymentWebhookEvent_providerConnectionId_providerEventId_key"
  ON "PlatformPaymentWebhookEvent"("providerConnectionId", "providerEventId");
CREATE INDEX "PlatformPaymentWebhookEvent_processedAt_receivedAt_idx"
  ON "PlatformPaymentWebhookEvent"("processedAt", "receivedAt");
CREATE INDEX "PlatformPaymentWebhookEvent_providerConnectionId_receivedAt_idx"
  ON "PlatformPaymentWebhookEvent"("providerConnectionId", "receivedAt");

ALTER TABLE "PlatformPaymentWebhookEvent"
  ADD CONSTRAINT "PlatformPaymentWebhookEvent_providerConnectionId_fkey"
  FOREIGN KEY ("providerConnectionId") REFERENCES "PlatformPaymentProviderConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
