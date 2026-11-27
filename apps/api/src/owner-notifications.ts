import { Bot } from "grammy";
import { prisma } from "@subpilot/database";
import {
  isCurrentOwnerNotificationRecipient,
  selectOwnerNotificationRecipientIds
} from "./owner-notifications-policy.js";

const MAX_ATTEMPTS = 10;
const BATCH_SIZE = 100;

type OwnerNotificationEvent = {
  projectId: string;
  dedupeKey: string;
  eventType: string;
  messageText: string;
  messageTextEn?: string;
};

let controlBot: Bot | null = null;

function getControlBot(): Bot | null {
  const token = process.env.CONTROL_BOT_TOKEN?.trim();
  if (!token) return null;
  if (!controlBot) controlBot = new Bot(token);
  return controlBot;
}

type OwnerNotificationDbClient = Pick<
  typeof prisma,
  "project" | "workspaceMember" | "ownerNotification"
>;

/** Queue an event using either the main client or an existing transaction client. */
export async function enqueueProjectOwnerNotificationUsing(
  db: OwnerNotificationDbClient,
  event: OwnerNotificationEvent
): Promise<void> {
  const project = await db.project.findUnique({
    where: { id: event.projectId },
    select: {
      id: true,
      workspaceId: true,
      creatorUser: { select: { id: true, interfaceLocale: true } },
      workspace: { select: { createdBy: { select: { id: true, interfaceLocale: true } } } }
    }
  });
  if (!project) return;

  const workspaceOwnerId = project.workspace.createdBy.id;
  const creatorIsWorkspaceMember = project.creatorUser
    ? Boolean(await db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: project.workspaceId,
            userId: project.creatorUser.id
          }
        },
        select: { id: true }
      }))
    : false;
  const recipientIds = selectOwnerNotificationRecipientIds(
    workspaceOwnerId,
    project.creatorUser?.id ?? null,
    creatorIsWorkspaceMember
  );

  await db.ownerNotification.createMany({
    data: recipientIds.map((recipientUserId) => ({
      projectId: project.id,
      recipientUserId,
      eventType: event.eventType,
      dedupeKey: `${event.dedupeKey}:recipient:${recipientUserId}`,
      messageText: (recipientUserId === workspaceOwnerId
        ? project.workspace.createdBy.interfaceLocale
        : project.creatorUser?.interfaceLocale) === "en"
        ? event.messageTextEn ?? event.messageText
        : event.messageText
    })),
    skipDuplicates: true
  });
}

/** Queue an event for the workspace owner and active project creator. */
export async function enqueueProjectOwnerNotification(event: OwnerNotificationEvent): Promise<void> {
  await enqueueProjectOwnerNotificationUsing(prisma, event);
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
    include: {
      recipient: { select: { id: true, telegramId: true } },
      project: { select: { workspaceId: true, workspace: { select: { createdById: true } } } }
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE
  });

  for (const notification of pending) {
    if (!isLeaseOwned()) return;
    const isWorkspaceMember = notification.recipient.id === notification.project.workspace.createdById
      ? true
      : Boolean(await prisma.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: notification.project.workspaceId,
              userId: notification.recipient.id
            }
          },
          select: { id: true }
        }));
    if (!isCurrentOwnerNotificationRecipient(
      notification.recipient.id,
      notification.project.workspace.createdById,
      isWorkspaceMember
    )) {
      await prisma.ownerNotification.update({
        where: { id: notification.id },
        data: { attempts: MAX_ATTEMPTS, lastError: "RECIPIENT_NO_LONGER_WORKSPACE_MEMBER" }
      });
      continue;
    }
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
