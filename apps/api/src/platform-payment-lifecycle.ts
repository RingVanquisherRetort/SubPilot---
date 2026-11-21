import { createHash } from "node:crypto";
import { prisma } from "@subpilot/database";
import { decryptSecret } from "@subpilot/security";
import {
  evaluatePaymentEligibility,
  reconcileExternalPaymentEvent,
  YooKassaPaymentAdapter,
  type NormalizedPaymentEvent,
  type PaymentSurface
} from "@subpilot/payments";

type FetchImplementation = typeof fetch;
type Transaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type JsonObject = Record<string, unknown>;

export class PlatformPaymentLifecycleError extends Error {
  constructor(public readonly code:
    | "CHECKOUT_NOT_ELIGIBLE" | "INVALID_ACTOR" | "WORKSPACE_ACCESS_DENIED"
    | "PLAN_NOT_AVAILABLE" | "PROVIDER_NOT_AVAILABLE" | "RETURN_URL_NOT_CONFIGURED"
    | "IDEMPOTENCY_CONFLICT" | "PAYMENT_ALREADY_FINAL"
    | "PLAN_CHANGE_REQUIRES_MANUAL_REVIEW" | "CHECKOUT_ALREADY_IN_PROGRESS" | "PROVIDER_CONNECTION_NOT_FOUND"
    | "INVALID_PROVIDER_CREDENTIALS" | "PAYMENT_NOT_FOUND"
    | "REFUND_NOT_ALLOWED" | "REFUND_IN_PROGRESS" | "REFUND_PROVIDER_UNAVAILABLE"
  ) {
    super(code);
    this.name = "PlatformPaymentLifecycleError";
  }
}
function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === "P2002";
}
function hashKey(value: string): string {
  if (!value.trim() || value.length > 200) throw new Error("A valid idempotency key is required.");
  return createHash("sha256").update(value).digest("hex");
}
function readCredentials(encrypted: string): { shopId: string; secretKey: string } {
  let value: unknown;
  try { value = JSON.parse(decryptSecret(encrypted)); }
  catch { throw new PlatformPaymentLifecycleError("INVALID_PROVIDER_CREDENTIALS"); }
  if (!isRecord(value) || typeof value.shopId !== "string" || typeof value.secretKey !== "string") {
    throw new PlatformPaymentLifecycleError("INVALID_PROVIDER_CREDENTIALS");
  }
  return { shopId: value.shopId, secretKey: value.secretKey };
}
function addUtcDays(start: Date, days: number): Date {
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + days);
  return end;
}
function jsonValue(value: unknown): any { return JSON.parse(JSON.stringify(value)); }
function objectMetadata(value: unknown): JsonObject { return isRecord(value) ? value : {}; }
async function lockWorkspace(tx: Transaction, workspaceId: string): Promise<void> {
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "Workspace" WHERE "id" = $1 FOR UPDATE',
    workspaceId
  );
}
async function setManualReview(tx: Transaction, eventId: string, reason: string): Promise<void> {
  await tx.platformPaymentWebhookEvent.update({
    where: { id: eventId },
    data: { lastError: reason }
  });
}
interface FulfilledBillingPeriod {
  startsAt: Date;
  endsAt: Date;
  planCode: string;
  billingPeriodDays: number;
}

function readFulfilledBillingPeriod(metadata: unknown): FulfilledBillingPeriod | null {
  const item = objectMetadata(objectMetadata(metadata).fulfilledBillingPeriod);
  if (typeof item.startsAt !== "string" || typeof item.endsAt !== "string" ||
      typeof item.planCode !== "string" || typeof item.billingPeriodDays !== "number") return null;
  const startsAt = new Date(item.startsAt);
  const endsAt = new Date(item.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) ||
      endsAt.getTime() <= startsAt.getTime() ||
      !Number.isSafeInteger(item.billingPeriodDays) || item.billingPeriodDays < 1) return null;
  return { startsAt, endsAt, planCode: item.planCode, billingPeriodDays: item.billingPeriodDays };
}

type WorkspaceBillingStatusForRefund = "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELLED" | "EXPIRED";

