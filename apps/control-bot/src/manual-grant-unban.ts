import type { Bot } from "grammy";
import { prisma } from "@subpilot/database";
import { lockSubscriptionAccessScope, requestSubscriptionAccessReconciliation } from "@subpilot/payments";

/** Called only by a fresh explicit manual grant. Background retries never dispatch an unban. */
export async function applyManualGrantUnban(input: {
  bot: Pick<Bot, "api">;
  subscriptionId: string;
  scope: { id: string; customerId: string; connectedChatId: string; desiredRevision: bigint };
  actorUserId: string;
  grantAuditId: string;
}) {
  const { scope, bot } = input;
  const grant = await prisma.subscriptionAccessGrant.findUnique({
    where: { subscriptionId_connectedChatId: { subscriptionId: input.subscriptionId, connectedChatId: scope.connectedChatId } },
    include: { connectedChat: true, subscription: { include: { customer: true, project: true } } }
  });
  if (!grant || grant.revokedAt || !grant.connectedChat.isActive || grant.connectedChat.type === "GROUP") return;
  const { project, customer } = grant.subscription;
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: project.workspaceId, userId: input.actorUserId, role: { in: ["OWNER", "ADMIN"] } },
    include: { user: true }
  });
  if (!membership) return;
  const chat = String(grant.connectedChat.telegramChatId);
  const buyer = Number(customer.telegramUserId);
  const actorId = Number(membership.user.telegramId);
  if (!Number.isSafeInteger(buyer) || !Number.isSafeInteger(actorId)) return;
  if ((await bot.api.getChatMember(chat, buyer)).status !== "kicked") return;
  const actor = await bot.api.getChatMember(chat, actorId);
  if (actor.status !== "creator" && !(actor.status === "administrator" && actor.can_restrict_members)) return;

  const claimed = await prisma.$transaction(async tx => {
    await lockSubscriptionAccessScope(tx, scope.customerId, scope.connectedChatId);
    const current = await tx.subscriptionAccessScope.findUnique({ where: { id: scope.id } });
    if (current?.desiredRevision !== scope.desiredRevision) return false;
    const now = new Date();
    const valid = await tx.subscriptionAccessGrant.count({ where: {
      id: grant.id, revokedAt: null, connectedChat: { isActive: true }, subscription: {
        customerId: scope.customerId, status: "ACTIVE", grantType: "MANUAL",
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        project: { status: "ACTIVE", workspace: { members: { some: { userId: input.actorUserId, role: { in: ["OWNER", "ADMIN"] } } } } }
      }
    } });
    if (!valid) return false;
    const prior = await tx.auditLog.findFirst({ where: {
      action: "MANUAL_GRANT_UNBAN_DISPATCHED", resourceId: grant.id,
      metadata: { path: ["grantAuditId"], equals: input.grantAuditId }
    } });
    if (prior) return false;
    await tx.auditLog.create({ data: {
      action: "MANUAL_GRANT_UNBAN_DISPATCHED", resourceId: grant.id, resourceType: "SubscriptionAccessGrant",
      workspaceId: project.workspaceId, projectId: project.id, actorUserId: input.actorUserId,
      metadata: { grantAuditId: input.grantAuditId, revision: String(scope.desiredRevision) }
    } });
    return true;
  });
  if (!claimed) return;
  await bot.api.unbanChatMember(chat, buyer, { only_if_banned: true });
  if ((await bot.api.getChatMember(chat, buyer)).status !== "left") return;
  await prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "SubscriptionAccessGrant" WHERE "id" = $1 FOR UPDATE', grant.id);
    await lockSubscriptionAccessScope(tx, scope.customerId, scope.connectedChatId);
    const current = await tx.subscriptionAccessScope.findUnique({ where: { id: scope.id } });
    if (current?.desiredRevision !== scope.desiredRevision) return;
    const updated = await tx.subscriptionAccessGrant.updateMany({ where: { id: grant.id, revokedAt: null },
      data: { joinedAt: null, deliveryAttempts: 0, deliveryFailedAt: null, deliveryLastError: null, deliveryNextAttemptAt: new Date() } });
    if (updated.count) await requestSubscriptionAccessReconciliation(tx, scope.customerId, [scope.connectedChatId]);
  });
}
