CREATE TABLE "InviteCompensation" ("inviteLink" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL,
 "telegramBotId" BIGINT NOT NULL, "telegramChatId" BIGINT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "InviteCompensation_nextAttemptAt_idx" ON "InviteCompensation" ("nextAttemptAt");
