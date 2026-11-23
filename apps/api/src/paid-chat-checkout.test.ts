import assert from "node:assert/strict";
import { test } from "node:test";
import { paidInvoiceChatIds } from "./paid-chat-checkout.js";

test("checkout verifies every distinct destination from the original invoice", () => {
  assert.deepEqual(paidInvoiceChatIds({ chatIds: ["-1001", "-1002", "-1001"] }), [-1001n, -1002n]);
  for (const metadata of [null, {}, { chatIds: [] }, { chatIds: ["-1001", "bad"] }, { chatIds: ["9999999999999999999"] }]) {
    assert.equal(paidInvoiceChatIds(metadata), null);
  }
});
