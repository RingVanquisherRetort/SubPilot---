-- Track a Telegram refund in progress so an API/database interruption can be reconciled safely.
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUNDING';

ALTER TABLE "Payment"
  ADD COLUMN "refundAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "refundAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refundLastError" TEXT;
