import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { prisma } from "@subpilot/database";
import { isStarsAccessSuppressedByAdminRevocation } from "./telegram-star-payment-kind.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("PostgreSQL receipt recheck observes a committed admin revoke under the subscription row lock", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramBase = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let actorId: string | undefined;
  let workspaceId: string | undefined;
  const firstLocked = deferred();
  const releaseFirst = deferred();
  let first: Promise<void> | undefined;
  try {
    const actor = await prisma.user.create({
      data: { telegramId: telegramBase, firstName: "Stars admin receipt race" }
    });
    actorId = actor.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "Stars admin race " + suffix,
        slug: "stars-admin-race-" + suffix,
        createdById: actor.id,
        members: { create: { userId: actor.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;
    const project = await prisma.project.create({
      data: { workspaceId: workspace.id, name: "Stars admin race", slug: "stars-admin-race-project-" + suffix }
    });
    const plan = await prisma.creatorPlan.create({
      data: { projectId: project.id, title: "Stars race plan", price: "250", currency: "XTR", durationDays: 30 }
    });
    const customer = await prisma.projectCustomer.create({
      data: { projectId: project.id, telegramUserId: telegramBase + 1n }
    });
    const originalEndsAt = new Date("2026-12-01T00:00:00.000Z");
    const subscription = await prisma.subscription.create({
      data: {
        projectId: project.id, customerId: customer.id, planId: plan.id,
        status: "ACTIVE", startsAt: new Date("2026-11-01T00:00:00.000Z"),
        endsAt: originalEndsAt
      }
    });

    first = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
        subscription.id
      );
      firstLocked.resolve();
      await releaseFirst.promise;
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          adminStarsCancelPending: true,
          adminStarsCancelDueAt: new Date("2026-11-23T00:00:00.000Z"),
          adminStarsCancelBotId: "admin-test-bot"
        }
      });
    });

    await firstLocked.promise;
    let receiptReadCompleted = false;
    const receipt = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
        subscription.id
      );
      receiptReadCompleted = true;
      const current = await tx.subscription.findUniqueOrThrow({
        where: { id: subscription.id }
      });
      assert.equal(isStarsAccessSuppressedByAdminRevocation(current), true);
      // Model the guarded entitlement mutation only: this is not an end-to-end
      // invocation of processSuccessfulStarsPayment or a Telegram API call.
      if (!isStarsAccessSuppressedByAdminRevocation(current)) {
        await tx.subscription.update({
          where: { id: subscription.id },
          data: { endsAt: new Date("2027-01-01T00:00:00.000Z") }
        });
      }
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(receiptReadCompleted, false, "receipt must wait for the admin transaction");
    } finally {
      releaseFirst.resolve();
    }
    await Promise.all([first, receipt]);
    const saved = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id }
    });
    assert.equal(saved.status, "ACTIVE");
    assert.equal(saved.adminStarsCancelPending, true);
    assert.equal(saved.endsAt?.toISOString(), originalEndsAt.toISOString());
  } finally {
    releaseFirst.resolve();
    if (first) await first.catch(() => undefined);
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
  }
});
