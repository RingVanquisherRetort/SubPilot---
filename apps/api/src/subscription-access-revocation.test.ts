import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("expired subscription does not revoke a chat covered by another active subscription", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const { findOtherActiveSubscriptionAccessGrant } =
    await import("./subscription-access-revocation.js");

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let actorId: string | undefined;
  let workspaceId: string | undefined;

  try {
    const actor = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Overlapping subscription test" }
    });
    actorId = actor.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Overlap test " + suffix,
        slug: "overlap-" + suffix,
        createdById: actor.id,
        members: { create: { userId: actor.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;
    const project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: "Overlap project", slug: "project-" + suffix }
    });
    const plan = await prisma.creatorPlan.create({
      data: {
        projectId: project.id,
        title: "Overlap plan",
        price: "100",
        currency: "XTR",
        durationDays: 30
      }
    });
    const customer = await prisma.projectCustomer.create({
      data: { projectId: project.id, telegramUserId: telegramBase + 1n }
    });
    const chat = await prisma.connectedChat.create({
      data: {
        projectId: project.id,
        telegramChatId: telegramBase + 2n,
        type: "CHANNEL",
        title: "Overlapping access chat"
      }
    });
    const now = new Date();
    const expiredSubscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        planId: plan.id,
        status: "CANCELLED",
        grantType: "MANUAL",
        startsAt: new Date(now.getTime() - 10 * 24 * 60 * 60_000),
        endsAt: now
      }
    });
    const activeSubscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        planId: plan.id,
        status: "ACTIVE",
        grantType: "PAID",
        startsAt: new Date(now.getTime() - 24 * 60 * 60_000),
        endsAt: new Date(now.getTime() + 10 * 24 * 60 * 60_000)
      }
    });
    const currentGrant = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: expiredSubscription.id,
        connectedChatId: chat.id,
        inviteLink: "",
        expiresAt: new Date(0),
        joinedAt: new Date(now.getTime() - 60_000)
      }
    });
    const otherGrant = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: activeSubscription.id,
        connectedChatId: chat.id,
        inviteLink: "",
        expiresAt: new Date(0),
        joinedAt: new Date(now.getTime() - 30_000)
      }
    });

    const other = await findOtherActiveSubscriptionAccessGrant({
      subscriptionId: expiredSubscription.id,
      customerId: customer.id,
      connectedChatId: chat.id,
      now
    });
    assert.deepEqual(other, { id: otherGrant.id });

    await prisma.subscription.update({
      where: { id: activeSubscription.id },
      data: { endsAt: new Date(now.getTime() - 1) }
    });
    const expiredOther = await findOtherActiveSubscriptionAccessGrant({
      subscriptionId: expiredSubscription.id,
      customerId: customer.id,
      connectedChatId: chat.id,
      now
    });
    assert.equal(expiredOther, null);

    await prisma.subscription.update({
      where: { id: activeSubscription.id },
      data: {
        status: "ACTIVE",
        startsAt: new Date(now.getTime() + 60_000),
        endsAt: new Date(now.getTime() + 24 * 60 * 60_000)
      }
    });
    const futureOther = await findOtherActiveSubscriptionAccessGrant({
      subscriptionId: expiredSubscription.id,
      customerId: customer.id,
      connectedChatId: chat.id,
      now
    });
    assert.equal(futureOther, null);

    assert.equal(currentGrant.revokedAt, null);
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
  }
});
