import assert from "node:assert/strict";
import { test } from "node:test";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T extends void ? undefined : T) => void;
} {
  let resolve!: (value: T extends void ? undefined : T) => void;
  const promise = new Promise<T>((done) => { resolve = done as typeof resolve; });
  return { promise, resolve };
}

test("PostgreSQL serializes different subscription transactions for the same customer/chat scope", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const { lockSubscriptionAccessScope } = await import("@subpilot/payments");
  const firstLocked = deferred();
  const releaseFirst = deferred();
  let secondAcquired = false;

  const first = prisma.$transaction(async (tx) => {
    await lockSubscriptionAccessScope(tx, "customer-scope-test", "chat-scope-test");
    firstLocked.resolve(undefined);
    await releaseFirst.promise;
  });

  try {
    await firstLocked.promise;
    const second = prisma.$transaction(async (tx) => {
      await lockSubscriptionAccessScope(tx, "customer-scope-test", "chat-scope-test");
      secondAcquired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(secondAcquired, false, "second subscription operation must wait for the shared customer/chat lock");

    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);
    assert.equal(secondAcquired, true);
  } finally {
    releaseFirst.resolve(undefined);
    await first.catch(() => undefined);
  }
});

test("different customer/chat scopes do not block one another", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const { prisma } = await import("@subpilot/database");
  const { lockSubscriptionAccessScope } = await import("@subpilot/payments");
  const firstLocked = deferred();
  const releaseFirst = deferred();
  let secondAcquired = false;

  const first = prisma.$transaction(async (tx) => {
    await lockSubscriptionAccessScope(tx, "customer-scope-a", "chat-scope-a");
    firstLocked.resolve(undefined);
    await releaseFirst.promise;
  });

  try {
    await firstLocked.promise;
    await prisma.$transaction(async (tx) => {
      await lockSubscriptionAccessScope(tx, "customer-scope-b", "chat-scope-b");
      secondAcquired = true;
    });
    assert.equal(secondAcquired, true);
  } finally {
    releaseFirst.resolve(undefined);
    await first.catch(() => undefined);
  }
});
