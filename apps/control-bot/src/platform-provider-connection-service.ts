import { prisma } from "@subpilot/database";
import { encryptSecret } from "@subpilot/security";
import type {
  PlatformExternalProviderId,
  PlatformProviderEnvironment
} from "./platform-provider-connection.js";

export class PlatformProviderConnectionError extends Error {
  constructor(
    public readonly code: "CONNECTION_NOT_FOUND" | "DUPLICATE_CONNECTION"
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
