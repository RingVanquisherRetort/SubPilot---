import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PaymentProviderCredentialVerifierRegistry } from "@subpilot/payments";

test("platform PSP credentials are encrypted, versioned, verified, audited and never exposed", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const previousEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");

  const { prisma } = await import("@subpilot/database");
  const { decryptSecret } = await import("@subpilot/security");
  const {
    createPlatformProviderConnection,
    disablePlatformProviderConnection,
    rotatePlatformProviderCredentials,
    verifyPlatformProviderConnection
  } = await import("./platform-provider-connection-service.js");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const telegramId = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 100_000));

  let actorId: string | undefined;
  let connectionId: string | undefined;

  try {
    const actor = await prisma.user.create({
      data: { telegramId, firstName: "Platform PSP test operator" }
    });
    actorId = actor.id;

    const firstCredentials = { shopId: `shop-${suffix}`, secretKey: `private-secret-${suffix}` };
    const created = await createPlatformProviderConnection({
      provider: "YOOKASSA",
      label: `ci-${suffix}`,
      environment: "TEST",
      credentials: firstCredentials,
      actorUserId: actor.id
    });
    connectionId = created.id;

    assert.equal(created.status, "PENDING");
    const stored = await prisma.platformPaymentProviderConnection.findUniqueOrThrow({
      where: { id: created.id }
    });
    assert.equal(stored.credentialsEncrypted.includes(firstCredentials.secretKey), false);
    assert.deepEqual(JSON.parse(decryptSecret(stored.credentialsEncrypted)), firstCredentials);
    assert.equal(stored.credentialVersion, 1);

    const firstVerifier = new PaymentProviderCredentialVerifierRegistry();
    firstVerifier.register({
      provider: "YOOKASSA",
      async verifyCredentials({ credentials, environment }) {
        return credentials.secretKey === firstCredentials.secretKey && environment === "TEST"
          ? { ok: true }
          : { ok: false, errorCode: "INVALID_CREDENTIALS" };
      }
    });
    const verified = await verifyPlatformProviderConnection({
      connectionId: created.id,
      actorUserId: actor.id,
      verifiers: firstVerifier
    });
    assert.equal(verified.verification, "VERIFIED");
    assert.equal(verified.connection.status, "ACTIVE");
    assert.ok(verified.connection.lastVerifiedAt);

    const rotatedCredentials = { shopId: `shop-${suffix}`, secretKey: `rotated-secret-${suffix}` };
    const rotated = await rotatePlatformProviderCredentials({
      connectionId: created.id,
      credentials: rotatedCredentials,
      actorUserId: actor.id
    });
    assert.equal(rotated.status, "PENDING");
    assert.equal(rotated.lastVerifiedAt, null);
    const afterRotation = await prisma.platformPaymentProviderConnection.findUniqueOrThrow({
      where: { id: created.id }
    });
    assert.equal(afterRotation.credentialVersion, 2);
    assert.deepEqual(JSON.parse(decryptSecret(afterRotation.credentialsEncrypted)), rotatedCredentials);

    const failingVerifier = new PaymentProviderCredentialVerifierRegistry();
    failingVerifier.register({
      provider: "YOOKASSA",
      async verifyCredentials() {
        return { ok: false, errorCode: "INVALID_CREDENTIALS" };
      }
    });
    const rejected = await verifyPlatformProviderConnection({
      connectionId: created.id,
      actorUserId: actor.id,
      verifiers: failingVerifier
    });
    assert.equal(rejected.verification, "REJECTED");
    assert.equal(rejected.connection.status, "ERROR");
    assert.equal(rejected.connection.lastError, "INVALID_CREDENTIALS");

    const rotatedAgainCredentials = { shopId: `shop-${suffix}`, secretKey: `third-secret-${suffix}` };
    await rotatePlatformProviderCredentials({
      connectionId: created.id,
      credentials: rotatedAgainCredentials,
      actorUserId: actor.id
    });

    let markVerifierStarted!: () => void;
    const verifierStarted = new Promise<void>((resolve) => { markVerifierStarted = resolve; });
    let finishVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => { finishVerification = resolve; });
    const slowVerifier = new PaymentProviderCredentialVerifierRegistry();
    slowVerifier.register({
      provider: "YOOKASSA",
      async verifyCredentials() {
        markVerifierStarted();
        await verificationGate;
        return { ok: true };
      }
    });

    const staleCheck = verifyPlatformProviderConnection({
      connectionId: created.id,
      actorUserId: actor.id,
      verifiers: slowVerifier
    });
    await verifierStarted;
    const latestCredentials = { shopId: `shop-${suffix}`, secretKey: `latest-secret-${suffix}` };
    await rotatePlatformProviderCredentials({
      connectionId: created.id,
      credentials: latestCredentials,
      actorUserId: actor.id
    });
    finishVerification();

    await assert.rejects(
      staleCheck,
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "CONNECTION_CHANGED_DURING_VERIFICATION"
    );
    const afterStaleCheck = await prisma.platformPaymentProviderConnection.findUniqueOrThrow({
      where: { id: created.id }
    });
    assert.equal(afterStaleCheck.status, "PENDING");
    assert.equal(afterStaleCheck.credentialVersion, 4);
    assert.deepEqual(JSON.parse(decryptSecret(afterStaleCheck.credentialsEncrypted)), latestCredentials);

    const disabled = await disablePlatformProviderConnection(created.id, actor.id);
    assert.equal(disabled.status, "DISABLED");
    const auditEvents = await prisma.auditLog.findMany({
      where: {
        actorUserId: actor.id,
        resourceType: "PlatformPaymentProviderConnection",
        resourceId: created.id
      }
    });
    const actions = auditEvents.map((event) => event.action).sort();
    assert.deepEqual(actions, [
      "PLATFORM_PROVIDER_CONNECTION_CREATED",
      "PLATFORM_PROVIDER_CONNECTION_CREDENTIALS_ROTATED",
      "PLATFORM_PROVIDER_CONNECTION_CREDENTIALS_ROTATED",
      "PLATFORM_PROVIDER_CONNECTION_CREDENTIALS_ROTATED",
      "PLATFORM_PROVIDER_CONNECTION_DISABLED",
      "PLATFORM_PROVIDER_CONNECTION_VERIFICATION_FAILED",
      "PLATFORM_PROVIDER_CONNECTION_VERIFIED"
    ].sort());

    const auditText = JSON.stringify(auditEvents.map((event) => event.metadata));
    for (const secret of [
      firstCredentials.secretKey,
      rotatedCredentials.secretKey,
      rotatedAgainCredentials.secretKey,
      latestCredentials.secretKey
    ]) {
      assert.equal(auditText.includes(secret), false);
    }
  } finally {
    if (connectionId) {
      await prisma.platformPaymentProviderConnection.deleteMany({ where: { id: connectionId } });
      await prisma.auditLog.deleteMany({
        where: { resourceType: "PlatformPaymentProviderConnection", resourceId: connectionId }
      });
    }
    if (actorId) await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
    if (previousEncryptionKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = previousEncryptionKey;
  }
});
