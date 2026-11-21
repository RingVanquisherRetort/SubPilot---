DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = 'upgrade-user' AND "telegramId" = 9000000001) THEN
    RAISE EXCEPTION 'User row was not preserved by migrations';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = 'upgrade-workspace' AND "slug" = 'upgrade-workspace') THEN
    RAISE EXCEPTION 'Workspace row was not preserved by migrations';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = 'upgrade-project' AND "merchantType"::text = 'INDIVIDUAL') THEN
    RAISE EXCEPTION 'Project row was not preserved or merchantType default was not applied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "PlatformPayment"
    WHERE "id" = 'upgrade-payment'
      AND "workspaceId" = 'upgrade-workspace'
      AND "platformPlanId" = 'upgrade-plan'
      AND "planCodeSnapshot" = 'upgrade-plan'
      AND "planTitleSnapshot" = 'Upgrade Plan'
      AND "billingPeriodDaysSnapshot" = 30
      AND "workspaceBillingId" = 'upgrade-billing'
  ) THEN
    RAISE EXCEPTION 'PlatformPayment backfill did not preserve/link legacy billing data';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Subscription"
    WHERE "id" = 'upgrade-subscription' AND "grantType"::text = 'PAID'
  ) THEN
    RAISE EXCEPTION 'Legacy subscription grantType default was not applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = '20261121210000_manual_subscription_grants' AND "finished_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'Latest migration is not recorded as successfully applied';
  END IF;
END $$;
