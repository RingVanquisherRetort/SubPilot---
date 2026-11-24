import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { shouldActivateConnectedChat } from "./connected-chat-quota.js";

test("PostgreSQL workspace lock serializes simultaneous Telegram chat activations", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const suffix = randomUUID();
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let ownerId: string | undefined;
  let workspaceId: string | undefined;
  let platformPlanId: string | undefined;

  try {
    const owner = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Chat quota test owner" }
    });
    ownerId = owner.id;

    const workspace = await prisma.workspace.create({
      data: {
        name: "Chat quota concurrency test",
        slug: `chat-quota-${suffix}`,
        createdById: owner.id,
        members: { create: { userId: owner.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;

    const platformPlan = await prisma.platformPlan.create({
      data: {
        code: `chat-quota-test-${suffix}`,
        title: "Chat quota test",
        price: "100",
        currency: "RUB",
        billingPeriodDays: 30,
        isActive: true,
        features: {
          schemaVersion: 1,
          limits: {
            projects: 3,
            members: 5,
            plansPerProject: 10,
            connectedChatsPerProject: 1
          }
        }
      }
    });
    platformPlanId = platformPlan.id;

    await prisma.workspaceBilling.create({
      data: {
        workspaceId: workspace.id,
        platformPlanId: platformPlan.id,
        status: "ACTIVE"
      }
    });

    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        creatorUserId: owner.id,
        name: "Chat quota project",
        slug: `chat-project-${suffix.slice(0, 8)}`,
        countryCode: "RU",
        defaultCurrency: "RUB"
      }
    });

    const connectChat = (index: number) => prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspace.id} FOR UPDATE`;
      const billing = await tx.workspaceBilling.findUnique({
        where: { workspaceId: workspace.id },
        include: { platformPlan: true }
      });
      const currentActiveChats = billing
        ? await tx.connectedChat.count({ where: { projectId: project.id, isActive: true } })
        : 0;

      const isActive = shouldActivateConnectedChat({
        hasRequiredRights: true,
        wasAlreadyActive: false,
        billing: billing ? {
          status: billing.status,
          currentPeriodEnd: billing.currentPeriodEnd,
          platformPlanIsActive: billing.platformPlan.isActive,
          features: billing.platformPlan.features
        } : null,
        currentActiveChats
      });

      return tx.connectedChat.create({
        data: {
          projectId: project.id,
          telegramChatId: telegramBase + BigInt(100 + index),
          type: "CHANNEL",
          title: `Test channel ${index}`,
          isActive
        }
      });
    }, { isolationLevel: "ReadCommitted" });

    const activations = await Promise.all([connectChat(1), connectChat(2)]);
    assert.equal(activations.filter((chat) => chat.isActive).length, 1);
    assert.equal(await prisma.connectedChat.count({
      where: { projectId: project.id, isActive: true }
    }), 1);

    const inactiveChat = activations.find((chat) => !chat.isActive);
    const activeChat = activations.find((chat) => chat.isActive);
    assert.ok(inactiveChat);
    assert.ok(activeChat);

    const activationAtLimit = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspace.id} FOR UPDATE`;
      const billing = await tx.workspaceBilling.findUnique({
        where: { workspaceId: workspace.id },
        include: { platformPlan: true }
      });
      const currentActiveChats = await tx.connectedChat.count({
        where: { projectId: project.id, isActive: true }
      });
      return shouldActivateConnectedChat({
        hasRequiredRights: true,
        wasAlreadyActive: false,
        billing: billing ? {
          status: billing.status,
          currentPeriodEnd: billing.currentPeriodEnd,
          platformPlanIsActive: billing.platformPlan.isActive,
          features: billing.platformPlan.features
        } : null,
        currentActiveChats
      });
    }, { isolationLevel: "ReadCommitted" });
    assert.equal(activationAtLimit, false);

    await prisma.connectedChat.update({
      where: { id: activeChat.id },
      data: { isActive: false }
    });

    const activationAfterSlotFreed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspace.id} FOR UPDATE`;
      const billing = await tx.workspaceBilling.findUnique({
        where: { workspaceId: workspace.id },
        include: { platformPlan: true }
      });
      const currentActiveChats = await tx.connectedChat.count({
        where: { projectId: project.id, isActive: true }
      });
      return shouldActivateConnectedChat({
        hasRequiredRights: true,
        wasAlreadyActive: false,
        billing: billing ? {
          status: billing.status,
          currentPeriodEnd: billing.currentPeriodEnd,
          platformPlanIsActive: billing.platformPlan.isActive,
          features: billing.platformPlan.features
        } : null,
        currentActiveChats
      });
    }, { isolationLevel: "ReadCommitted" });
    assert.equal(activationAfterSlotFreed, true);
    assert.equal(inactiveChat.isActive, false);
    await prisma.workspaceBilling.update({
      where: { workspaceId: workspace.id },
      data: { currentPeriodEnd: new Date(0) }
    });
    assert.equal((await connectChat(3)).isActive, false);
    await prisma.workspaceBilling.update({
      where: { workspaceId: workspace.id },
      data: { currentPeriodEnd: new Date(Date.now() + 60_000) }
    });
    assert.equal((await connectChat(4)).isActive, true);
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (platformPlanId) await prisma.platformPlan.deleteMany({ where: { id: platformPlanId } });
    if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
  }
});
