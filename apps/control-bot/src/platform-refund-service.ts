import { prisma } from "@subpilot/database";
import { YooKassaPaymentAdapter } from "@subpilot/payments";
import { decryptSecret } from "@subpilot/security";

type FetchImplementation = typeof fetch;
type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataObject(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function readCredentials(encrypted: string): { shopId: string; secretKey: string } {
  const parsed: unknown = JSON.parse(decryptSecret(encrypted));
  if (!isRecord(parsed) || typeof parsed.shopId !== "string" ||
      typeof parsed.secretKey !== "string") {
    throw new PlatformRefundError("INVALID_PROVIDER_CREDENTIALS");
  }
  return { shopId: parsed.shopId, secretKey: parsed.secretKey };
}

export class PlatformRefundError extends Error {
  constructor(public readonly code:
    | "INVALID_ACTOR"
    | "PAYMENT_NOT_FOUND"
    | "PAYMENT_NOT_REFUNDABLE"
    | "REFUND_IN_PROGRESS"
    | "PROVIDER_CONNECTION_NOT_FOUND"
    | "INVALID_PROVIDER_CREDENTIALS"
    | "PROVIDER_REQUEST_FAILED"
    | "REFUND_REQUIRES_MANUAL_REVIEW"
  ) {
    super(code);
    this.name = "PlatformRefundError";
  }
}

export async function requestPlatformPaymentRefund(
  input: { paymentId: string; actorTelegramId: number; actorUserId: string },
  dependencies: { fetch?: FetchImplementation } = {}
): Promise<{ paymentId: string; providerRefundId: string; providerStatus: string; attempt: number }> {
  const telegramId = String(input.actorTelegramId);
  const allowlist = (process.env.PLATFORM_ADMIN_TELEGRAM_IDS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (!Number.isSafeInteger(input.actorTelegramId) || !allowlist.includes(telegramId)) {
    throw new PlatformRefundError("INVALID_ACTOR");
  }

  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "PlatformPayment" WHERE "id" = $1 FOR UPDATE',
      input.paymentId
    );
    const actor = await tx.user.findUnique({
      where: { telegramId: BigInt(input.actorTelegramId) },
      select: { id: true }
    });
    if (!actor || actor.id !== input.actorUserId) {
      throw new PlatformRefundError("INVALID_ACTOR");
    }
    const payment = await tx.platformPayment.findUnique({ where: { id: input.paymentId } });
    if (!payment) throw new PlatformRefundError("PAYMENT_NOT_FOUND");
    if (payment.status === "REFUNDED" || payment.status === "FAILED" ||
        payment.status === "CANCELLED" || payment.status === "CREATED" ||
        payment.status === "PENDING") {
      throw new PlatformRefundError("PAYMENT_NOT_REFUNDABLE");
    }
    if (payment.status === "REFUNDING") {
      throw new PlatformRefundError(payment.refundLastError
        ? "REFUND_REQUIRES_MANUAL_REVIEW"
        : "REFUND_IN_PROGRESS");
    }
    if (payment.status !== "SUCCEEDED") {
      throw new PlatformRefundError("PAYMENT_NOT_REFUNDABLE");
    }
    const priorRefundRequest = metadataObject(payment.metadata).refundRequest;
    if (isRecord(priorRefundRequest) && priorRefundRequest.providerStatus === "canceled") {
      throw new PlatformRefundError("REFUND_REQUIRES_MANUAL_REVIEW");
    }
    if (payment.provider !== "YOOKASSA" || !payment.providerConnectionId ||
        !payment.providerPaymentId) {
      throw new PlatformRefundError("PROVIDER_CONNECTION_NOT_FOUND");
    }
    const connection = await tx.platformPaymentProviderConnection.findUnique({
      where: { id: payment.providerConnectionId }
    });
    if (!connection || connection.provider !== "YOOKASSA") {
      throw new PlatformRefundError("PROVIDER_CONNECTION_NOT_FOUND");
    }
    const updated = await tx.platformPayment.update({
      where: { id: payment.id },
      data: {
        status: "REFUNDING",
        refundAttemptedAt: new Date(),
        refundAttempts: { increment: 1 },
        refundLastError: null
      }
    });
    await tx.auditLog.create({
      data: {
        workspaceId: payment.workspaceId,
        actorUserId: actor.id,
        action: "PLATFORM_REFUND_REQUESTED",
        resourceType: "PlatformPayment",
        resourceId: payment.id,
        metadata: {
          provider: "YOOKASSA",
          amount: payment.amount.toString(),
          currency: payment.currency,
          attempt: updated.refundAttempts
        }
      }
    });
    return { payment: updated, connection };
  });

  let result: { providerRefundId: string; status: string };
  try {
    const adapter = new YooKassaPaymentAdapter(
      readCredentials(claimed.connection.credentialsEncrypted),
      dependencies.fetch ? { fetch: dependencies.fetch } : {}
    );
    result = await adapter.createRefund({
      providerPaymentId: claimed.payment.providerPaymentId ?? "",
      amount: claimed.payment.amount.toString(),
      currency: claimed.payment.currency,
      // Reuse the same key on retries so an uncertain network result cannot create a second refund.
      idempotencyKey: "subpilot-platform-refund-" + claimed.payment.id,
      description: "SubPilot workspace subscription refund"
    });
  } catch (error) {
    await prisma.platformPayment.updateMany({
      where: { id: claimed.payment.id, status: "REFUNDING" },
      data: { refundLastError: "PROVIDER_REQUEST_FAILED" }
    }).catch(() => undefined);
    await prisma.auditLog.create({
      data: {
        workspaceId: claimed.payment.workspaceId,
        actorUserId: input.actorUserId,
        action: "PLATFORM_REFUND_REQUEST_FAILED",
        resourceType: "PlatformPayment",
        resourceId: claimed.payment.id,
        metadata: {
          provider: "YOOKASSA",
          attempt: claimed.payment.refundAttempts,
          errorName: error instanceof Error ? error.name : "UnknownError"
        }
      }
    }).catch(() => undefined);
    throw new PlatformRefundError("PROVIDER_REQUEST_FAILED");
  }

  await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "PlatformPayment" WHERE "id" = $1 FOR UPDATE',
      claimed.payment.id
    );
    const current = await tx.platformPayment.findUniqueOrThrow({
      where: { id: claimed.payment.id }
    });
    const metadata = {
      ...metadataObject(current.metadata),
      refundRequest: {
        providerRefundId: result.providerRefundId,
        providerStatus: result.status,
        requestedAt: new Date().toISOString()
      }
    };
    await tx.platformPayment.update({
      where: { id: current.id },
      data: {
        ...(current.status === "REFUNDING" && result.status === "canceled"
          ? { status: "SUCCEEDED" }
          : {}),
        refundLastError: result.status === "canceled" ? "PROVIDER_REFUND_CANCELED" : null,
        metadata: JSON.parse(JSON.stringify(metadata))
      }
    });
    await tx.auditLog.create({
      data: {
        workspaceId: current.workspaceId,
        actorUserId: input.actorUserId,
        action: result.status === "canceled"
          ? "PLATFORM_REFUND_REJECTED_BY_PROVIDER"
          : "PLATFORM_REFUND_ACCEPTED_BY_PROVIDER",
        resourceType: "PlatformPayment",
        resourceId: current.id,
        metadata: {
          provider: "YOOKASSA",
          providerRefundId: result.providerRefundId,
          providerStatus: result.status,
          attempt: claimed.payment.refundAttempts
        }
      }
    });
  });

  return {
    paymentId: claimed.payment.id,
    providerRefundId: result.providerRefundId,
    providerStatus: result.status,
    attempt: claimed.payment.refundAttempts
  };
}
