import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("manual grants and trials are audited, scoped, and revoke without fabricating payments", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const {
    grantManualSubscriptionAccess,
    grantTrialSubscriptionAccess,
    listActiveProjectSubscriptions,
    ManualSubscriptionAccessError,
    revokeSubscriptionAccessManually
  } = await import("./manual-subscription-access-service.js");

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let actorId: string | undefined;
  let managerId: string | undefined;
  let workspaceId: string | undefined;
  let projectId: string | undefined;

  try {
    const owner = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Manual access owner" }
    });
    actorId = owner.id;
    const manager = await prisma.user.create({
      data: { telegramId: telegramBase + 1n, firstName: "Manual access manager" }
    });
    managerId = manager.id;

    const workspace = await prisma.workspace.create({
      data: {
        name: "Manual access test " + suffix,
        slug: "manual-access-" + suffix,
        createdById: owner.id,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: manager.id, role: "MANAGER" }
          ]
        }
      }
    });
    workspaceId = workspace.id;

    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Manual access project",
        slug: "project-" + suffix
      }
    });
    projectId = project.id;

    const plan = await prisma.creatorPlan.create({
      data: {
        projectId: project.id,
        title: "Manual access plan",
        price: "100",
        currency: "XTR",
        durationDays: 30,
        trialDays: 14
      }
    });
    const chat = await prisma.connectedChat.create({
      data: {
        projectId: project.id,
        telegramChatId: telegramBase + 2n,
        type: "CHANNEL",
        title: "Manual access channel",
        isActive: true
      }
    });
    await prisma.creatorPlanChat.create({
      data: { creatorPlanId: plan.id, connectedChatId: chat.id }
    });

    await assert.rejects(
      grantManualSubscriptionAccess({
        workspaceId: workspace.id,
        projectId: project.id,
        planId: plan.id,
        telegramUserId: String(telegramBase + 10n),
        actorUserId: manager.id
      }),
      (error: unknown) => error instanceof ManualSubscriptionAccessError &&
        error.code === "ACTOR_NOT_AUTHORIZED"
    );

    const manualInput = {
      workspaceId: workspace.id,
      projectId: project.id,
      planId: plan.id,
      telegramUserId: String(telegramBase + 10n),
      actorUserId: owner.id,
      durationDays: 30
    };
    const firstManual = await grantManualSubscriptionAccess(manualInput);
    assert.equal(firstManual.renewedExistingGrant, false);
    assert.equal(firstManual.destinations, 1);
    assert.ok(firstManual.endsAt);

    const secondManual = await grantManualSubscriptionAccess(manualInput);
    assert.equal(secondManual.subscriptionId, firstManual.subscriptionId);
    assert.equal(secondManual.renewedExistingGrant, true);
    assert.ok(secondManual.endsAt);
    assert.ok(secondManual.endsAt.getTime() >= firstManual.endsAt.getTime() + 29 * 24 * 60 * 60_000);

    const manualRow = await prisma.subscription.findUniqueOrThrow({
      where: { id: firstManual.subscriptionId }
    });
    assert.equal(manualRow.grantType, "MANUAL");
    assert.equal(manualRow.status, "ACTIVE");
    assert.equal(await prisma.payment.count({ where: { subscriptionId: firstManual.subscriptionId } }), 0);
    const grant = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: {
        subscriptionId_connectedChatId: {
          subscriptionId: firstManual.subscriptionId,
          connectedChatId: chat.id
        }
      }
    });
    assert.equal(grant.inviteLink, "");
    assert.equal(grant.revokedAt, null);

    const trialInput = {
      workspaceId: workspace.id,
      projectId: project.id,
      planId: plan.id,
      telegramUserId: String(telegramBase + 11n),
      actorUserId: owner.id
    };
    const trial = await grantTrialSubscriptionAccess(trialInput);
    assert.equal(trial.destinations, 1);
    assert.ok(trial.endsAt.getTime() > Date.now());
    const trialRow = await prisma.subscription.findUniqueOrThrow({
      where: { id: trial.subscriptionId }
    });
    assert.equal(trialRow.grantType, "TRIAL");
    assert.equal(await prisma.payment.count({ where: { subscriptionId: trial.subscriptionId } }), 0);

    await assert.rejects(
      grantTrialSubscriptionAccess(trialInput),
      (error: unknown) => error instanceof ManualSubscriptionAccessError &&
        error.code === "TRIAL_ALREADY_USED"
    );

    const listed = await listActiveProjectSubscriptions({
      workspaceId: workspace.id,
      projectId: project.id
    });
    assert.equal(listed.length, 2);
    assert.deepEqual(new Set(listed.map((item) => item.grantType)), new Set(["MANUAL", "TRIAL"]));

    const revoked = await revokeSubscriptionAccessManually({
      subscriptionId: firstManual.subscriptionId,
      workspaceId: workspace.id,
      actorUserId: owner.id
    });
    assert.equal(revoked.subscriptionId, firstManual.subscriptionId);
    const cancelled = await prisma.subscription.findUniqueOrThrow({
      where: { id: firstManual.subscriptionId }
    });
    assert.equal(cancelled.status, "CANCELLED");
    assert.ok(cancelled.cancelledAt);
    assert.ok(cancelled.endsAt && cancelled.endsAt.getTime() <= Date.now());

    const revokeAudit = await prisma.auditLog.findFirst({
      where: {
        action: "SUBSCRIPTION_ACCESS_REVOKE_REQUESTED",
        resourceId: firstManual.subscriptionId,
        actorUserId: owner.id,
        workspaceId: workspace.id
      }
    });
    const grantAudit = await prisma.auditLog.findFirst({
      where: {
        action: "SUBSCRIPTION_ACCESS_GRANTED_MANUALLY",
        resourceId: firstManual.subscriptionId,
        actorUserId: owner.id,
        workspaceId: workspace.id
      }
    });
    const trialAudit = await prisma.auditLog.findFirst({
      where: {
        action: "SUBSCRIPTION_TRIAL_GRANTED",
        resourceId: trial.subscriptionId,
        actorUserId: owner.id,
        workspaceId: workspace.id
      }
    });
    assert.ok(revokeAudit);
    assert.ok(grantAudit);
    assert.ok(trialAudit);
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
    if (managerId) await prisma.user.deleteMany({ where: { id: managerId } });
  }
});
