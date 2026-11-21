import { prisma } from "@subpilot/database";
import { decryptSecret, encryptSecret } from "@subpilot/security";
import type { PaymentProviderCredentialVerifierRegistry } from "@subpilot/payments";
import type {
  PlatformExternalProviderId,
  PlatformProviderEnvironment
} from "./platform-provider-connection.js";

export class PlatformProviderConnectionError extends Error {
  constructor(
    public readonly code:
      | "CONNECTION_NOT_FOUND"
      | "DUPLICATE_CONNECTION"
      | "CONNECTION_DISABLED"
      | "ADAPTER_NOT_CONFIGURED"
      | "CONNECTION_CHANGED_DURING_VERIFICATION"
  ) {
    super(code);
    this.name = "PlatformProviderConnectionError";
  }
}

export interface PlatformProviderConnectionSummary {
  id: string;
  provider: string;
  label: string;
  environment: string;
  status: string;
  lastVerifiedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export async function listPlatformProviderConnections(): Promise<PlatformProviderConnectionSummary[]> {
  return prisma.platformPaymentProviderConnection.findMany({
    select: {
      id: true,
      provider: true,
      label: true,
      environment: true,
      status: true,
      lastVerifiedAt: true,
      lastError: true,
      createdAt: true
    },
    orderBy: [{ provider: "asc" }, { label: "asc" }]
  });
}

/**
 * Stores a SubPilot-owned PSP connection. Credentials are encrypted before
 * reaching Prisma; only non-secret connection metadata is written to AuditLog.
 * New connections always start PENDING and cannot process customer checkouts
 * until a provider-specific verifier explicitly activates them.
 */
export async function createPlatformProviderConnection(input: {
  provider: PlatformExternalProviderId;
  label: string;
  environment: PlatformProviderEnvironment;
  credentials: Record<string, string>;
  actorUserId: string;
}): Promise<PlatformProviderConnectionSummary> {
  const credentialsEncrypted = encryptSecret(JSON.stringify(input.credentials));

  try {
    return await prisma.$transaction(async (tx) => {
      const connection = await tx.platformPaymentProviderConnection.create({
        data: {
          provider: input.provider,
          label: input.label,
          environment: input.environment,
          credentialsEncrypted,
          status: "PENDING"
        },
        select: {
          id: true,
          provider: true,
          label: true,
          environment: true,
          status: true,
          lastVerifiedAt: true,
          lastError: true,
          createdAt: true
        }
      });

      await tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          action: "PLATFORM_PROVIDER_CONNECTION_CREATED",
          resourceType: "PlatformPaymentProviderConnection",
          resourceId: connection.id,
          metadata: {
            provider: connection.provider,
            label: connection.label,
            environment: connection.environment,
            status: connection.status
          }
        }
      });

      return connection;
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      throw new PlatformProviderConnectionError("DUPLICATE_CONNECTION");
    }
    throw error;
  }
}

/**
 * Credential rotation disables the connection pending a provider-specific
 * verification. The old credentials are replaced atomically; no secret enters
 * the audit trail and no checkout can use the connection while it is pending.
 */
export async function rotatePlatformProviderCredentials(input: {
  connectionId: string;
  credentials: Record<string, string>;
  actorUserId: string;
}): Promise<PlatformProviderConnectionSummary> {
  const credentialsEncrypted = encryptSecret(JSON.stringify(input.credentials));

  return prisma.$transaction(async (tx) => {
    const existing = await tx.platformPaymentProviderConnection.findUnique({
      where: { id: input.connectionId },
      select: { id: true, provider: true, label: true, environment: true }
    });
    if (!existing) throw new PlatformProviderConnectionError("CONNECTION_NOT_FOUND");

    const connection = await tx.platformPaymentProviderConnection.update({
      where: { id: input.connectionId },
      data: {
        credentialsEncrypted,
        credentialVersion: { increment: 1 },
        status: "PENDING",
        lastVerifiedAt: null,
        lastError: null
      },
      select: {
        id: true,
        provider: true,
        label: true,
        environment: true,
        status: true,
        lastVerifiedAt: true,
        lastError: true,
        createdAt: true
      }
    });

    await tx.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: "PLATFORM_PROVIDER_CREDENTIALS_ROTATED",
        resourceType: "PlatformPaymentProviderConnection",
        resourceId: connection.id,
        metadata: {
          provider: connection.provider,
          label: connection.label,
          environment: connection.environment,
          status: connection.status
        }
      }
    });

    return connection;
  });
}

