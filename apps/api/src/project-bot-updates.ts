import { Bot } from "grammy";
import { prisma } from "@subpilot/database";

type TelegramUpdate = Parameters<Bot["handleUpdate"]>[0];

/**
 * Processes a single update for a connected project bot.
 * No polling is started; updates are dispatched by the authenticated webhook route.
 */
export async function handleProjectBotUpdate(
  botToken: string,
  projectId: string,
  update: TelegramUpdate
): Promise<void> {
  const projectBot = new Bot(botToken);

  projectBot.on("my_chat_member", async (ctx) => {
    const chat = ctx.myChatMember.chat;

    const chatType =
      chat.type === "channel" ? "CHANNEL" :
      chat.type === "group" ? "GROUP" :
      chat.type === "supergroup" ? "SUPERGROUP" :
      null;

    if (!chatType) return;

    const membershipStatus = ctx.myChatMember.new_chat_member.status;
    const isActive = membershipStatus === "administrator" || membershipStatus === "creator";

    await prisma.connectedChat.upsert({
      where: {
        projectId_telegramChatId: {
          projectId,
          telegramChatId: BigInt(chat.id)
        }
      },
      create: {
        projectId,
        telegramChatId: BigInt(chat.id),
        type: chatType,
        title: "title" in chat ? chat.title ?? null : null,
        username: "username" in chat ? chat.username ?? null : null,
        isActive
      },
      update: {
        type: chatType,
        title: "title" in chat ? chat.title ?? null : null,
        username: "username" in chat ? chat.username ?? null : null,
        isActive
      }
    });
  });

  await projectBot.handleUpdate(update);
}
