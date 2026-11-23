import type { Bot } from "grammy";
import { prisma } from "@subpilot/database";
import { isTelegramInviteAlreadyRevoked } from "@subpilot/payments";

export async function retryInviteCompensation(inviteLink: string, telegramChatId: bigint, bot: Bot | null): Promise<void> {
  const now = new Date();
  const claimed = await prisma.inviteCompensation.updateMany({
    where: { inviteLink, nextAttemptAt: { lte: now }, expiresAt: { gt: now } },
    data: { nextAttemptAt: new Date(now.getTime() + 60_000) }
  });
  if (!claimed.count || !bot) return;
  // A lost database acknowledgement can hide a committed grant. Leave a live credential alone.
  const live = await prisma.subscriptionAccessGrant.findFirst({ where: { inviteLink, revokedAt: null }, select: { id: true } });
  if (!live) {
    try { await bot.api.revokeChatInviteLink(telegramChatId.toString(), inviteLink); }
    catch (error) { if (!isTelegramInviteAlreadyRevoked(error)) return; }
  }
  await prisma.inviteCompensation.deleteMany({ where: { inviteLink } });
}

export async function compensateInvite(bot: Bot, projectId: string, telegramChatId: bigint, inviteLink: string, expiresAt: Date): Promise<void> {
  const telegramBotId = BigInt(bot.token.split(":")[0]!);
  await prisma.inviteCompensation.upsert({ where: { inviteLink }, update: {},
    create: { inviteLink, projectId, telegramBotId, telegramChatId, expiresAt } });
  await retryInviteCompensation(inviteLink, telegramChatId, bot);
}
