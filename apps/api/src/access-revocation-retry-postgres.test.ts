import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { prisma } from "@subpilot/database";
import { recordSubscriptionAccessRevocationFailure } from "./project-bot-updates.js";

test("PostgreSQL revocation retry schedule isolates failed grants and preserves admin-excluded cleanup", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let actorId: string | undefined;
  let workspaceId: string | undefined;

  try {
    const actor = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Revocation retry test" }
    });
    actorId = actor.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Revocation retry " + suffix,
        slug: "revocation-retry-" + suffix,
        createdById: actor.id,
        members: { create: { userId: actor.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Revocation retry project",
        slug: "revocation-project-" + suffix
      }
    });
    const plan = await prisma.creatorPlan.create({
      data: {
        projectId: project.id,
        title: "Revocation retry plan",
        price: "100",
        currency: "XTR",
        durationDays: 30
      }
    });
    const customer = await prisma.projectCustomer.create({
      data: { projectId: project.id, telegramUserId: telegramBase + 1n }
    });
    const chats = await Promise.all([2n, 3n, 4n].map((offset) =>
      prisma.connectedChat.create({
        data: {
          projectId: project.id,
          telegramChatId: telegramBase + offset,
          type: "CHANNEL",
          title: "Retry chat " + offset.toString()
        }
      })
    ));

    const now = new Date();
    const subscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: customer.id,
        planId: plan.id,
        status: "EXPIRED",
        startsAt: new Date(now.getTime() - 31 * 24 * 60 * 60_000),
        endsAt: new Date(now.getTime() - 60_000)
      }
    });

    const pendingGrant = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: subscription.id,
        connectedChatId: chats[0]!.id,
        inviteLink: "pending-expiry-invite",
        expiresAt: new Date(now.getTime() + 60_000),
        revocationNextAttemptAt: new Date(now.getTime() - 1_000)
      }
    });
    const anotherDueGrant = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: subscription.id,
        connectedChatId: chats[1]!.id,
        inviteLink: "",
        expiresAt: new Date(0),
        revocationNextAttemptAt: new Date(now.getTime() - 1_000)
      }
    });
    const adminExcludedGrant = await prisma.subscriptionAccessGrant.create({
      data: {
        subscriptionId: subscription.id,
        connectedChatId: chats[2]!.id,
        inviteLink: "admin-excluded-stale-invite",
        expiresAt: new Date(now.getTime() + 60_000),
        revokedAt: now,
        revocationReason: "ADMIN_EXCLUDED",
        revocationNextAttemptAt: new Date(now.getTime() - 1_000)
      }
    });

    await recordSubscriptionAccessRevocationFailure(
      subscription.id,
      pendingGrant.id,
      "ACCESS_REVOCATION_FAILED",
      now
    );
    await recordSubscriptionAccessRevocationFailure(
      subscription.id,
      adminExcludedGrant.id,
      "INVITE_REVOKE_FAILED",
      now
    );

    const [scheduledExpiryGrant, scheduledAdminGrant] = await Promise.all([
      prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: pendingGrant.id } }),
      prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: adminExcludedGrant.id } })
    ]);
    assert.equal(scheduledExpiryGrant.revocationAttempts, 1);
    assert.equal(scheduledExpiryGrant.revocationLastError, "ACCESS_REVOCATION_FAILED");
    assert.equal(scheduledExpiryGrant.revocationNextAttemptAt.getTime(), now.getTime() + 2 * 60_000);
    assert.equal(scheduledAdminGrant.revocationAttempts, 1);
    assert.equal(scheduledAdminGrant.revocationLastError, "INVITE_REVOKE_FAILED");
    assert.equal(scheduledAdminGrant.revocationNextAttemptAt.getTime(), now.getTime() + 2 * 60_000);

    // Failed grants move out of the current due queue, leaving other grants
    // eligible for immediate work rather than letting one broken chat starve them.
    const dueNow = await prisma.subscriptionAccessGrant.findMany({
      where: {
        subscriptionId: subscription.id,
        OR: [
          { revokedAt: null, revocationNextAttemptAt: { lte: now } },
          {
            revocationReason: "ADMIN_EXCLUDED",
            revokedAt: { not: null },
            inviteLink: { not: "" },
            revocationNextAttemptAt: { lte: now }
          }
        ]
      },
      select: { id: true }
    });
    assert.deepEqual(dueNow.map((grant) => grant.id), [anotherDueGrant.id]);

    // A paid renewal that wins before failure persistence must not receive a
    // stale expiry-revocation retry. An ADMIN_EXCLUDED old invite remains retryable.
    const renewedAt = new Date(now.getTime() + 3 * 60_000);
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "ACTIVE",
        endsAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000)
      }
    });
    await recordSubscriptionAccessRevocationFailure(
      subscription.id,
      pendingGrant.id,
      "ACCESS_REVOCATION_FAILED",
      renewedAt
    );
    await recordSubscriptionAccessRevocationFailure(
      subscription.id,
      adminExcludedGrant.id,
      "INVITE_REVOKE_FAILED",
      renewedAt
    );

    const [renewedGrant, retriedAdminGrant] = await Promise.all([
      prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: pendingGrant.id } }),
      prisma.subscriptionAccessGrant.findUniqueOrThrow({ where: { id: adminExcludedGrant.id } })
    ]);
    assert.equal(renewedGrant.revocationAttempts, 1);
    assert.equal(renewedGrant.revocationNextAttemptAt.getTime(), now.getTime() + 2 * 60_000);
    assert.equal(retriedAdminGrant.revocationAttempts, 2);
    assert.equal(retriedAdminGrant.revocationNextAttemptAt.getTime(), renewedAt.getTime() + 4 * 60_000);
  } finally {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
  }
});
