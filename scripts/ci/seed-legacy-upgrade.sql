-- Representative rows from the original 0_init schema.
INSERT INTO "User" ("id", "telegramId", "firstName", "updatedAt")
VALUES ('upgrade-user', 9000000001, 'Upgrade Test', CURRENT_TIMESTAMP);

INSERT INTO "Workspace" ("id", "name", "slug", "type", "createdById", "updatedAt")
VALUES ('upgrade-workspace', 'Upgrade Workspace', 'upgrade-workspace', 'AGENCY', 'upgrade-user', CURRENT_TIMESTAMP);

INSERT INTO "User" ("id", "telegramId", "firstName", "updatedAt")
VALUES
  ('upgrade-manager', 9000000003, 'Upgrade Manager', CURRENT_TIMESTAMP),
  ('upgrade-viewer', 9000000004, 'Upgrade Viewer', CURRENT_TIMESTAMP);

INSERT INTO "WorkspaceMember" ("id", "workspaceId", "userId", "role")
VALUES
  ('upgrade-manager-membership', 'upgrade-workspace', 'upgrade-manager', 'MANAGER'),
  ('upgrade-viewer-membership', 'upgrade-workspace', 'upgrade-viewer', 'VIEWER');

INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt")
VALUES ('upgrade-project', 'upgrade-workspace', 'Upgrade Project', 'upgrade-project', CURRENT_TIMESTAMP);

INSERT INTO "ProjectCustomer" ("id", "projectId", "telegramUserId", "firstName", "updatedAt")
VALUES ('upgrade-customer', 'upgrade-project', 9000000002, 'Legacy Customer', CURRENT_TIMESTAMP);

INSERT INTO "CreatorPlan" ("id", "projectId", "title", "price", "currency", "durationDays", "updatedAt")
VALUES ('upgrade-creator-plan', 'upgrade-project', 'Legacy Creator Plan', 100, 'XTR', 30, CURRENT_TIMESTAMP);

INSERT INTO "PlatformPlan" ("id", "code", "title", "price", "currency", "billingPeriodDays", "updatedAt")
VALUES ('upgrade-plan', 'upgrade-plan', 'Upgrade Plan', 100, 'RUB', 30, CURRENT_TIMESTAMP);

INSERT INTO "Subscription" ("id", "projectId", "customerId", "planId", "status", "updatedAt")
VALUES ('upgrade-subscription', 'upgrade-project', 'upgrade-customer', 'upgrade-creator-plan', 'ACTIVE', CURRENT_TIMESTAMP);

INSERT INTO "WorkspaceBilling" (
  "id", "workspaceId", "platformPlanId", "status", "currentPeriodStart", "currentPeriodEnd", "updatedAt"
)
VALUES (
  'upgrade-billing', 'upgrade-workspace', 'upgrade-plan', 'ACTIVE',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP
);

INSERT INTO "PlatformPayment" (
  "id", "workspaceBillingId", "provider", "amount", "currency", "status", "paidAt", "updatedAt"
)
VALUES (
  'upgrade-payment', 'upgrade-billing', 'YOOKASSA', 100, 'RUB', 'SUCCEEDED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
