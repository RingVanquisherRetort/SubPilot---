-- CreateEnum
CREATE TYPE "PlatformCommissionEntryType" AS ENUM ('SALE_FEE', 'REFUND_ADJUSTMENT', 'MANUAL_ADJUSTMENT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "PlatformCommissionStatus" AS ENUM ('ACCRUED', 'INVOICED', 'PAID', 'VOID');

-- AlterTable
ALTER TABLE "WorkspaceBilling"
  ADD COLUMN "introductoryOfferCode" TEXT,
  ADD COLUMN "introductoryOfferAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "introductoryTrialStartedAt" TIMESTAMP(3),
  ADD COLUMN "introductoryTrialEndsAt" TIMESTAMP(3),
  ADD COLUMN "introductoryCommissionBasisPoints" INTEGER,
  ADD COLUMN "introductoryTermsVersion" TEXT;

-- CreateTable
CREATE TABLE "PlatformCommissionEntry" (
  "id" TEXT NOT NULL,
  "workspaceBillingId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "creatorPaymentId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "entryType" "PlatformCommissionEntryType" NOT NULL,
  "status" "PlatformCommissionStatus" NOT NULL DEFAULT 'ACCRUED',
  "baseAmount" DECIMAL(12,2) NOT NULL,
  "baseCurrency" TEXT NOT NULL,
  "rateBasisPoints" INTEGER,
  "feeAmount" DECIMAL(12,2) NOT NULL,
  "feeCurrency" TEXT NOT NULL,
  "invoiceReference" TEXT,
  "paidAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformCommissionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformCommissionEntry_idempotencyKey_key" ON "PlatformCommissionEntry"("idempotencyKey");
CREATE INDEX "PlatformCommissionEntry_workspaceBillingId_status_createdAt_idx" ON "PlatformCommissionEntry"("workspaceBillingId", "status", "createdAt");
CREATE INDEX "PlatformCommissionEntry_projectId_createdAt_idx" ON "PlatformCommissionEntry"("projectId", "createdAt");
CREATE INDEX "PlatformCommissionEntry_creatorPaymentId_entryType_idx" ON "PlatformCommissionEntry"("creatorPaymentId", "entryType");

-- AddForeignKey
ALTER TABLE "PlatformCommissionEntry" ADD CONSTRAINT "PlatformCommissionEntry_workspaceBillingId_fkey" FOREIGN KEY ("workspaceBillingId") REFERENCES "WorkspaceBilling"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlatformCommissionEntry" ADD CONSTRAINT "PlatformCommissionEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformCommissionEntry" ADD CONSTRAINT "PlatformCommissionEntry_creatorPaymentId_fkey" FOREIGN KEY ("creatorPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