type PreviousBillingSnapshot =
  | { kind: "NONE" }
  | {
      kind: "PERIOD";
      platformPlanId: string;
      status: WorkspaceBillingStatusForRefund;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date;
    }
  | { kind: "INVALID" };

function readPreviousBillingSnapshot(metadata: unknown): PreviousBillingSnapshot {
  const purchaseContext = objectMetadata(objectMetadata(metadata).purchaseContext);
  if (!Object.prototype.hasOwnProperty.call(purchaseContext, "previousBillingPeriod")) {
    return { kind: "INVALID" };
  }
  const value = purchaseContext.previousBillingPeriod;
  if (value === null) return { kind: "NONE" };
  const item = objectMetadata(value);
  const allowedStatuses = ["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED"];
  if (typeof item.platformPlanId !== "string" ||
      typeof item.status !== "string" || !allowedStatuses.includes(item.status) ||
      typeof item.currentPeriodEnd !== "string") return { kind: "INVALID" };
  const currentPeriodEnd = new Date(item.currentPeriodEnd);
  const currentPeriodStart = item.currentPeriodStart === null
    ? null
    : typeof item.currentPeriodStart === "string" ? new Date(item.currentPeriodStart) : null;
  if (Number.isNaN(currentPeriodEnd.getTime()) ||
      (item.currentPeriodStart !== null &&
       (currentPeriodStart === null || Number.isNaN(currentPeriodStart.getTime())))) {
    return { kind: "INVALID" };
  }
  return {
    kind: "PERIOD",
    platformPlanId: item.platformPlanId,
    status: item.status as WorkspaceBillingStatusForRefund,
    currentPeriodStart,
    currentPeriodEnd
  };
}

