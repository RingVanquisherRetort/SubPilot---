import assert from "node:assert/strict";
import { test } from "node:test";
import { selectedGrantRecipient } from "./grant-recipient.js";

test("recipient picker accepts a person without a username and rejects stale or duplicate selections", () => {
  const pending = { requestId: 13, expiresAt: Date.now() + 60_000 };
  const person = { user_id: 2 ** 40 };
  const shared = { request_id: 13, users: [person] };
  assert.equal(selectedGrantRecipient(pending, shared), person);
  assert.equal(selectedGrantRecipient({ ...pending, selectedUserId: person.user_id }, shared), undefined);
  assert.equal(selectedGrantRecipient({ ...pending, expiresAt: 0 }, shared), undefined);
  assert.equal(selectedGrantRecipient(pending, { ...shared, request_id: 12 }), undefined);
  assert.equal(selectedGrantRecipient(pending, { ...shared, users: [] }), undefined);
  assert.equal(selectedGrantRecipient(pending, { ...shared, users: [person, person] }), undefined);
});
