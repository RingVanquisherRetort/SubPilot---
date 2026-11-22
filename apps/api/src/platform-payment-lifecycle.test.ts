import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("YooKassa checkout and webhook lifecycle is idempotent and activates billing only after API-confirmed success", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const previousKey = process.env.SECRETS_ENCRYPTION_KEY;
  const previousReturnUrl = process.env.PLATFORM_BILLING_RETURN_URL;
  process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString("base64");
  process.env.PLATFORM_BILLING_RETURN_URL = "https://tgsubpilot.ru/billing/return";
  const { prisma } = await import("@subpilot/database");
  const { encryptSecret } = await import("@subpilot/security");
  const { createPlatformPaymentCheckout, processYooKassaWebhook, PlatformPaymentLifecycleError } =
    await import("./platform-payment-lifecycle.js");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const telegramId = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));
  let actorId: string | undefined;
  let workspaceId: string | undefined;
  let planId: string | undefined;
  const invalidPlanIds: string[] = [];
  let connectionId: string | undefined;
  const previousPeriodStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const previousPeriodEnd = new Date(Date.now() + 60 * 60 * 1000);

  try {
    const actor = await prisma.user.create({ data: { telegramId, firstName: "Billing integration test" } });
    actorId = actor.id;
    const workspace = await prisma.workspace.create({
      data: {
        name: "YooKassa test " + suffix,
        slug: "yoo-test-" + suffix,
        createdById: actor.id,
        members: { create: { userId: actor.id, role: "OWNER" } }
      }
    });
    workspaceId = workspace.id;
    const plan = await prisma.platformPlan.create({
      data: {
        code: "yoo-test-" + suffix,
        title: "YooKassa integration " + suffix,
        price: "99.00",
        currency: "RUB",
        billingPeriodDays: 30,
        features: {
          schemaVersion: 1,
          limits: { projects: 3, members: 5, plansPerProject: 10, connectedChatsPerProject: 3 }
        }
      }
    });
    planId = plan.id;
    await prisma.workspaceBilling.create({
      data: {
        workspaceId: workspace.id,
        platformPlanId: plan.id,
        status: "TRIALING",
        currentPeriodStart: previousPeriodStart,
        currentPeriodEnd: previousPeriodEnd
      }
    });
    const connection = await prisma.platformPaymentProviderConnection.create({
      data: {
        provider: "YOOKASSA",
        label: "test-" + suffix,
        environment: "TEST",
        credentialsEncrypted: encryptSecret(JSON.stringify({ shopId: "123456", secretKey: "test_secret_" + suffix })),
        status: "ACTIVE"
      }
    });
    connectionId = connection.id;
    const providerPaymentId = "yoo_payment_" + suffix;
    let paymentId = "";
    let createCalls = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/payments") && init?.method === "POST") {
        createCalls += 1;
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body.amount, { value: "99.00", currency: "RUB" });
        assert.equal(typeof body.metadata.subpilot_payment_id, "string");
        return new Response(JSON.stringify({
          id: providerPaymentId,
          status: "pending",
          confirmation: { type: "redirect", confirmation_url: "https://yookassa.ru/checkout/" + suffix }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/refunds") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        assert.equal(body.payment_id, providerPaymentId);
        assert.deepEqual(body.amount, { value: "99.00", currency: "RUB" });
        return new Response(JSON.stringify({
          id: "refund_" + suffix,
          status: "succeeded",
          payment_id: providerPaymentId,
          amount: { value: "99.00", currency: "RUB" }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/refunds/refund_" + suffix) || url.endsWith("/refunds/refund_partial_" + suffix)) {
        return new Response(JSON.stringify({
          id: url.split("/").pop(),
          payment_id: providerPaymentId,
          status: "succeeded",
          amount: { value: url.includes("refund_partial_") ? "49.50" : "99.00", currency: "RUB" }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/payments/" + providerPaymentId)) {
        return new Response(JSON.stringify({
          id: providerPaymentId,
          status: "succeeded",
          amount: { value: "99.00", currency: "RUB" },
          metadata: { subpilot_payment_id: paymentId }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
    };

    const checkoutInput = {
      workspaceId: workspace.id,
      planCode: plan.code,
      providerConnectionId: connection.id,
      actorTelegramId: telegramId.toString(),
      idempotencyKey: "test-idempotency-" + suffix,
      salesSurface: "INDEPENDENT_WEB" as const,
      telegramTpaRelated: false
    };

    for (const [label, price] of [["zero", "0.00"], ["negative", "-1.00"]] as const) {
      const invalidPlan = await prisma.platformPlan.create({
        data: {
          code: `yoo-${label}-${suffix}`,
          title: `Invalid ${label} price`,
          price,
          currency: "RUB",
          billingPeriodDays: 30,
          features: {
            schemaVersion: 1,
            limits: { projects: 3, members: 5, plansPerProject: 10, connectedChatsPerProject: 3 }
          }
        }
      });
      invalidPlanIds.push(invalidPlan.id);
      await assert.rejects(
        createPlatformPaymentCheckout({
          ...checkoutInput,
          planCode: invalidPlan.code,
          idempotencyKey: `invalid-${label}-${suffix}`
        }, { fetch: fakeFetch }),
        (error: unknown) => error instanceof PlatformPaymentLifecycleError &&
          error.code === "PLAN_NOT_AVAILABLE"
      );
    }
    assert.equal(createCalls, 0, "invalid catalogue prices must be rejected before contacting YooKassa");

    const checkout = await createPlatformPaymentCheckout(checkoutInput, { fetch: fakeFetch });
    paymentId = checkout.paymentId;
    assert.equal(checkout.status, "PENDING");
    assert.equal(typeof checkout.checkoutUrl, "string");
    assert.match(checkout.checkoutUrl ?? "", /^https:\/\/yookassa\.ru\//);
    assert.equal(createCalls, 1);

    const retry = await createPlatformPaymentCheckout(checkoutInput, { fetch: fakeFetch });
    assert.equal(retry.paymentId, checkout.paymentId);
    assert.equal(retry.checkoutUrl, checkout.checkoutUrl);
    assert.equal(createCalls, 1);

    const retryWithNewBrowserKey = await createPlatformPaymentCheckout({
      ...checkoutInput,
      idempotencyKey: "new-browser-key-" + suffix
    }, { fetch: fakeFetch });
    assert.equal(retryWithNewBrowserKey.paymentId, checkout.paymentId);
    assert.equal(retryWithNewBrowserKey.checkoutUrl, checkout.checkoutUrl);
    assert.equal(createCalls, 1);

    const notification = {
      type: "notification",
      event: "payment.succeeded",
      object: {
        id: providerPaymentId,
        status: "succeeded",
        amount: { value: "99.00", currency: "RUB" },
        metadata: { subpilot_payment_id: paymentId },
        captured_at: "2026-11-21T12:00:00.000Z"
      }
    };
    const first = await processYooKassaWebhook({
      connectionId: connection.id,
      headers: {},
      rawBody: JSON.stringify(notification),
      body: notification
    }, { fetch: fakeFetch });
    assert.deepEqual(first, { authenticated: true, processed: 1, duplicates: 0, manualReview: 0 });

    const paid = await prisma.platformPayment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.equal(paid.status, "SUCCEEDED");
    assert.equal(paid.providerPaymentId, providerPaymentId);
    assert.ok(paid.paidAt);
    const billing = await prisma.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: workspace.id } });
    assert.equal(billing.status, "ACTIVE");
    assert.equal(billing.platformPlanId, plan.id);
    assert.equal(billing.currentPeriodStart?.getTime(), previousPeriodEnd.getTime());
    assert.ok(billing.currentPeriodEnd);
    assert.equal(billing.currentPeriodEnd.getTime() - previousPeriodEnd.getTime(),
      30 * 24 * 60 * 60 * 1000);

    const second = await processYooKassaWebhook({
      connectionId: connection.id,
      headers: {},
      rawBody: JSON.stringify(notification),
      body: notification
    }, { fetch: fakeFetch });
    assert.deepEqual(second, { authenticated: true, processed: 0, duplicates: 1, manualReview: 0 });
    const billingAgain = await prisma.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: workspace.id } });
    assert.equal(billingAgain.currentPeriodEnd?.getTime(), billing.currentPeriodEnd?.getTime());

    const partialRefundNotification = {
      type: "notification",
      event: "refund.succeeded",
      object: {
        id: "refund_partial_" + suffix,
        payment_id: providerPaymentId,
        status: "succeeded",
        amount: { value: "49.50", currency: "RUB" }
      }
    };
    const partialRefundResult = await processYooKassaWebhook({
      connectionId: connection.id,
      headers: {},
      rawBody: JSON.stringify(partialRefundNotification),
      body: partialRefundNotification
    }, { fetch: fakeFetch });
    assert.deepEqual(partialRefundResult, {
      authenticated: true,
      processed: 0,
      duplicates: 0,
      manualReview: 1
    });
    const partialRefundEvent = await prisma.platformPaymentWebhookEvent.findFirstOrThrow({
      where: { providerConnectionId: connection.id, providerEventId: "refund.succeeded:refund_partial_" + suffix }
    });
    assert.equal(partialRefundEvent.processedAt, null);
    assert.equal(partialRefundEvent.lastError, "REJECT_AMOUNT_MISMATCH");

    await prisma.platformPayment.update({
      where: { id: paymentId }, data: { status: "REFUNDING" }
    });
    await assert.rejects(
      createPlatformPaymentCheckout({
        ...checkoutInput,
        idempotencyKey: "blocked-during-refund-" + suffix
      }, { fetch: fakeFetch }),
      (error: unknown) => error instanceof PlatformPaymentLifecycleError &&
        error.code === "CHECKOUT_ALREADY_IN_PROGRESS"
    );
    assert.equal(createCalls, 1);

    const refundNotification = {
      type: "notification",
      event: "refund.succeeded",
      object: {
        id: "refund_" + suffix,
        payment_id: providerPaymentId,
        status: "succeeded",
        amount: { value: "99.00", currency: "RUB" }
      }
    };
    const refundResult = await processYooKassaWebhook({
      connectionId: connection.id,
      headers: {},
      rawBody: JSON.stringify(refundNotification),
      body: refundNotification
    }, { fetch: fakeFetch });
    assert.deepEqual(refundResult, {
      authenticated: true,
      processed: 1,
      duplicates: 0,
      manualReview: 0
    });
    const paymentAfterRefundNotice = await prisma.platformPayment.findUniqueOrThrow({ where: { id: paymentId } });
    const billingAfterRefundNotice = await prisma.workspaceBilling.findUniqueOrThrow({ where: { workspaceId: workspace.id } });
    assert.equal(paymentAfterRefundNotice.status, "REFUNDED");
    assert.ok(paymentAfterRefundNotice.refundedAt);
    assert.equal(billingAfterRefundNotice.status, "TRIALING");
    assert.equal(billingAfterRefundNotice.currentPeriodStart?.getTime(), previousPeriodStart.getTime());
    assert.equal(billingAfterRefundNotice.currentPeriodEnd?.getTime(), previousPeriodEnd.getTime());
    const refundEvent = await prisma.platformPaymentWebhookEvent.findFirstOrThrow({
      where: { providerConnectionId: connection.id, providerEventId: "refund.succeeded:refund_" + suffix }
    });
    assert.ok(refundEvent.processedAt);
    assert.equal(refundEvent.lastError, null);


  } finally {
    if (connectionId) {
      await prisma.platformPaymentWebhookEvent.deleteMany({ where: { providerConnectionId: connectionId } });
      await prisma.platformPayment.deleteMany({ where: { providerConnectionId: connectionId } });
      await prisma.platformPaymentProviderConnection.deleteMany({ where: { id: connectionId } });
    }
    if (workspaceId) {
      await prisma.workspaceBilling.deleteMany({ where: { workspaceId } });
      await prisma.auditLog.deleteMany({ where: { workspaceId } });
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    if (invalidPlanIds.length) await prisma.platformPlan.deleteMany({ where: { id: { in: invalidPlanIds } } });
    if (planId) await prisma.platformPlan.deleteMany({ where: { id: planId } });
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
    if (previousKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = previousKey;
    if (previousReturnUrl === undefined) delete process.env.PLATFORM_BILLING_RETURN_URL;
    else process.env.PLATFORM_BILLING_RETURN_URL = previousReturnUrl;
  }
});

test("policy gate blocks a YooKassa checkout for a Telegram-related digital service", async () => {
  const { createPlatformPaymentCheckout } = await import("./platform-payment-lifecycle.js");
  await assert.rejects(() => createPlatformPaymentCheckout({
    workspaceId: "not-reached",
    planCode: "not-reached",
    providerConnectionId: "not-reached",
    actorTelegramId: "123456",
    idempotencyKey: "policy-test",
    salesSurface: "INDEPENDENT_WEB",
    telegramTpaRelated: true
  }), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "CHECKOUT_NOT_ELIGIBLE"
  );
});