async function processVerifiedRefund(input: {
  tx: Transaction;
  eventRecordId: string;
  payment: {
    id: string;
    workspaceId: string;
    platformPlanId: string;
    planCodeSnapshot: string;
    billingPeriodDaysSnapshot: number;
    metadata: unknown;
    initiatedByTelegramId: bigint | null;
    amount: { toString(): string };
    currency: string;
  };
  event: NormalizedPaymentEvent;
  providerPaymentId: string;
}): Promise<"PROCESSED" | "MANUAL_REVIEW"> {
  const { tx, eventRecordId, payment, event, providerPaymentId } = input;
  if (payment.metadata === null || payment.metadata === undefined) {
    await setManualReview(tx, eventRecordId, "REFUND_PERIOD_SNAPSHOT_MISSING");
    return "MANUAL_REVIEW";
  }
  const period = readFulfilledBillingPeriod(payment.metadata);
  if (!period || period.planCode !== payment.planCodeSnapshot ||
      period.billingPeriodDays !== payment.billingPeriodDaysSnapshot) {
    await setManualReview(tx, eventRecordId, "REFUND_PERIOD_SNAPSHOT_INVALID");
    return "MANUAL_REVIEW";
  }

  await lockWorkspace(tx, payment.workspaceId);
  const billing = await tx.workspaceBilling.findUnique({
    where: { workspaceId: payment.workspaceId }
  });
  const now = new Date();
  let billingAction: string;

  const currentPeriodMatches = Boolean(
    billing &&
    billing.platformPlanId === payment.platformPlanId &&
    billing.currentPeriodStart?.getTime() === period.startsAt.getTime() &&
    billing.currentPeriodEnd?.getTime() === period.endsAt.getTime()
  );

  if (currentPeriodMatches && billing) {
    const previous = readPreviousBillingSnapshot(payment.metadata);
    if (previous.kind === "INVALID") {
      await setManualReview(tx, eventRecordId, "REFUND_PREVIOUS_PERIOD_SNAPSHOT_INVALID");
      return "MANUAL_REVIEW";
    }
    if (previous.kind === "PERIOD") {
      if (previous.platformPlanId !== payment.platformPlanId ||
          previous.currentPeriodEnd.getTime() !== period.startsAt.getTime() ||
          previous.currentPeriodEnd.getTime() <= now.getTime()) {
        await setManualReview(tx, eventRecordId, "REFUND_PREVIOUS_PERIOD_NOT_CONTIGUOUS");
        return "MANUAL_REVIEW";
      }
      await tx.workspaceBilling.update({
        where: { id: billing.id },
        data: {
          platformPlanId: previous.platformPlanId,
          status: previous.status,
          currentPeriodStart: previous.currentPeriodStart,
          currentPeriodEnd: previous.currentPeriodEnd
        }
      });
      billingAction = "RESTORED_PREVIOUS_PAID_OR_TRIAL_PERIOD";
    } else {
      await tx.workspaceBilling.update({
        where: { id: billing.id },
        data: {
          status: "EXPIRED",
          currentPeriodStart: null,
          currentPeriodEnd: null
        }
      });
      billingAction = "EXPIRED_REFUNDED_PERIOD";
    }
  } else if (period.endsAt.getTime() <= now.getTime()) {
    // A refund for an already-ended period must not alter a later entitlement.
    billingAction = "NO_ACCESS_CHANGE_PERIOD_ALREADY_ENDED";
  } else if (billing?.currentPeriodStart &&
             billing.currentPeriodStart.getTime() >= period.endsAt.getTime()) {
    // A later, non-overlapping period is already active; do not revoke it.
    billingAction = "NO_ACCESS_CHANGE_LATER_PERIOD_ACTIVE";
  } else {
    await setManualReview(tx, eventRecordId, "REFUND_PERIOD_DOES_NOT_MATCH_CURRENT_BILLING");
    return "MANUAL_REVIEW";
  }

  const refundedAt = event.occurredAt ?? new Date();
  const metadata = {
    ...objectMetadata(payment.metadata),
    refund: {
      providerRefundId: event.providerEventId.startsWith("refund.succeeded:")
        ? event.providerEventId.slice("refund.succeeded:".length)
        : null,
      providerEventId: event.providerEventId,
      refundedAt: refundedAt.toISOString(),
      billingAction
    }
  };
  await tx.platformPayment.update({
    where: { id: payment.id },
    data: {
      status: "REFUNDED",
      providerPaymentId,
      refundedAt,
      refundLastError: null,
      metadata: jsonValue(metadata)
    }
  });
  const actor = payment.initiatedByTelegramId === null ? null :
    await tx.user.findUnique({
      where: { telegramId: payment.initiatedByTelegramId }, select: { id: true }
    });
  await tx.auditLog.create({
    data: {
      workspaceId: payment.workspaceId,
      ...(actor ? { actorUserId: actor.id } : {}),
      action: "PLATFORM_PAYMENT_REFUNDED",
      resourceType: "PlatformPayment",
      resourceId: payment.id,
      metadata: {
        provider: "YOOKASSA",
        amount: payment.amount.toString(),
        currency: payment.currency,
        providerEventId: event.providerEventId,
        billingAction
      }
    }
  });
  await tx.platformPaymentWebhookEvent.update({
    where: { id: eventRecordId },
    data: { processedAt: new Date(), lastError: null }
  });
  return "PROCESSED";
}

