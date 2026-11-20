import { Bot } from "grammy";
import { prisma } from "@subpilot/database";

const MAX_ATTEMPTS = 10;
const BATCH_SIZE = 100;

type OwnerNotificationEvent = {
  projectId: string;
  dedupeKey: string;
  eventType: string;
  messageText: string;
};

let controlBot: Bot | null = null;

function getControlBot(): Bot | null {
  const token = process.env.CONTROL_BOT_TOKEN?.trim();
  if (!token) return null;
  if (!controlBot) controlBot = new Bot(token);
  return controlBot;
}

/** Queue an event for the workspace owner and project creator, deduplicating identical recipients. */
export async function enqueueProjectOwnerNotification(event: OwnerNotificationEvent): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: event.projectId },
    select: {
      id: true,
      creatorUser: { select: { id: true } },
      workspace: { select: { createdBy: { select: { id: true } } } }
    }
  });
  if (!project) return;

  const recipientIds = new Set<string>([project.workspace.createdBy.id]);
  if (project.creatorUser) recipientIds.add(project.creatorUser.id);

  await prisma.ownerNotification.createMany({
    data: [...recipientIds].map((recipientUserId) => ({
      projectId: project.id,
      recipientUserId,
      eventType: event.eventType,
      dedupeKey: `${event.dedupeKey}:recipient:${recipientUserId}`,
      messageText: event.messageText
    })),
    skipDuplicates: true
  });
}

/** Deliver queued events through the central bot; failed deliveries retry with exponential backoff. */
export async function deliverPendingOwnerNotifications(
  now = new Date(),
  isLeaseOwned: () => boolean = () => true
): Promise<void> {
  const bot = getControlBot();
  if (!bot) return;

  const pending = await prisma.ownerNotification.findMany({
    where: { sentAt: null, attempts: { lt: MAX_ATTEMPTS }, nextAttemptAt: { lte: now } },
    include: { recipient: { select: { telegramId: true } } },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE
  });

  for (const notification of pending) {
    if (!isLeaseOwned()) return;
    try {
      await bot.api.sendMessage(Number(notification.recipient.telegramId), notification.messageText);
      await prisma.ownerNotification.update({
        where: { id: notification.id },
        data: { sentAt: now, attempts: { increment: 1 }, lastError: null }
      });
    } catch (error) {
      const retryMinutes = Math.min(60, 2 ** Math.min(notification.attempts, 6));
      await prisma.ownerNotification.update({
        where: { id: notification.id },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(now.getTime() + retryMinutes * 60_000),
          lastError: error instanceof Error ? error.name : "UnknownError"
        }
      });
      console.error("Could not deliver SubPilot owner notification:",
        error instanceof Error ? error.name : "UnknownError");
    }
  }
}
