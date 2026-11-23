CREATE TABLE "TelegramRemovalIntent" (
  "botId" BIGINT NOT NULL,
  "telegramChatId" BIGINT NOT NULL,
  "telegramUserId" BIGINT NOT NULL,
  "untilDate" INTEGER NOT NULL,
  PRIMARY KEY ("botId", "telegramChatId", "telegramUserId", "untilDate")
);