async function processVerifiedEvent(input: {
  connectionId: string;
  event: NormalizedPaymentEvent;
  payload: unknown;
}): Promise<"PROCESSED" | "DUPLICATE" | "MANUAL_REVIEW"> {
  return prisma.$transaction(async (tx) => {
    const dedupeKey = createHash("sha256")
      .update(input.connectionId + ":" + input.event.providerEventId).digest("hex");
    const record = await tx.platformPaymentWebhookEvent.upsert({
      where: {
        providerConnectionId_providerEventId: {
          providerConnectionId: input.connectionId,
          providerEventId: input.event.providerEventId
        }
      },
      create: {
        providerConnectionId: input.connectionId,
        providerEventId: input.event.providerEventId,
        dedupeKey,
        eventType: input.event.eventType,
        payload: jsonValue(input.payload),
        attempts: 1
      },
      update: { attempts: { increment: 1 }, lastError: null },
      select: { id: true }
    });
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "PlatformPaymentWebhookEvent" WHERE "id" = $1 FOR UPDATE',
      record.id
    );
    const locked = await tx.platformPaymentWebhookEvent.findUniqueOrThrow({
      where: { id: record.id }, select: { processedAt: true }
    });
    if (locked.processedAt) return "DUPLICATE";

    if (!input.event.paymentReference) {
      await setManualReview(tx, record.id, "PAYMENT_REFERENCE_MISSING");
      return "MANUAL_REVIEW";
    }

    const payment = await tx.platformPayment.findFirst({
      where: {
        id: input.event.paymentReference,
        providerConnectionId: input.connectionId,
        provider: "YOOKASSA"
      }
    });
    if (!payment) {
      await setManualReview(tx, record.id, "LOCAL_PAYMENT_NOT_FOUND");
      return "MANUAL_REVIEW";
    }

    if (input.event.status === "REFUNDED" &&
        payment.status !== "SUCCEEDED" && payment.status !== "REFUNDING") {
      await setManualReview(tx, record.id, "REFUND_FOR_NON_SETTLED_PAYMENT");
      return "MANUAL_REVIEW";
    }

    const decision = reconcileExternalPaymentEvent({
      payment: {
        reference: payment.id,
        amount: payment.amount.toString(),
        currency: payment.currency,
        status: payment.status,
        providerPaymentId: payment.providerPaymentId
      },
      event: input.event
    });
    if (decision.kind === "DUPLICATE") {
      await tx.platformPaymentWebhookEvent.update({
        where: { id: record.id }, data: { processedAt: new Date(), lastError: null }
      });
      return "DUPLICATE";
    }
    if (decision.kind === "REJECT") {
      await setManualReview(tx, record.id, "REJECT_" + decision.reason);
      return "MANUAL_REVIEW";
    }
    if (decision.kind === "MANUAL_REVIEW") {
      await setManualReview(tx, record.id, "REVIEW_" + decision.reason);
      return "MANUAL_REVIEW";
    }

    if (decision.nextStatus === "REFUNDED") {
      return processVerifiedRefund({
        tx,
        eventRecordId: record.id,
        payment,
        event: input.event,
        providerPaymentId: decision.providerPaymentId
      });
    }

    let billingId: string | null = payment.workspaceBillingId;
    let periodStart: Date | null = null;
    let periodEnd: Date | null = null;

    if (decision.nextStatus === "SUCCEEDED") {
      await lockWorkspace(tx, payment.workspaceId);
      const billing = await tx.workspaceBilling.findUnique({
        where: { workspaceId: payment.workspaceId }
      });
      const now = new Date();
      const unexpired = Boolean(billing?.currentPeriodEnd &&
        billing.currentPeriodEnd.getTime() > now.getTime());
      if (unexpired && billing && billing.platformPlanId !== payment.platformPlanId) {
        await setManualReview(tx, record.id, "PLAN_CHANGE_REQUIRES_MANUAL_REVIEW");
        return "MANUAL_REVIEW";
      }
      periodStart = unexpired && billing?.platformPlanId === payment.platformPlanId
        ? billing.currentPeriodEnd as Date
        : now;
      periodEnd = addUtcDays(periodStart, payment.billingPeriodDaysSnapshot);

      const updatedBilling = billing
        ? await tx.workspaceBilling.update({
            where: { id: billing.id },
            data: {
              platformPlanId: payment.platformPlanId,
              status: "ACTIVE",
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd
            },
            select: { id: true }
          })
        : await tx.workspaceBilling.create({
            data: {
              workspaceId: payment.workspaceId,
              platformPlanId: payment.platformPlanId,
              status: "ACTIVE",
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd
            },
            select: { id: true }
          });
      billingId = updatedBilling.id;
    }

    const metadata = {
      ...objectMetadata(payment.metadata),
      ...(periodStart && periodEnd ? {
        fulfilledBillingPeriod: {
          startsAt: periodStart.toISOString(),
          endsAt: periodEnd.toISOString(),
          planCode: payment.planCodeSnapshot,
          billingPeriodDays: payment.billingPeriodDaysSnapshot
        }
      } : {})
    };
    await tx.platformPayment.update({
      where: { id: payment.id },
      data: {
        status: decision.nextStatus,
        providerPaymentId: decision.providerPaymentId,
        ...(decision.nextStatus === "SUCCEEDED" ? { paidAt: input.event.occurredAt ?? new Date() } : {}),
        ...(billingId ? { workspaceBillingId: billingId } : {}),
        metadata: jsonValue(metadata)
      }
    });

    if (decision.nextStatus === "SUCCEEDED") {
      const actor = payment.initiatedByTelegramId === null ? null :
        await tx.user.findUnique({
          where: { telegramId: payment.initiatedByTelegramId }, select: { id: true }
        });
      await tx.auditLog.create({
        data: {
          workspaceId: payment.workspaceId,
          ...(actor ? { actorUserId: actor.id } : {}),
          action: "PLATFORM_PAYMENT_SUCCEEDED",
          resourceType: "PlatformPayment",
          resourceId: payment.id,
          metadata: {
            provider: "YOOKASSA",
            planCode: payment.planCodeSnapshot,
            amount: payment.amount.toString(),
            currency: payment.currency,
            billingPeriodStart: periodStart ? periodStart.toISOString() : null,
            billingPeriodEnd: periodEnd ? periodEnd.toISOString() : null
          }
        }
      });
    }
    await tx.platformPaymentWebhookEvent.update({
      where: { id: record.id }, data: { processedAt: new Date(), lastError: null }
    });
    return "PROCESSED";
  }, { isolationLevel: "ReadCommitted" });
}