export async function disablePlatformProviderConnection(
  connectionId: string,
  actorUserId: string
): Promise<PlatformProviderConnectionSummary> {
  return prisma.$transaction(async (tx) => {
    const connection = await tx.platformPaymentProviderConnection.findUnique({
      where: { id: connectionId },
      select: {
        id: true,
        provider: true,
        label: true,
        environment: true,
        status: true,
        lastVerifiedAt: true,
        lastError: true,
        createdAt: true
      }
    });
    if (!connection) throw new PlatformProviderConnectionError("CONNECTION_NOT_FOUND");
    if (connection.status === "DISABLED") return connection;

    const updated = await tx.platformPaymentProviderConnection.update({
      where: { id: connectionId },
      data: { status: "DISABLED" },
      select: {
        id: true,
        provider: true,
        label: true,
        environment: true,
        status: true,
        lastVerifiedAt: true,
        lastError: true,
        createdAt: true
      }
    });

    await tx.auditLog.create({
      data: {
        actorUserId,
        action: "PLATFORM_PROVIDER_CONNECTION_DISABLED",
        resourceType: "PlatformPaymentProviderConnection",
        resourceId: connection.id,
        metadata: {
          provider: connection.provider,
          label: connection.label,
          environment: connection.environment,
          previousStatus: connection.status
        }
      }
    });

    return updated;
  });
}


/**
 * Verifies a pending connection against the provider API. The network request
 * happens outside the database transaction; the final compare-and-set checks
 * updatedAt so a concurrent credential rotation cannot be overwritten by a
 * stale verification result.
 */
export async function verifyPlatformProviderConnection(input: {
  connectionId: string;
  actorUserId: string;
  verifiers: PaymentProviderCredentialVerifierRegistry;
}): Promise<{
  connection: PlatformProviderConnectionSummary;
  verification: "VERIFIED" | "REJECTED";
  errorCode?: string;
}> {
  const snapshot = await prisma.platformPaymentProviderConnection.findUnique({
    where: { id: input.connectionId },
    select: {
      id: true,
      provider: true,
      environment: true,
      credentialsEncrypted: true,
      status: true,
      credentialVersion: true,
      updatedAt: true
    }
  });
  if (!snapshot) throw new PlatformProviderConnectionError("CONNECTION_NOT_FOUND");
  if (snapshot.status === "DISABLED") {
    throw new PlatformProviderConnectionError("CONNECTION_DISABLED");
  }

  let verifier;
  try {
    verifier = input.verifiers.get(snapshot.provider);
  } catch {
    throw new PlatformProviderConnectionError("ADAPTER_NOT_CONFIGURED");
  }

  let verified = false;
  let errorCode: string | undefined;
  try {
    const credentials = JSON.parse(decryptSecret(snapshot.credentialsEncrypted)) as unknown;
    if (!credentials || typeof credentials !== "object" || Array.isArray(credentials) ||
        Object.values(credentials).some((value) => typeof value !== "string")) {
      throw new Error("Invalid stored credential format.");
    }
    const result = await verifier.verifyCredentials({
      credentials: credentials as Record<string, string>,
      environment: snapshot.environment
    });
    if (result && result.ok === true) {
      verified = true;
    } else {
      const candidate = result && "errorCode" in result ? result.errorCode : "";
      errorCode = typeof candidate === "string" && /^[A-Z0-9_]{1,64}$/.test(candidate)
        ? candidate
        : "PROVIDER_REJECTED_CREDENTIALS";
    }
  } catch {
    // Never persist provider exceptions: some SDK errors echo secrets or headers.
    errorCode = "VERIFICATION_FAILED";
  }

  const now = new Date();
  const nextStatus = verified ? "ACTIVE" : "ERROR";
  const safeError = verified ? null : errorCode ?? "VERIFICATION_FAILED";

  return prisma.$transaction(async (tx) => {
    const changed = await tx.platformPaymentProviderConnection.updateMany({
      where: {
        id: snapshot.id,
        status: snapshot.status,
        credentialVersion: snapshot.credentialVersion,
        updatedAt: snapshot.updatedAt
      },
      data: {
        status: nextStatus,
        lastVerifiedAt: verified ? now : null,
        lastError: safeError
      }
    });
    if (changed.count !== 1) {
      throw new PlatformProviderConnectionError("CONNECTION_CHANGED_DURING_VERIFICATION");
    }

    const connection = await tx.platformPaymentProviderConnection.findUniqueOrThrow({
      where: { id: snapshot.id },
      select: {
        id: true,
        provider: true,
        label: true,
        environment: true,
        status: true,
        lastVerifiedAt: true,
        lastError: true,
        createdAt: true
      }
    });
    await tx.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: verified
          ? "PLATFORM_PROVIDER_CONNECTION_VERIFIED"
          : "PLATFORM_PROVIDER_CONNECTION_VERIFICATION_FAILED",
        resourceType: "PlatformPaymentProviderConnection",
        resourceId: connection.id,
        metadata: {
          provider: connection.provider,
          label: connection.label,
          environment: connection.environment,
          status: connection.status,
          errorCode: safeError
        }
      }
    });

    return {
      connection,
      verification: verified ? "VERIFIED" as const : "REJECTED" as const,
      ...(safeError ? { errorCode: safeError } : {})
    };
  });
}
