import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("platform PSP credentials are encrypted, audited and cannot be manually activated", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const previousEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");

  const { prisma } = await import("@subpilot/database");
  const { decryptSecret } = await import("@subpilot/security");
  const {
    createPlatformProviderConnection,
    disablePlatformProviderConnection,
    rotatePlatformProviderCredentials
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
    assert.deepEqual(JSON.parse(decryptSecret(afterRotation.credentialsEncrypted)), rotatedCredentials);

    const disabled = await disablePlatformProviderConnection(created.id, actor.id);
    assert.equal(disabled.status, "DISABLED");
    const auditEvents = await prisma.auditLog.findMany({
      where: {
        actorUserId: actor.id,
        resourceType: "PlatformPaymentProviderConnection",
        resourceId: created.id
      },
      orderBy: { createdAt: "asc" }
    });
    assert.deepEqual(
      auditEvents.map((event) => event.action),
      [
        "PLATFORM_PROVIDER_CONNECTION_CREATED",
        "PLATFORM_PROVIDER_CREDENTIALS_ROTATED",
        "PLATFORM_PROVIDER_CONNECTION_DISABLED"
      ]
    );
    const auditText = JSON.stringify(auditEvents.map((event) => event.metadata));
    assert.equal(auditText.includes(firstCredentials.secretKey), false);
    assert.equal(auditText.includes(rotatedCredentials.secretKey), false);
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
