import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldActivateConnectedChat } from "./connected-chat-quota.js";

const features = (connectedChatsPerProject: number | null) => ({
  schemaVersion: 1,
  limits: {
    projects: 3,
    members: 5,
    plansPerProject: 10,
    connectedChatsPerProject
  }
});

const billing = (overrides: Record<string, unknown> = {}) => ({
  status: "ACTIVE",
  platformPlanIsActive: true,
  features: features(2),
  ...overrides
});

test("denies activation when Telegram has not granted the required chat permissions", () => {
  assert.equal(shouldActivateConnectedChat({
    hasRequiredRights: false,
    wasAlreadyActive: false,
    billing: null,
    currentActiveChats: 0
  }), false);
});

test("preserves an already active chat when permissions remain valid", () => {
  assert.equal(shouldActivateConnectedChat({
    hasRequiredRights: true,
    wasAlreadyActive: true,
    billing: billing({ status: "EXPIRED" }),
    currentActiveChats: 10
  }), true);
});

test("grandfathers workspaces without an assigned platform billing record", () => {
  assert.equal(shouldActivateConnectedChat({
    hasRequiredRights: true,
    wasAlreadyActive: false,
    billing: null,
    currentActiveChats: 0
  }), true);
});

test("allows active and trialing plan activations below the per-project quota", () => {
  for (const status of ["ACTIVE", "TRIALING"]) {
    assert.equal(shouldActivateConnectedChat({
      hasRequiredRights: true,
      wasAlreadyActive: false,
      billing: billing({ status }),
      currentActiveChats: 1
    }), true);
  }
});

test("denies activation when the plan is not active or the workspace subscription is inactive", () => {
  assert.equal(shouldActivateConnectedChat({
    hasRequiredRights: true,
    wasAlreadyActive: false,
    billing: billing({ status: "PAST_DUE" }),
    currentActiveChats: 0
  }), false);
  assert.equal(shouldActivateConnectedChat({
    hasRequiredRights: true,
    wasAlreadyActive: false,
    billing: billing({ platformPlanIsActive: false }),
    currentActiveChats: 0
  }), false);
});

test("denies activation at the configured limit and allows it below the limit", () => {
  assert.equal(shouldActivateConnectedChat({
    hasRequiredRights: true,
    wasAlreadyActive: false,
    billing: billing(),
    currentActiveChats: 2
  }), false);
  assert.equal(shouldActivateConnectedChat({
    hasRequiredRights: true,
    wasAlreadyActive: false,
    billing: billing(),
    currentActiveChats: 1
  }), true);
});

test("supports an explicit unlimited chat limit but not zero", () => {
  assert.equal(shouldActivateConnectedChat({
    hasRequiredRights: true,
    wasAlreadyActive: false,
    billing: billing({ features: features(null) }),
    currentActiveChats: 50_000
  }), true);
  assert.equal(shouldActivateConnectedChat({
    hasRequiredRights: true,
    wasAlreadyActive: false,
    billing: billing({ features: features(0) }),
    currentActiveChats: 0
  }), false);
});

test("fails closed for malformed, incomplete, unknown or unsupported feature configuration", () => {
  const invalidFeatures = [
    null,
    [],
    { schemaVersion: 2, limits: features(2).limits },
    { schemaVersion: 1, limits: { ...features(2).limits, projects: undefined } },
    { schemaVersion: 1, limits: { ...features(2).limits, unexpected: 1 } },
    { schemaVersion: 1, limits: { ...features(2).limits, connectedChatsPerProject: -1 } },
    { schemaVersion: 1, limits: { ...features(2).limits, members: "5" } }
  ];

  for (const invalid of invalidFeatures) {
    assert.equal(shouldActivateConnectedChat({
      hasRequiredRights: true,
      wasAlreadyActive: false,
      billing: billing({ features: invalid }),
      currentActiveChats: 0
    }), false);
  }
});

test("fails closed when the live usage counter is invalid", () => {
  for (const currentActiveChats of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(shouldActivateConnectedChat({
      hasRequiredRights: true,
      wasAlreadyActive: false,
      billing: billing(),
      currentActiveChats
    }), false);
  }
});