export interface CreatePlatformPaymentCheckoutInput {
  workspaceId: string;
  planCode: string;
  providerConnectionId: string;
  actorTelegramId: string;
  idempotencyKey: string;
  salesSurface: PaymentSurface;
  telegramTpaRelated: boolean;
}
export interface PlatformPaymentCheckoutResult {
  paymentId: string;
  checkoutUrl: string | null;
  status: "PENDING" | "SUCCEEDED";
  expiresAt: Date | null;
}

/** Call only behind an authenticated independent-web checkout. The surface
 * classification must come from trusted server configuration, not user input. */
export async function createPlatformPaymentCheckout(
  input: CreatePlatformPaymentCheckoutInput,
  dependencies: { fetch?: FetchImplementation } = {}
): Promise<PlatformPaymentCheckoutResult> {
  const eligibility = evaluatePaymentEligibility({
    provider: "YOOKASSA",
    productType: "DIGITAL_GOODS_OR_SERVICES",
    surface: input.salesSurface,
    telegramTpaRelated: input.telegramTpaRelated
  });
  if (!eligibility.allowed) throw new PlatformPaymentLifecycleError("CHECKOUT_NOT_ELIGIBLE");
  if (!/^\d{1,20}$/.test(input.actorTelegramId)) {
    throw new PlatformPaymentLifecycleError("INVALID_ACTOR");
  }
  const actorTelegramId = BigInt(input.actorTelegramId);
  const idempotencyKey = hashKey(input.idempotencyKey);
  const returnUrl = process.env.PLATFORM_BILLING_RETURN_URL;
  if (!returnUrl) throw new PlatformPaymentLifecycleError("RETURN_URL_NOT_CONFIGURED");

  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: input.workspaceId,
      role: { in: ["OWNER", "ADMIN"] },
      user: { telegramId: actorTelegramId }
    },
    select: { userId: true }
  });
  if (!membership) throw new PlatformPaymentLifecycleError("WORKSPACE_ACCESS_DENIED");

  const [plan, connection] = await Promise.all([
    prisma.platformPlan.findUnique({ where: { code: input.planCode } }),
    prisma.platformPaymentProviderConnection.findUnique({ where: { id: input.providerConnectionId } })
  ]);
  if (!plan || !plan.isActive || !/[1-9]/.test(plan.price.toString())) {
    throw new PlatformPaymentLifecycleError("PLAN_NOT_AVAILABLE");
  }
  if (!connection || connection.provider !== "YOOKASSA" || connection.status !== "ACTIVE") {
    throw new PlatformPaymentLifecycleError("PROVIDER_NOT_AVAILABLE");
  }

  const amount = plan.price.toString();
  const currency = plan.currency.toUpperCase();
  let payment: Awaited<ReturnType<typeof prisma.platformPayment.create>>;
  try {
    payment = await prisma.$transaction(async (tx) => {
      await lockWorkspace(tx, input.workspaceId);
      const existing = await tx.platformPayment.findUnique({ where: { idempotencyKey } });
      if (existing) {
        const matches = existing.workspaceId === input.workspaceId &&
          existing.platformPlanId === plan.id &&
          existing.providerConnectionId === connection.id &&
          existing.amount.toString() === amount &&
          existing.currency === currency;
        if (!matches) throw new PlatformPaymentLifecycleError("IDEMPOTENCY_CONFLICT");
        return existing;
      }

      const now = new Date();
      const pendingCheckout = await tx.platformPayment.findFirst({
        where: {
          workspaceId: input.workspaceId,
          status: { in: ["CREATED", "PENDING"] }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      });
      if (pendingCheckout) {
        if (pendingCheckout.status === "REFUNDING") {
          throw new PlatformPaymentLifecycleError("CHECKOUT_ALREADY_IN_PROGRESS");
        }
        // Do not open a second charge while an earlier provider payment is
        // non-terminal, even if its displayed expiry has passed. A delayed
        // success webhook could still arrive; reconcile/cancel the old payment first.
        const matches = pendingCheckout.platformPlanId === plan.id &&
          pendingCheckout.providerConnectionId === connection.id &&
          pendingCheckout.amount.toString() === amount &&
          pendingCheckout.currency === currency;
        if (!matches || (pendingCheckout.expiresAt && pendingCheckout.expiresAt.getTime() <= now.getTime())) {
          throw new PlatformPaymentLifecycleError("CHECKOUT_ALREADY_IN_PROGRESS");
        }
        return pendingCheckout;
      }

      const billing = await tx.workspaceBilling.findUnique({ where: { workspaceId: input.workspaceId } });
      if (billing?.currentPeriodEnd &&
          billing.currentPeriodEnd.getTime() > Date.now() &&
          billing.platformPlanId !== plan.id) {
        throw new PlatformPaymentLifecycleError("PLAN_CHANGE_REQUIRES_MANUAL_REVIEW");
      }
      const created = await tx.platformPayment.create({
        data: {
          workspaceId: input.workspaceId,
          ...(billing ? { workspaceBillingId: billing.id } : {}),
          platformPlanId: plan.id,
          providerConnectionId: connection.id,
          provider: "YOOKASSA",
          idempotencyKey,
          planCodeSnapshot: plan.code,
          planTitleSnapshot: plan.title,
          billingPeriodDaysSnapshot: plan.billingPeriodDays,
          initiatedByTelegramId: actorTelegramId,
          amount,
          currency,
          status: "CREATED",
          metadata: jsonValue({
            purchaseContext: {
              previousBillingPeriod: billing?.currentPeriodEnd &&
                billing.currentPeriodEnd.getTime() > Date.now()
                ? {
                    platformPlanId: billing.platformPlanId,
                    status: billing.status,
                    currentPeriodStart: billing.currentPeriodStart?.toISOString() ?? null,
                    currentPeriodEnd: billing.currentPeriodEnd.toISOString()
                  }
                : null
            }
          })
        }
      });
      await tx.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: membership.userId,
          action: "PLATFORM_PAYMENT_CREATED",
          resourceType: "PlatformPayment",
          resourceId: created.id,
          metadata: {
            provider: "YOOKASSA",
            planCode: created.planCodeSnapshot,
            amount,
            currency,
            billingPeriodDays: created.billingPeriodDaysSnapshot
          }
        }
      });
      return created;
    }, { isolationLevel: "ReadCommitted" });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await prisma.platformPayment.findUnique({ where: { idempotencyKey } });
    if (!existing || existing.workspaceId !== input.workspaceId ||
        existing.platformPlanId !== plan.id ||
        existing.providerConnectionId !== connection.id ||
        existing.amount.toString() !== amount || existing.currency !== currency) {
      throw new PlatformPaymentLifecycleError("IDEMPOTENCY_CONFLICT");
    }
    payment = existing;
  }

  if (payment.status === "SUCCEEDED") {
    return {
      paymentId: payment.id,
      checkoutUrl: null,
      status: "SUCCEEDED",
      expiresAt: payment.expiresAt
    };
  }
  if (["REFUNDED", "FAILED", "CANCELLED"].includes(payment.status)) {
    throw new PlatformPaymentLifecycleError("PAYMENT_ALREADY_FINAL");
  }
  if (payment.status === "PENDING" && payment.checkoutUrl) {
    return {
      paymentId: payment.id,
      checkoutUrl: payment.checkoutUrl,
      status: "PENDING",
      expiresAt: payment.expiresAt
    };
  }

  const adapter = new YooKassaPaymentAdapter(
    readCredentials(connection.credentialsEncrypted),
    dependencies.fetch ? { fetch: dependencies.fetch } : {}
  );
  const redirectReturnUrl = new URL(returnUrl);
  redirectReturnUrl.searchParams.set("payment_id", payment.id);
  const checkout = await adapter.createCheckout({
    paymentId: payment.id,
    amount: payment.amount.toString(),
    currency: payment.currency,
    title: payment.planTitleSnapshot,
    description: payment.planTitleSnapshot.slice(0, 128),
    customerReference: payment.workspaceId,
    returnUrl: redirectReturnUrl.toString()
  });
  if (!checkout.checkoutUrl || !checkout.providerPaymentId) {
    throw new Error("YooKassa did not return a redirect checkout.");
  }
  // A fast webhook can confirm the payment before the create-checkout
  // request finishes persisting its redirect URL. Never regress SUCCEEDED
  // back to PENDING when that race occurs.
  await prisma.platformPayment.updateMany({
    where: { id: payment.id, status: { in: ["CREATED", "PENDING"] } },
    data: {
      status: "PENDING",
      providerPaymentId: checkout.providerPaymentId,
      externalCheckoutId: checkout.providerPaymentId,
      checkoutUrl: checkout.checkoutUrl,
      expiresAt: checkout.expiresAt ?? null
    }
  });
  const updated = await prisma.platformPayment.findUniqueOrThrow({
    where: { id: payment.id }
  });
  if (updated.status === "SUCCEEDED") {
    return {
      paymentId: updated.id,
      checkoutUrl: null,
      status: "SUCCEEDED",
      expiresAt: updated.expiresAt
    };
  }
  if (updated.status !== "PENDING" || !updated.checkoutUrl) {
    throw new PlatformPaymentLifecycleError("PAYMENT_ALREADY_FINAL");
  }
  return {
    paymentId: updated.id,
    checkoutUrl: updated.checkoutUrl,
    status: "PENDING",
    expiresAt: updated.expiresAt
  };
}


