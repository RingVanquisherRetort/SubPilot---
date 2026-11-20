import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCurrentOwnerNotificationRecipient,
  selectOwnerNotificationRecipientIds
} from "./owner-notifications-policy.js";

test("workspace owner is always a notification recipient", () => {
  assert.deepEqual(selectOwnerNotificationRecipientIds("owner", null, false), ["owner"]);
});

test("project creator receives notifications only while still in the workspace", () => {
  assert.deepEqual(selectOwnerNotificationRecipientIds("owner", "creator", true), ["owner", "creator"]);
  assert.deepEqual(selectOwnerNotificationRecipientIds("owner", "creator", false), ["owner"]);
});

test("owner and creator are deduplicated when they are the same user", () => {
  assert.deepEqual(selectOwnerNotificationRecipientIds("owner", "owner", false), ["owner"]);
});

test("a former workspace member is no longer eligible at delivery time", () => {
  assert.equal(isCurrentOwnerNotificationRecipient("former-member", "owner", false), false);
  assert.equal(isCurrentOwnerNotificationRecipient("current-member", "owner", true), true);
  assert.equal(isCurrentOwnerNotificationRecipient("owner", "owner", false), true);
});
