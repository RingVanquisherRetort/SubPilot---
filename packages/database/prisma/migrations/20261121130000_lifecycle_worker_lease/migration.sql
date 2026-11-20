CREATE TABLE "WorkerLease" (
    "key" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkerLease_pkey" PRIMARY KEY ("key")
);
