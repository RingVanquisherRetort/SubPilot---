import assert from "node:assert/strict";
import { test } from "node:test";
import { wasInitialSubscriptionActivationEvent } from "./payment-event-notification.js";

test("only a recorded first activation requires a new-subscriber owner notification", () => {
  assert.equal(wasInitialSubscriptionActivationEvent({ isInitialActivation: true }), true);
  assert.equal(wasInitialSubscriptionActivationEvent({ isInitialActivation: false }), false);
  assert.equal(wasInitialSubscriptionActivationEvent({}), false);
  assert.equal(wasInitialSubscriptionActivationEvent(null), false);
  assert.equal(wasInitialSubscriptionActivationEvent(["invalid"]), false);
});
