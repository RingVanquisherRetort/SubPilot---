import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldQueueNewSubscriberNotification } from "./payment-event-notification.js";

test("only a recorded first activation with a still-succeeded payment requires an owner alert", () => {
  assert.equal(shouldQueueNewSubscriberNotification({ isInitialActivation: true }, "SUCCEEDED"), true);
  assert.equal(shouldQueueNewSubscriberNotification({ isInitialActivation: false }, "SUCCEEDED"), false);
  assert.equal(shouldQueueNewSubscriberNotification({ isInitialActivation: true }, "REFUNDED"), false);
  assert.equal(shouldQueueNewSubscriberNotification({ isInitialActivation: true }, "REFUNDING"), false);
  assert.equal(shouldQueueNewSubscriberNotification({}, "SUCCEEDED"), false);
  assert.equal(shouldQueueNewSubscriberNotification(null, "SUCCEEDED"), false);
});