export interface ProcessYooKassaWebhookInput {
  connectionId: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  body: unknown;
}
export interface ProcessYooKassaWebhookResult {
  authenticated: boolean;
  processed: number;
  duplicates: number;
  manualReview: number;
}
export async function processYooKassaWebhook(
  input: ProcessYooKassaWebhookInput,
  dependencies: { fetch?: FetchImplementation } = {}
): Promise<ProcessYooKassaWebhookResult> {
  const connection = await prisma.platformPaymentProviderConnection.findUnique({
    where: { id: input.connectionId }
  });
  if (!connection || connection.provider !== "YOOKASSA") {
    throw new PlatformPaymentLifecycleError("PROVIDER_CONNECTION_NOT_FOUND");
  }
  const adapter = new YooKassaPaymentAdapter(
    readCredentials(connection.credentialsEncrypted),
    dependencies.fetch ? { fetch: dependencies.fetch } : {}
  );
  const verified = await adapter.verifyWebhook({
    headers: input.headers,
    rawBody: input.rawBody,
    body: input.body
  });
  if (!verified) return { authenticated: false, processed: 0, duplicates: 0, manualReview: 0 };

  const events = await adapter.parseWebhook(input.body);
  let processed = 0;
  let duplicates = 0;
  let manualReview = 0;
  for (const event of events) {
    const outcome = await processVerifiedEvent({
      connectionId: connection.id,
      event,
      payload: input.body
    });
    if (outcome === "PROCESSED") processed += 1;
    else if (outcome === "DUPLICATE") duplicates += 1;
    else manualReview += 1;
  }
  return { authenticated: true, processed, duplicates, manualReview };
}
