import assert from "node:assert/strict";
import { test } from "node:test";
import { hasRequiredSubscriptionChatRights, isExplicitTelegramNonMemberError } from "./telegram-chat-access.js";

test("chat creator has the rights required for subscription access", () => {
  assert.equal(hasRequiredSubscriptionChatRights({ status: "creator" }), true);
});

test("administrator with invite and restrict rights can manage subscription access", () => {
  assert.equal(hasRequiredSubscriptionChatRights({
    status: "administrator",
    can_invite_users: true,
    can_restrict_members: true
  }), true);
});

test("administrator without invite rights cannot manage subscription access", () => {
  assert.equal(hasRequiredSubscriptionChatRights({
    status: "administrator",
    can_invite_users: false,
    can_restrict_members: true
  }), false);
});

test("administrator without member restriction rights cannot manage subscription access", () => {
  assert.equal(hasRequiredSubscriptionChatRights({
    status: "administrator",
    can_invite_users: true,
    can_restrict_members: false
  }), false);
});

test("ordinary, left and banned members cannot manage subscription access", () => {
  for (const status of ["member", "left", "kicked", "restricted"]) {
    assert.equal(hasRequiredSubscriptionChatRights({ status }), false);
  }
});

test("only explicit Telegram non-member errors permit invite creation", () => {
  assert.equal(isExplicitTelegramNonMemberError(new Error("USER_NOT_PARTICIPANT")), true);
  assert.equal(isExplicitTelegramNonMemberError({ description: "Bad Request: user not found" }), true);
  assert.equal(isExplicitTelegramNonMemberError({ description: "Bad Request: user is not a participant" }), true);
  assert.equal(isExplicitTelegramNonMemberError(new Error("ETIMEDOUT")), false);
  assert.equal(isExplicitTelegramNonMemberError({ description: "Forbidden: bot is not an administrator" }), false);
  assert.equal(isExplicitTelegramNonMemberError({ description: "Too Many Requests: retry after 30" }), false);
  assert.equal(isExplicitTelegramNonMemberError(null), false);
});
