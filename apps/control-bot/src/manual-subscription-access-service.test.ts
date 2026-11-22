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

    // An explicit manual grant is an authorization action and may deliberately
    // re-enable a previously revoked destination. Ordinary invite delivery may not.
    await prisma.subscriptionAccessGrant.update({
      where: {
        subscriptionId_connectedChatId: {
          subscriptionId: firstManual.subscriptionId,
          connectedChatId: chat.id
        }
      },
      data: {
        inviteLink: "revoked-invite-link",
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
        revocationReason: "ADMIN_EXCLUDED"
      }
    });
    const reauthorizedManual = await grantManualSubscriptionAccess(manualInput);
    assert.equal(reauthorizedManual.subscriptionId, firstManual.subscriptionId);
    const reauthorizedGrant = await prisma.subscriptionAccessGrant.findUniqueOrThrow({
      where: {
        subscriptionId_connectedChatId: {
          subscriptionId: firstManual.subscriptionId,
          connectedChatId: chat.id
        }
      }
    });
    assert.equal(reauthorizedGrant.revokedAt, null);
    assert.equal(reauthorizedGrant.revocationReason, null);
    assert.equal(reauthorizedGrant.inviteLink, "");
    assert.equal(reauthorizedGrant.expiresAt.getTime(), 0);

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

    // A recurring Stars entitlement may only be administratively revoked after
    // Telegram confirms that future renewals have been disabled.
    const projectBot = await prisma.projectBot.create({
      data: {
        projectId: project.id,
        telegramBotId: telegramBase + 100n,
        tokenEncrypted: "test-encrypted-bot-token",
        status: "ACTIVE",
        isPrimary: true
      }
    });
    const recurringCustomer = await prisma.projectCustomer.create({
      data: {
        projectId: project.id,
        telegramUserId: telegramBase + 20n,
        firstName: "Recurring buyer"
      }
    });
    const initialChargeId = "initial-charge-" + suffix;
    const recurringSubscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: recurringCustomer.id,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        telegramStarInitialChargeId: initialChargeId,
        telegramStarSubscriptionState: "ACTIVE"
      }
    });
    const recurringAnchorPayment = await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: recurringCustomer.id,
        subscriptionId: recurringSubscription.id,
        provider: "TELEGRAM_STARS",
        providerPaymentId: initialChargeId,
        idempotencyKey: "initial:" + suffix,
        amount: "100",
        currency: "XTR",
        status: "SUCCEEDED",
        paidAt: new Date(Date.now() - 60_000),
        metadata: {
          source: "project_bot",
          isRecurring: true,
          projectBotId: projectBot.id
        }
      }
    });

    await assert.rejects(
      revokeSubscriptionAccessManually({
        subscriptionId: recurringSubscription.id,
        workspaceId: workspace.id,
        actorUserId: owner.id
      }, {
        cancelTelegramRenewal: async () => false
      }),
      (error: unknown) => error instanceof ManualSubscriptionAccessError &&
        error.code === "TELEGRAM_RENEWAL_CANCEL_FAILED"
    );
    const stillActive = await prisma.subscription.findUniqueOrThrow({
      where: { id: recurringSubscription.id }
    });
    assert.equal(stillActive.status, "ACTIVE");
    assert.equal(stillActive.telegramStarSubscriptionState, "ACTIVE");

    // The original charge can later be refunded while a recurring chain still
    // exists and subsequent renewal periods remain paid. Its bot metadata is
    // still the authority for disabling future Telegram renewals.
    await prisma.payment.update({
      where: { id: recurringAnchorPayment.id },
      data: { status: "REFUNDED", refundedAt: new Date() }
    });

    let cancellationRequest: {
      telegramUserId: bigint;
      telegramPaymentChargeId: string;
      encryptedBotToken: string;
    } | undefined;
    const recurringRevocation = await revokeSubscriptionAccessManually({
      subscriptionId: recurringSubscription.id,
      workspaceId: workspace.id,
      actorUserId: owner.id
    }, {
      cancelTelegramRenewal: async (request) => {
        cancellationRequest = request;
        return true;
      }
    });
    assert.equal(recurringRevocation.recurringRenewalCancelled, true);
    assert.equal(cancellationRequest?.telegramUserId, recurringCustomer.telegramUserId);
    assert.equal(cancellationRequest?.telegramPaymentChargeId, initialChargeId);
    assert.equal(cancellationRequest?.encryptedBotToken, "test-encrypted-bot-token");

    const recurringCancelled = await prisma.subscription.findUniqueOrThrow({
      where: { id: recurringSubscription.id }
    });
    assert.equal(recurringCancelled.status, "CANCELLED");
    assert.equal(recurringCancelled.telegramStarSubscriptionState, "CANCELED");
    assert.ok(recurringCancelled.endsAt && recurringCancelled.endsAt.getTime() <= Date.now());

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
