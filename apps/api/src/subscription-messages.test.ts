import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExpiredSubscriptionNotice } from "./subscription-messages.js";

test("expiry notice confirms access was revoked when every destination succeeded", () => {
  const message = buildExpiredSubscriptionNotice("Закрытый клуб", []);

  assert.match(message, /Доступ к закрытым площадкам прекращён/);
  assert.match(message, /Вы можете оформить её снова/);
  assert.doesNotMatch(message, /может сохраняться/);
});

test("expiry notice does not claim access was revoked when a destination failed", () => {
  const message = buildExpiredSubscriptionNotice("Закрытый клуб", ["Основной канал"]);

  assert.match(message, /не смог отключить доступ на всех площадках/);
  assert.match(message, /Администратор проекта уведомлён/);
  assert.match(message, /доступ на отдельных площадках может сохраняться/);
  assert.doesNotMatch(message, /Доступ к закрытым площадкам прекращён/);
});
