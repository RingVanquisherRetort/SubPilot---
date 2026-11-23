ALTER TABLE "Subscription"
  ADD COLUMN "adminStarsCancelPending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "adminStarsCancelDueAt" TIMESTAMP(3),
  ADD COLUMN "adminStarsCancelBotId" TEXT,
  ADD COLUMN "adminStarsCancelClaim" TEXT,
  ADD COLUMN "adminStarsCancelActorUserId" TEXT,
  ADD COLUMN "adminStarsCancelWorkspaceId" TEXT;

CREATE INDEX "Subscription_adminStarsCancelDueAt_idx"
  ON "Subscription"("adminStarsCancelDueAt");

ALTER TABLE "Subscription"
  ADD COLUMN "adminStarsCancelAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "adminStarsCancelLastError" TEXT;
