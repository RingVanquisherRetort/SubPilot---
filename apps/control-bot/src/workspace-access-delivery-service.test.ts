import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("workspace access-delivery dead letters are scoped, auditable and manually recoverable", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const {
    listWorkspaceFailedAccessDeliveries,
    retryWorkspaceFailedAccessDelivery
  } = await import("./workspace-access-delivery-service.js");

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let actorId: string | undefined;
  let workspaceId: string | undefined;
  let grantId: string | undefined;

  try {
    const actor = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Access delivery operator test" }
    });
    actorId = actor.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Access delivery test " + suffix,
        slug: "access-delivery-" + suffix,
        createdById: actor.id,
        members: { create: { userId: actor.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Access delivery project",
        slug: "project-" + suffix
      }
    });
    const plan = await prisma.creatorPlan.create({
      data: {
        projectId: project.id,
        title: "Access delivery plan",
        price: "100",
        currency: "XTR",
        durationDays: 30
      }
    });
    const customer = await prisma.projectCustomer.create({
      data: {
        projectId: project.id,
        telegramUserId: telegramBase + 1n,
        firstName: "Subscriber"
      }
    });
    const chat = await prisma.connectedChat.create({
      data: {
        projectId: project.id,
        telegramChatId: telegramBase + 2n,
        type: "CHANNEL",
        title: "Restricted test channel",
        isActive: true
      }
    });
    const subscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 24 * 60 * 60_000)
      }
    });
    const grant = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: subscription.id,
        connectedChatId: chat.id,
        inviteLink: "",
        expiresAt: new Date(0),
        deliveryAttempts: 10,
        deliveryNextAttemptAt: new Date(),
        deliveryLastError: "INVITE_CREATION_FAILED",
        deliveryFailedAt: new Date()
      }
    });
    grantId = grant.id;

    const listed = await listWorkspaceFailedAccessDeliveries(workspace.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, grant.id);
    assert.equal(listed[0]?.connectedChat.title, "Restricted test channel");

    assert.equal((await listWorkspaceFailedAccessDeliveries("unrelated-workspace-id")).length, 0);
    assert.equal(await retryWorkspaceFailedAccessDelivery({
      grantId: grant.id,
      workspaceId: "unrelated-workspace-id",
      actorUserId: actor.id
    }), false);

    const restored = await retryWorkspaceFailedAccessDelivery({
      grantId: grant.id,
      workspaceId: workspace.id,
      actorUserId: actor.id
    });
    assert.equal(restored, true);

    const after = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: { id: grant.id }
    });
    assert.equal(after.deliveryAttempts, 0);
    assert.equal(after.deliveryFailedAt, null);
    assert.equal(after.deliveryLastError, "OPERATOR_RETRY_REQUESTED");
    assert.ok(after.deliveryNextAttemptAt.getTime() <= Date.now() + 1_000);

    const audit = await prisma.auditLog.findFirst({
      where: {
        action: "SUBSCRIPTION_ACCESS_DELIVERY_RETRIED",
        resourceId: grant.id,
        actorUserId: actor.id,
        workspaceId: workspace.id
      }
    });
    assert.ok(audit);
    assert.equal((await listWorkspaceFailedAccessDeliveries(workspace.id)).length, 0);
  } finally {
    if (grantId) {
      await prisma.auditLog.deleteMany({ where: { resourceId: grantId } });
    }
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
  }
});
