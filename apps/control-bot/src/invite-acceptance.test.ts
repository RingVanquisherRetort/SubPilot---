import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkspaceInviteAcceptanceMessage } from "./invite-acceptance.js";

test("new workspace member is told the role granted by the invite", () => {
  const message = buildWorkspaceInviteAcceptanceMessage("Studio", "MANAGER", false);
  assert.match(message, /Вы присоединились/);
  assert.match(message, /Ваша роль: manager/);
});

test("existing workspace member is told their preserved actual role", () => {
  const message = buildWorkspaceInviteAcceptanceMessage("Studio", "VIEWER", true);
  assert.match(message, /Вы уже состоите/);
  assert.match(message, /роль сохранена: viewer/);
  assert.doesNotMatch(message, /Вы присоединились/);
});
