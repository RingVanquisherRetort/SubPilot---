◇ injected env (0) from ../../.env // tip: ⌁ auth for agents [www.vestauth.com]
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "WorkspaceType" AS ENUM ('PERSONAL', 'AGENCY');

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('PENDING', 'ACTIVE', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "TelegramChatType" AS ENUM ('CHANNEL', 'GROUP', 'SUPERGROUP');

-- CreateEnum
CREATE TYPE "CreatorPlanStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED', 'PAST_DUE');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('TELEGRAM_STARS', 'YOOKASSA', 'YOOMONEY', 'PRODAMUS', 'ROBOKASSA', 'CLOUDPAYMENTS', 'CRYPTO_PAY', 'MANUAL');

-- CreateEnum
CREATE TYPE "ProviderConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProviderEnvironment" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "WorkspaceBillingStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "languageCode" TEXT,
    "activeWorkspaceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "WorkspaceType" NOT NULL DEFAULT 'PERSONAL',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MANAGER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceInvite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MANAGER',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT 'RU',
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "defaultCurrency" TEXT NOT NULL DEFAULT 'RUB',
    "creatorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectBot" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "telegramBotId" BIGINT NOT NULL,
    "username" TEXT,
    "displayName" TEXT,
    "tokenEncrypted" TEXT NOT NULL,
    "webhookSecretHash" TEXT,
    "status" "BotStatus" NOT NULL DEFAULT 'PENDING',
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectBot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectedChat" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "telegramChatId" BIGINT NOT NULL,
    "type" "TelegramChatType" NOT NULL,
    "title" TEXT,
    "username" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorPlan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "durationDays" INTEGER,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "status" "CreatorPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorPlanChat" (
    "creatorPlanId" TEXT NOT NULL,
    "connectedChatId" TEXT NOT NULL,

    CONSTRAINT "CreatorPlanChat_pkey" PRIMARY KEY ("creatorPlanId","connectedChatId")
);

-- CreateTable
CREATE TABLE "ProjectCustomer" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "reminder3dAt" TIMESTAMP(3),
    "reminder1dAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionAccessGrant" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "connectedChatId" TEXT NOT NULL,
    "inviteLink" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "joinedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProviderConnection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "label" TEXT NOT NULL,
    "environment" "ProviderEnvironment" NOT NULL DEFAULT 'LIVE',
    "credentialsEncrypted" TEXT NOT NULL,
    "publicConfig" JSONB,
    "status" "ProviderConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "connectionId" TEXT,
    "provider" "PaymentProvider" NOT NULL,
    "providerPaymentId" TEXT,
    "idempotencyKey" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "metadata" JSONB,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT,
    "dedupeKey" TEXT,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "billingPeriodDays" INTEGER NOT NULL DEFAULT 30,
    "features" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceBilling" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platformPlanId" TEXT NOT NULL,
    "status" "WorkspaceBillingStatus" NOT NULL DEFAULT 'TRIALING',
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceBilling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformPayment" (
    "id" TEXT NOT NULL,
    "workspaceBillingId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerPaymentId" TEXT,
    "idempotencyKey" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "paidAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerNotification" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "messageText" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "projectId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_role_idx" ON "WorkspaceMember"("userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvite_tokenHash_key" ON "WorkspaceInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_workspaceId_expiresAt_usedAt_idx" ON "WorkspaceInvite"("workspaceId", "expiresAt", "usedAt");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_invitedByUserId_createdAt_idx" ON "WorkspaceInvite"("invitedByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Project_workspaceId_status_idx" ON "Project"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Project_creatorUserId_idx" ON "Project"("creatorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_workspaceId_slug_key" ON "Project"("workspaceId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectBot_telegramBotId_key" ON "ProjectBot"("telegramBotId");

-- CreateIndex
CREATE INDEX "ProjectBot_projectId_status_idx" ON "ProjectBot"("projectId", "status");

-- CreateIndex
CREATE INDEX "ConnectedChat_projectId_isActive_idx" ON "ConnectedChat"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedChat_projectId_telegramChatId_key" ON "ConnectedChat"("projectId", "telegramChatId");

-- CreateIndex
CREATE INDEX "CreatorPlan_projectId_status_sortOrder_idx" ON "CreatorPlan"("projectId", "status", "sortOrder");

-- CreateIndex
CREATE INDEX "ProjectCustomer_projectId_createdAt_idx" ON "ProjectCustomer"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCustomer_projectId_telegramUserId_key" ON "ProjectCustomer"("projectId", "telegramUserId");

-- CreateIndex
CREATE INDEX "Subscription_projectId_status_endsAt_idx" ON "Subscription"("projectId", "status", "endsAt");

-- CreateIndex
CREATE INDEX "Subscription_customerId_status_idx" ON "Subscription"("customerId", "status");

-- CreateIndex
CREATE INDEX "SubscriptionAccessGrant_connectedChatId_joinedAt_expiresAt_idx" ON "SubscriptionAccessGrant"("connectedChatId", "joinedAt", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionAccessGrant_subscriptionId_connectedChatId_key" ON "SubscriptionAccessGrant"("subscriptionId", "connectedChatId");

-- CreateIndex
CREATE INDEX "PaymentProviderConnection_projectId_provider_status_idx" ON "PaymentProviderConnection"("projectId", "provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderConnection_projectId_provider_label_key" ON "PaymentProviderConnection"("projectId", "provider", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_projectId_status_createdAt_idx" ON "Payment"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_customerId_createdAt_idx" ON "Payment"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_connectionId_providerPaymentId_idx" ON "Payment"("connectionId", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_dedupeKey_key" ON "PaymentWebhookEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_connectionId_receivedAt_idx" ON "PaymentWebhookEvent"("connectionId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_connectionId_providerEventId_key" ON "PaymentWebhookEvent"("connectionId", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPlan_code_key" ON "PlatformPlan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceBilling_workspaceId_key" ON "WorkspaceBilling"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPayment_idempotencyKey_key" ON "PlatformPayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PlatformPayment_workspaceBillingId_status_createdAt_idx" ON "PlatformPayment"("workspaceBillingId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerNotification_dedupeKey_key" ON "OwnerNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "OwnerNotification_sentAt_nextAttemptAt_idx" ON "OwnerNotification"("sentAt", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OwnerNotification_recipientUserId_createdAt_idx" ON "OwnerNotification"("recipientUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_projectId_createdAt_idx" ON "AuditLog"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_creatorUserId_fkey" FOREIGN KEY ("creatorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBot" ADD CONSTRAINT "ProjectBot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedChat" ADD CONSTRAINT "ConnectedChat_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPlan" ADD CONSTRAINT "CreatorPlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPlanChat" ADD CONSTRAINT "CreatorPlanChat_creatorPlanId_fkey" FOREIGN KEY ("creatorPlanId") REFERENCES "CreatorPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorPlanChat" ADD CONSTRAINT "CreatorPlanChat_connectedChatId_fkey" FOREIGN KEY ("connectedChatId") REFERENCES "ConnectedChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCustomer" ADD CONSTRAINT "ProjectCustomer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "ProjectCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CreatorPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionAccessGrant" ADD CONSTRAINT "SubscriptionAccessGrant_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionAccessGrant" ADD CONSTRAINT "SubscriptionAccessGrant_connectedChatId_fkey" FOREIGN KEY ("connectedChatId") REFERENCES "ConnectedChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProviderConnection" ADD CONSTRAINT "PaymentProviderConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "ProjectCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PaymentProviderConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PaymentProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceBilling" ADD CONSTRAINT "WorkspaceBilling_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceBilling" ADD CONSTRAINT "WorkspaceBilling_platformPlanId_fkey" FOREIGN KEY ("platformPlanId") REFERENCES "PlatformPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPayment" ADD CONSTRAINT "PlatformPayment_workspaceBillingId_fkey" FOREIGN KEY ("workspaceBillingId") REFERENCES "WorkspaceBilling"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerNotification" ADD CONSTRAINT "OwnerNotification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerNotification" ADD CONSTRAINT "OwnerNotification_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

