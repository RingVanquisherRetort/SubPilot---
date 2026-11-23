CREATE INDEX "TelegramRemovalIntent_membership_deadline_idx"
ON "TelegramRemovalIntent" ("telegramChatId", "telegramUserId", "untilDate");
