ALTER TABLE "ProjectBot"
  ADD COLUMN "updateSequenceEpoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastUpdateAt" TIMESTAMP(3);

ALTER TABLE "ConnectedChat"
  ADD COLUMN "lastBotStatusUpdateId" INTEGER,
  ADD COLUMN "lastBotStatusSequenceEpoch" INTEGER;

CREATE TABLE "TelegramWebhookUpdate" (
  "id" TEXT NOT NULL,
  "projectBotId" TEXT NOT NULL,
  "updateId" INTEGER NOT NULL,
  "sequenceEpoch" INTEGER NOT NULL,
  "updateType" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "lastError" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "TelegramWebhookUpdate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TelegramChatMemberCursor" (
  "id" TEXT NOT NULL,
  "projectBotId" TEXT NOT NULL,
  "telegramChatId" BIGINT NOT NULL,
  "telegramUserId" BIGINT NOT NULL,
  "lastUpdateId" INTEGER NOT NULL,
  "sequenceEpoch" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelegramChatMemberCursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelegramWebhookUpdate_projectBotId_updateId_key"
  ON "TelegramWebhookUpdate"("projectBotId", "updateId");
CREATE INDEX "TelegramWebhookUpdate_projectBotId_processedAt_receivedAt_idx"
  ON "TelegramWebhookUpdate"("projectBotId", "processedAt", "receivedAt");

CREATE UNIQUE INDEX "TelegramChatMemberCursor_projectBotId_telegramChatId_telegramUserId_key"
  ON "TelegramChatMemberCursor"("projectBotId", "telegramChatId", "telegramUserId");
CREATE INDEX "TelegramChatMemberCursor_projectBotId_sequenceEpoch_lastUpdateId_idx"
  ON "TelegramChatMemberCursor"("projectBotId", "sequenceEpoch", "lastUpdateId");

ALTER TABLE "TelegramWebhookUpdate"
  ADD CONSTRAINT "TelegramWebhookUpdate_projectBotId_fkey"
  FOREIGN KEY ("projectBotId") REFERENCES "ProjectBot"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TelegramChatMemberCursor"
  ADD CONSTRAINT "TelegramChatMemberCursor_projectBotId_fkey"
  FOREIGN KEY ("projectBotId") REFERENCES "ProjectBot"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
