import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTelegramMembershipDeparture } from "./telegram-membership-departure.js";

test("a member who leaves voluntarily keeps the subscription permission", () => {
  assert.equal(classifyTelegramMembershipDeparture("left", false), "VOLUNTARY_EXIT");
});

test("a kicked member is an administrative exclusion", () => {
  assert.equal(classifyTelegramMembershipDeparture("kicked", false), "ADMIN_EXCLUSION");
});

test("a restricted non-member is an administrative exclusion", () => {
  assert.equal(classifyTelegramMembershipDeparture("restricted", false), "ADMIN_EXCLUSION");
});

test("a restricted member is not a departure", () => {
  assert.equal(classifyTelegramMembershipDeparture("restricted", true), null);
});

test("active membership states are not departures", () => {
  assert.equal(classifyTelegramMembershipDeparture("member", true), null);
  assert.equal(classifyTelegramMembershipDeparture("administrator", true), null);
  assert.equal(classifyTelegramMembershipDeparture("creator", true), null);
});
