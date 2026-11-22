import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOptionalRecurringFlag } from "./recurring-plan-input.js";

test("parses supported positive and negative recurring flags", () => {
  for (const value of ["да", "ДА", "yes", "TRUE", "1"]) {
    assert.equal(parseOptionalRecurringFlag(value), true);
  }
  for (const value of ["нет", "НЕТ", "no", "FALSE", "0"]) {
    assert.equal(parseOptionalRecurringFlag(value), false);
  }
});

test("distinguishes an omitted flag from an invalid flag", () => {
  assert.equal(parseOptionalRecurringFlag(undefined), undefined);
  assert.equal(parseOptionalRecurringFlag(""), undefined);
  assert.equal(parseOptionalRecurringFlag("   "), undefined);
  assert.equal(parseOptionalRecurringFlag("maybe"), null);
  assert.equal(parseOptionalRecurringFlag("2"), null);
});
