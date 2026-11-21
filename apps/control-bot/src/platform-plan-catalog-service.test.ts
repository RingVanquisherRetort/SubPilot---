import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("PostgreSQL platform plan catalogue audits changes and protects plans assigned to workspaces", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const {
    PlatformPlanCatalogError,
    setPlatformPlanActive,
    upsertPlatformPlan
  } = await import("./platform-plan-catalog-service.js");
  const { parsePlatformPlanUpsertInput } = await import("./platform-plan-catalog.js");

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramId = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let actorId: string | undefined;
  let workspaceId: string | undefined;
  const planIds: string[] = [];

  try {
    const actor = await prisma.user.create({
      data: { telegramId, firstName: "Platform catalog test operator" }
    });
    actorId = actor.id;

    const assignedInput = parsePlatformPlanUpsertInput(
      `assigned-${suffix} | Assigned plan | 199 | RUB | 30 | 2 | 3 | 4 | 5 | Test plan`
    );
    const assignedPlan = await upsertPlatformPlan(assignedInput, actor.id);
    planIds.push(assignedPlan.id);

    const workspace = await prisma.workspace.create({
      data: {
        name: "Assigned platform plan test",
        slug: `plan-test-${suffix}`,
        createdById: actor.id,
        members: { create: { userId: actor.id, role: "OWNER" } },
        billing: {
          create: {
            platformPlanId: assignedPlan.id,
            status: "ACTIVE"
          }
        }
      }
    });
    workspaceId = workspace.id;

    const changedAssignedInput = parsePlatformPlanUpsertInput(
      `assigned-${suffix} | Assigned plan changed | 299 | RUB | 30 | 5 | 6 | 7 | 8 | Changed`
    );
    await assert.rejects(
      upsertPlatformPlan(changedAssignedInput, actor.id),
      (error: unknown) =>
        error instanceof PlatformPlanCatalogError &&
        error.code === "PLAN_HAS_ASSIGNED_WORKSPACES"
    );
    await assert.rejects(
      setPlatformPlanActive(assignedInput.code, false, actor.id),
      (error: unknown) =>
        error instanceof PlatformPlanCatalogError &&
        error.code === "PLAN_HAS_ASSIGNED_WORKSPACES"
    );

    const unchanged = await prisma.platformPlan.findUniqueOrThrow({
      where: { id: assignedPlan.id }
    });
    assert.equal(unchanged.title, "Assigned plan");
    assert.equal(unchanged.price.toString(), "199");
    assert.equal(unchanged.isActive, true);

    const draftInput = parsePlatformPlanUpsertInput(
      `draft-${suffix} | Draft plan | 0 | RUB | 14 | 1 | 1 | 1 | 1 | Initial draft`
    );
    const draft = await upsertPlatformPlan(draftInput, actor.id);
    planIds.push(draft.id);

    const revisedDraftInput = parsePlatformPlanUpsertInput(
      `draft-${suffix} | Draft plan v2 | 99.50 | RUB | 30 | 2 | 4 | * | 3 | Revised draft`
    );
    const revisedDraft = await upsertPlatformPlan(revisedDraftInput, actor.id);
    assert.equal(revisedDraft.id, draft.id);
    assert.equal(revisedDraft.title, "Draft plan v2");
    assert.equal(revisedDraft.price.toString(), "99.5");
    assert.deepEqual(revisedDraft.features, revisedDraftInput.features);

    const disabled = await setPlatformPlanActive(draftInput.code, false, actor.id);
    assert.equal(disabled.isActive, false);
    const enabled = await setPlatformPlanActive(draftInput.code, true, actor.id);
    assert.equal(enabled.isActive, true);

    const auditCount = await prisma.auditLog.count({
      where: { resourceType: "PlatformPlan", resourceId: draft.id, actorUserId: actor.id }
    });
    assert.equal(auditCount, 4, "create, update, disable and enable should each be audited");
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (planIds.length) await prisma.platformPlan.deleteMany({ where: { id: { in: planIds } } });
    if (actorId) {
      await prisma.auditLog.deleteMany({ where: { actorUserId: actorId } });
      await prisma.user.deleteMany({ where: { id: actorId } });
    }
    await prisma.$disconnect();
  }
});
