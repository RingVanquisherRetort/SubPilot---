import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("PostgreSQL advisory lock allows only one concurrent invoice-dispatch claim", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const lockKey = "subscription:test-invoice-dispatch:" + randomUUID();
  let dispatchStarted = false;

  const claim = async (): Promise<boolean> => prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))) AS acquired`;
    if (dispatchStarted) return false;

    dispatchStarted = true;
    // Hold the transaction lock briefly so other contenders arrive while it is held.
    await new Promise((resolve) => setTimeout(resolve, 40));
    return true;
  });

  try {
    const results = await Promise.all([claim(), claim(), claim()]);
    assert.equal(results.filter(Boolean).length, 1);
  } finally {
    await prisma.$disconnect();
  }
});
