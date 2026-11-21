import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatWorkspaceBillingOverview,
  type WorkspaceBillingOverview
} from "./workspace-billing-service.js";

function overview(
  overrides: Partial<WorkspaceBillingOverview> = {}
): WorkspaceBillingOverview {
  return {
    workspaceName: "Demo",
    usage: {
      projects: 1,
      members: 2,
      projectUsage: [
        { id: "p1", name: "Creator A", plans: 3, connectedChats: 2 }
      ]
    },
    billing: null,
    ...overrides
  };
}

test("shows current usage without inventing an unassigned platform plan", () => {
  const result = formatWorkspaceBillingOverview(overview());

  assert.match(result, /Тариф платформы пока не назначен/);
  assert.match(result, /лимиты тарифа ещё не применяются/);
  assert.match(result, /Проекты: 1/);
  assert.match(result, /Участники \(включая владельца\): 2/);
  assert.match(result, /Тарифы авторов: 3/);
  assert.match(result, /Активные площадки: 2/);
});

test("shows the assigned plan and finite quota usage", () => {
  const result = formatWorkspaceBillingOverview(overview({
    usage: {
      projects: 1,
      members: 2,
      projectsDecision: {
        allowed: true, limit: 3, currentUsage: 1, requested: 1, remaining: 2
      },
      membersDecision: {
        allowed: true, limit: 5, currentUsage: 2, requested: 1, remaining: 3
      },
      projectUsage: [{
        id: "p1",
        name: "Creator A",
        plans: 3,
        connectedChats: 2,
        plansDecision: {
          allowed: true, limit: 10, currentUsage: 3, requested: 1, remaining: 7
        },
        connectedChatsDecision: {
          allowed: false, limit: 2, currentUsage: 2, requested: 1, remaining: 0
        }
      }]
    },
    billing: {
      status: "ACTIVE",
      currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
      plan: {
        code: "studio",
        title: "Studio",
        price: "990",
        currency: "RUB",
        billingPeriodDays: 30,
        isActive: true
      },
      configuration: "valid",
      featureConfig: {
        schemaVersion: 1,
        limits: {
          projects: 3,
          members: 5,
          plansPerProject: 10,
          connectedChatsPerProject: 2
        }
      }
    }
  }));

  assert.match(result, /План: Studio \(studio\)/);
  assert.match(result, /Стоимость: 990 RUB за 30 дн\./);
  assert.match(result, /Статус подписки: активен/);
  assert.match(result, /Проекты: 1 \/ 3/);
  assert.match(result, /Участники \(включая владельца\): 2 \/ 5/);
  assert.match(result, /Активные площадки: 2 \/ 2/);
});

test("warns about malformed plan limits without displaying fabricated quotas", () => {
  const result = formatWorkspaceBillingOverview(overview({
    billing: {
      status: "ACTIVE",
      currentPeriodEnd: null,
      plan: {
        code: "broken",
        title: "Broken",
        price: "0",
        currency: "RUB",
        billingPeriodDays: 30,
        isActive: true
      },
      configuration: "invalid"
    }
  }));

  assert.match(result, /конфигурация лимитов тарифа некорректна/i);
  assert.match(result, /Проекты: 1/);
  assert.doesNotMatch(result, /Проекты: 1 \/ 0/);
});

test("renders unlimited resources without using zero as an unlimited sentinel", () => {
  const result = formatWorkspaceBillingOverview(overview({
    usage: {
      projects: 2,
      members: 4,
      projectsDecision: {
        allowed: true, limit: null, currentUsage: 2, requested: 1, remaining: null
      },
      membersDecision: {
        allowed: false, limit: 0, currentUsage: 4, requested: 1, remaining: 0
      },
      projectUsage: [{
        id: "p1",
        name: "Creator A",
        plans: 3,
        connectedChats: 2,
        plansDecision: {
          allowed: true, limit: null, currentUsage: 3, requested: 1, remaining: null
        },
        connectedChatsDecision: {
          allowed: true, limit: 0, currentUsage: 0, requested: 1, remaining: 0
        }
      }]
    }
  }));

  assert.match(result, /Проекты: 2 \/ без ограничений/);
  assert.match(result, /Участники \(включая владельца\): 4 \/ отключено \(0\)/);
  assert.match(result, /Тарифы авторов: 3 \/ без ограничений/);
  assert.match(result, /Активные площадки: 2 \/ отключено \(0\)/);
});
