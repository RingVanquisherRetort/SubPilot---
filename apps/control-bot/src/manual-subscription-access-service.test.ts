import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T extends void ? undefined : T) => void;
} {
  let resolve!: (value: T extends void ? undefined : T) => void;
  const promise = new Promise<T>((done) => { resolve = done as typeof resolve; });
  return { promise, resolve };
}

test("manual grants and trials are audited, scoped, and revoke without fabricating payments", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const {
    grantManualSubscriptionAccess,
    grantTrialSubscriptionAccess,
    listActiveProjectSubscriptions,
    resolveProjectCustomerTelegramId,
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

    const pickedId = String(telegramBase + 10n);
    assert.equal(await resolveProjectCustomerTelegramId(project.id, pickedId), pickedId);
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
    assert.ok(cancelled.adminAccessRevokedAt);
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
        telegramUserId: BigInt(Date.now() % 1_000_000_000) + 100_000_000n,
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

    // A remote cancellation may succeed while its HTTP response is lost.
    // If Telegram's authenticated star_subscription update is persisted before
    // the operator retries, the retry must finish the local revoke without
    // issuing a second remote cancellation.
    const recoveryChargeId = "recovery-charge-" + suffix;
    const recoverySubscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: recurringCustomer.id,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        telegramStarInitialChargeId: recoveryChargeId,
        telegramStarSubscriptionState: "ACTIVE"
      }
    });
    await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: recurringCustomer.id,
        subscriptionId: recoverySubscription.id,
        provider: "TELEGRAM_STARS",
        providerPaymentId: recoveryChargeId,
        idempotencyKey: "recovery:" + suffix,
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
    let ambiguousRemoteCalls = 0;
    await assert.rejects(
      revokeSubscriptionAccessManually({
        subscriptionId: recoverySubscription.id,
        workspaceId: workspace.id,
        actorUserId: owner.id
      }, {
        cancelTelegramRenewal: async () => {
          ambiguousRemoteCalls += 1;
          // Simulate Telegram accepting cancellation but the response being lost.
          throw new Error("response lost after remote success");
        }
      }),
      (error: unknown) => error instanceof ManualSubscriptionAccessError &&
        error.code === "TELEGRAM_RENEWAL_CANCEL_FAILED"
    );
    const awaitingWebhook = await prisma.subscription.findUniqueOrThrow({
      where: { id: recoverySubscription.id }
    });
    assert.equal(awaitingWebhook.status, "ACTIVE");
    assert.equal(awaitingWebhook.telegramStarSubscriptionState, "ACTIVE");

    // Model the durable state projection performed by the authenticated
    // star_subscription webhook before the operator retries the revoke.
    await prisma.subscription.update({
      where: { id: recoverySubscription.id },
      data: { telegramStarSubscriptionState: "CANCELED" }
    });
    const recoveredRevoke = await revokeSubscriptionAccessManually({
      subscriptionId: recoverySubscription.id,
      workspaceId: workspace.id,
      actorUserId: owner.id
    }, {
      cancelTelegramRenewal: async () => {
        throw new Error("remote cancellation must not be repeated after webhook confirmation");
      }
    });
    assert.equal(recoveredRevoke.recurringRenewalCancelled, true);
    assert.equal(ambiguousRemoteCalls, 1);
    const recoveredSubscription = await prisma.subscription.findUniqueOrThrow({
      where: { id: recoverySubscription.id }
    });
    assert.equal(recoveredSubscription.status, "CANCELLED");
    assert.equal(recoveredSubscription.telegramStarSubscriptionState, "CANCELED");

    // A second administrative revoke is recovered by the lifecycle worker
    // after the original process loses the Telegram response and no webhook
    // arrives. The same durable intent is retried after its lease expires.
    const workerChargeId = "worker-recovery-charge-" + suffix;
    const workerRecoverySubscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: recurringCustomer.id,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        telegramStarInitialChargeId: workerChargeId,
        telegramStarSubscriptionState: "ACTIVE"
      }
    });
    await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: recurringCustomer.id,
        subscriptionId: workerRecoverySubscription.id,
        provider: "TELEGRAM_STARS",
        providerPaymentId: workerChargeId,
        amount: "100",
        currency: "XTR",
        status: "SUCCEEDED",
        paidAt: new Date(Date.now() - 60_000),
        metadata: { source: "project_bot", isRecurring: true, projectBotId: projectBot.id }
      }
    });
    await assert.rejects(
      revokeSubscriptionAccessManually({
        subscriptionId: workerRecoverySubscription.id,
        workspaceId: workspace.id,
        actorUserId: owner.id
      }, {
        cancelTelegramRenewal: async () => { throw new Error("response lost after remote success"); }
      }),
      (error: unknown) => error instanceof ManualSubscriptionAccessError &&
        error.code === "TELEGRAM_RENEWAL_CANCEL_FAILED"
    );
    const pendingAdminIntent = await prisma.subscription.findUniqueOrThrow({
      where: { id: workerRecoverySubscription.id }
    });
    assert.equal(pendingAdminIntent.status, "ACTIVE");
    assert.equal(pendingAdminIntent.adminStarsCancelPending, true);
    assert.ok(pendingAdminIntent.adminStarsCancelDueAt);
    await prisma.subscription.update({
      where: { id: workerRecoverySubscription.id },
      data: {
        status: "EXPIRED",
        endsAt: new Date(Date.now() - 1_000),
        adminStarsCancelDueAt: new Date(0),
        adminStarsCancelClaim: null
      }
    });
    const { reconcileAdminStarsCancellation } = await import("@subpilot/payments");
    let workerRetryCalls = 0;
    assert.equal(await reconcileAdminStarsCancellation(
      workerRecoverySubscription.id,
      projectBot.id,
      async args => {
        workerRetryCalls += 1;
        assert.equal(args.telegram_payment_charge_id, workerChargeId);
        assert.equal(args.is_canceled, true);
        return true;
      }
    ), true);
    assert.equal(workerRetryCalls, 1);
    const workerRecovered = await prisma.subscription.findUniqueOrThrow({
      where: { id: workerRecoverySubscription.id }
    });
    assert.equal(workerRecovered.status, "EXPIRED");
    assert.equal(workerRecovered.adminStarsCancelPending, false);
    assert.equal(workerRecovered.telegramStarSubscriptionState, "CANCELED");


    // Crash window: Telegram confirmed the cancellation and the authenticated
    // webhook was committed, but the original worker died before it could
    // finalize the local administrative revoke. A restarted worker must finish
    // from the durable intent without issuing another Telegram API request.
    const crashChargeId = "admin-crash-recovery-" + suffix;
    const crashSubscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: recurringCustomer.id,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        telegramStarInitialChargeId: crashChargeId,
        telegramStarSubscriptionState: "CANCELED",
        adminStarsCancelPending: true,
        adminStarsCancelDueAt: new Date(0),
        adminStarsCancelBotId: projectBot.id,
        adminStarsCancelActorUserId: owner.id,
        adminStarsCancelWorkspaceId: workspace.id,
        adminStarsCancelClaim: null
      }
    });
    await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: recurringCustomer.id,
        subscriptionId: crashSubscription.id,
        provider: "TELEGRAM_STARS",
        providerPaymentId: crashChargeId,
        amount: "100",
        currency: "XTR",
        status: "SUCCEEDED",
        paidAt: new Date(Date.now() - 60_000),
        metadata: { source: "project_bot", isRecurring: true, projectBotId: projectBot.id }
      }
    });
    let crashRecoveryRemoteCalls = 0;
    const neverCallTelegramAgain = async () => {
      crashRecoveryRemoteCalls += 1;
      throw new Error("Telegram cancellation was already confirmed");
    };
    assert.equal(await reconcileAdminStarsCancellation(
      crashSubscription.id, projectBot.id, neverCallTelegramAgain
    ), true);
    assert.equal(crashRecoveryRemoteCalls, 0);
    const crashRecovered = await prisma.subscription.findUniqueOrThrow({
      where: { id: crashSubscription.id }
    });
    assert.equal(crashRecovered.status, "CANCELLED");
    assert.equal(crashRecovered.adminStarsCancelPending, false);
    assert.ok(crashRecovered.adminAccessRevokedAt);
    assert.equal(crashRecovered.telegramStarSubscriptionState, "CANCELED");
    assert.equal(await prisma.auditLog.count({
      where: {
        resourceType: "Subscription",
        resourceId: crashSubscription.id,
        action: "SUBSCRIPTION_ACCESS_REVOKE_CONFIRMED"
      }
    }), 1);
    assert.equal(await reconcileAdminStarsCancellation(
      crashSubscription.id, projectBot.id, neverCallTelegramAgain
    ), false, "completed durable intent must not be claimed twice");
    assert.equal(crashRecoveryRemoteCalls, 0);
    assert.equal(await prisma.auditLog.count({
      where: {
        resourceType: "Subscription",
        resourceId: crashSubscription.id,
        action: "SUBSCRIPTION_ACCESS_REVOKE_CONFIRMED"
      }
    }), 1);

    const exhaustedChargeId = "admin-exhausted-charge-" + suffix;
    const exhaustedSubscription = await prisma.subscription.create({
      data: {
        projectId: project.id,
        customerId: recurringCustomer.id,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        telegramStarInitialChargeId: exhaustedChargeId,
        telegramStarSubscriptionState: "ACTIVE"
      }
    });
    await prisma.payment.create({
      data: {
        projectId: project.id,
        customerId: recurringCustomer.id,
        subscriptionId: exhaustedSubscription.id,
        provider: "TELEGRAM_STARS",
        providerPaymentId: exhaustedChargeId,
        amount: "100",
        currency: "XTR",
        status: "SUCCEEDED",
        paidAt: new Date(Date.now() - 60_000),
        metadata: { source: "project_bot", isRecurring: true, projectBotId: projectBot.id }
      }
    });
    await assert.rejects(
      revokeSubscriptionAccessManually({
        subscriptionId: exhaustedSubscription.id,
        workspaceId: workspace.id,
        actorUserId: owner.id
      }, { cancelTelegramRenewal: async () => false }),
      (error: unknown) => error instanceof ManualSubscriptionAccessError &&
        error.code === "TELEGRAM_RENEWAL_CANCEL_FAILED"
    );
    for (let attempt = 2; attempt <= 10; attempt += 1) {
      await prisma.subscription.update({
        where: { id: exhaustedSubscription.id },
        data: { adminStarsCancelDueAt: new Date(0), adminStarsCancelClaim: null }
      });
      assert.equal(await reconcileAdminStarsCancellation(
        exhaustedSubscription.id,
        projectBot.id,
        async () => false
      ), false);
    }
    const exhaustedIntent = await prisma.subscription.findUniqueOrThrow({
      where: { id: exhaustedSubscription.id }
    });
    assert.equal(exhaustedIntent.status, "ACTIVE");
    assert.equal(exhaustedIntent.adminStarsCancelPending, true);
    assert.equal(exhaustedIntent.adminStarsCancelAttempts, 10);
    assert.equal(exhaustedIntent.adminStarsCancelDueAt, null);
    assert.equal(exhaustedIntent.adminStarsCancelLastError, "TELEGRAM_CANCEL_UNCONFIRMED");
    await prisma.subscription.update({
      where: { id: exhaustedSubscription.id },
      data: { status: "EXPIRED", endsAt: new Date(Date.now() - 1_000) }
    });

    const explicitRetry = await revokeSubscriptionAccessManually({
      subscriptionId: exhaustedSubscription.id,
      workspaceId: workspace.id,
      actorUserId: owner.id
    }, { cancelTelegramRenewal: async () => true });
    assert.equal(explicitRetry.recurringRenewalCancelled, true);
    const explicitlyRecovered = await prisma.subscription.findUniqueOrThrow({
      where: { id: exhaustedSubscription.id }
    });
    assert.equal(explicitlyRecovered.status, "EXPIRED");
    assert.equal(explicitlyRecovered.adminStarsCancelPending, false);
    assert.equal(explicitlyRecovered.adminStarsCancelAttempts, 0);

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
    const cancellationStarted = deferred<void>();
    const releaseCancellation = deferred<void>();
    const recurringRevocationPromise = revokeSubscriptionAccessManually({
      subscriptionId: recurringSubscription.id,
      workspaceId: workspace.id,
      actorUserId: owner.id
    }, {
      cancelTelegramRenewal: async (request) => {
        cancellationRequest = request;
        cancellationStarted.resolve(undefined);
        await releaseCancellation.promise;
        return true;
      }
    });
    await Promise.race([
      cancellationStarted.promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Telegram cancellation was not reached")), 5_000))
    ]);

    // The Telegram call is deliberately blocked. Another transaction must still
    // be able to lock and update the subscription row while that external call runs.
    let concurrentMutationCommitted = false;
    const concurrentMutation = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Subscription" WHERE "id" = $1 FOR UPDATE',
        recurringSubscription.id
      );
      await tx.subscription.update({
        where: { id: recurringSubscription.id },
        // Model an authenticated Telegram cancellation webhook and a buyer
        // renewal-intent update landing while the admin's remote call is held.
        data: { reminder1dAt: new Date(), buyerStarsBotId: projectBot.id, buyerStarsChargeId: initialChargeId,
          buyerStarsCanceled: false, buyerStarsClaim: randomUUID(), buyerStarsDueAt: new Date(Date.now() + 300_000),
          telegramStarSubscriptionState: "CANCELED" }
      });
    }).then(() => { concurrentMutationCommitted = true; });
    const committedBeforeTelegramReturned = await Promise.race([
      concurrentMutation.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000))
    ]);

    // A webhook can commit while Telegram is still processing the admin
    // cancellation. Access must not be revoked merely because the webhook
    // reported CANCELED: the administrative operation has not finished yet.
    await concurrentMutation;
    const duringRemoteCancellation = await prisma.subscription.findUniqueOrThrow({
      where: { id: recurringSubscription.id }
    });
    assert.equal(duringRemoteCancellation.status, "ACTIVE");
    assert.equal(duringRemoteCancellation.adminStarsCancelPending, true);
    assert.equal(duringRemoteCancellation.telegramStarSubscriptionState, "CANCELED");
    assert.equal(duringRemoteCancellation.adminAccessRevokedAt, null);
    releaseCancellation.resolve(undefined);
    const recurringRevocation = await recurringRevocationPromise;
    assert.equal(committedBeforeTelegramReturned, true, "the DB row lock must be released before waiting for Telegram");
    assert.equal(concurrentMutationCommitted, true);
    assert.equal(recurringRevocation.recurringRenewalCancelled, true);
    assert.equal(cancellationRequest?.telegramUserId, recurringCustomer.telegramUserId);
    assert.equal(cancellationRequest?.telegramPaymentChargeId, initialChargeId);
    assert.equal(cancellationRequest?.encryptedBotToken, "test-encrypted-bot-token");

    const recurringCancelled = await prisma.subscription.findUniqueOrThrow({
      where: { id: recurringSubscription.id }
    });
    assert.equal(recurringCancelled.buyerStarsCanceled, true);
    assert.equal(recurringCancelled.buyerStarsClaim, null);
    assert.ok(recurringCancelled.buyerStarsDueAt && recurringCancelled.buyerStarsDueAt <= new Date());
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
