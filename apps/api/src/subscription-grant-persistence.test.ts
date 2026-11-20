import assert from "node:assert/strict";
import { test } from "node:test";
import { getSubscriptionGrantChatIds } from "./subscription-grant-persistence.js";

test("paid entitlement retains inactive purchased destinations for later delivery retry", () => {
  const ids = getSubscriptionGrantChatIds([
    { id: "active-chat", isActive: true },
    { id: "temporarily-inactive-chat", isActive: false }
  ]);

  assert.deepEqual(ids, ["active-chat", "temporarily-inactive-chat"]);
});

test("duplicate channel rows do not create duplicate grant targets", () => {
  const ids = getSubscriptionGrantChatIds([
    { id: "chat-a", isActive: true },
    { id: "chat-a", isActive: false },
    { id: "chat-b", isActive: false }
  ]);

  assert.deepEqual(ids, ["chat-a", "chat-b"]);
});
