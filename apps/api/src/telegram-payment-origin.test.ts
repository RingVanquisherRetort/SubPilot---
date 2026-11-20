import assert from "node:assert/strict";
import { test } from "node:test";
import { isPaymentFromProjectBot } from "./telegram-payment-origin.js";

test("payment is accepted only by the project bot recorded on its invoice", () => {
  assert.equal(isPaymentFromProjectBot({ projectBotId: "bot-a" }, "bot-a"), true);
  assert.equal(isPaymentFromProjectBot({ projectBotId: "bot-a" }, "bot-b"), false);
});

test("legacy payment metadata without a bot origin remains compatible", () => {
  assert.equal(isPaymentFromProjectBot({ planId: "plan-a" }, "bot-a"), true);
  assert.equal(isPaymentFromProjectBot(null, "bot-a"), true);
});

test("malformed legacy metadata without a bot origin remains compatible", () => {
  assert.equal(isPaymentFromProjectBot(["invalid"], "bot-a"), true);
});
