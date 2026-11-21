import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlatformPlanUpsertInput } from "./platform-plan-catalog.js";

test("parses a complete platform plan with explicit finite quotas", () => {
  const plan = parsePlatformPlanUpsertInput(
    "start | Старт | 0 | RUB | 30 | 1 | 2 | 3 | 4 | Базовый план"
  );
  assert.deepEqual(plan, {
    code: "start",
    title: "Старт",
    description: "Базовый план",
    price: "0",
    currency: "RUB",
    billingPeriodDays: 30,
    features: {
      schemaVersion: 1,
      limits: {
        projects: 1,
        members: 2,
        plansPerProject: 3,
        connectedChatsPerProject: 4
      }
    }
  });
});

test("asterisk means explicitly unlimited and zero remains disabled", () => {
  const plan = parsePlatformPlanUpsertInput(
    "agency | Агентство | 1490.50 | RUB | 30 | * | * | 0 | * | "
  );
  assert.deepEqual(plan.features, {
    schemaVersion: 1,
    limits: {
      projects: null,
      members: null,
      plansPerProject: 0,
      connectedChatsPerProject: null
    }
  });
  assert.equal(plan.description, null);
  assert.equal(plan.price, "1490.50");
});

test("rejects missing fields, invalid plan code and title", () => {
  assert.throws(() => parsePlatformPlanUpsertInput("start | Старт"), /Формат/);
  assert.throws(
    () => parsePlatformPlanUpsertInput("Start | Старт | 100 | RUB | 30 | 1 | 1 | 1 | 1 |"),
    /Код тарифа/
  );
  assert.throws(
    () => parsePlatformPlanUpsertInput("start | A | 100 | RUB | 30 | 1 | 1 | 1 | 1 |"),
    /Название/
  );
});

test("rejects negative, malformed and over-precision prices without numeric coercion", () => {
  for (const price of ["-1", "1.234", "1,25", "1e3", "10000000000"]) {
    assert.throws(
      () => parsePlatformPlanUpsertInput(`start | Старт | ${price} | RUB | 30 | 1 | 1 | 1 | 1 |`),
      /Цена/
    );
  }
});

test("rejects malformed currency and billing period", () => {
  for (const currency of ["руб", "RUB1", "ru", "rur"]) {
    assert.throws(
      () => parsePlatformPlanUpsertInput(`start | Старт | 100 | ${currency} | 30 | 1 | 1 | 1 | 1 |`),
      /Валюта/
    );
  }
  for (const period of ["0", "-1", "30.5", "3651", "abc"]) {
    assert.throws(
      () => parsePlatformPlanUpsertInput(`start | Старт | 100 | RUB | ${period} | 1 | 1 | 1 | 1 |`),
      /Период/
    );
  }
});

test("rejects invalid quota values and excessive descriptions", () => {
  for (const quota of ["-1", "1.5", "1e3", "abc"]) {
    assert.throws(
      () => parsePlatformPlanUpsertInput(`start | Старт | 100 | RUB | 30 | ${quota} | 1 | 1 | 1 |`),
      /Лимит/
    );
  }
  assert.throws(
    () => parsePlatformPlanUpsertInput(`start | Старт | 100 | RUB | 30 | 1 | 1 | 1 | 1 | ${"x".repeat(301)}`),
    /Описание/
  );
});
