export interface TelegramProjectBotChatMember {
  status: string;
  can_invite_users?: boolean;
  can_restrict_members?: boolean;
}

/** A project bot needs invite and member-restriction rights for the full paid-access lifecycle. */
export function hasRequiredSubscriptionChatRights(
  member: TelegramProjectBotChatMember
): boolean {
  return member.status === "creator" ||
    (member.status === "administrator" &&
      member.can_invite_users === true &&
      member.can_restrict_members === true);
}

/**
 * Some Telegram getChatMember failures explicitly mean that the buyer has not
 * joined the chat yet. A transport, permission or rate-limit failure does not:
 * never issue an invite on the assumption that an unknown member is unbanned.
 */
export function isExplicitTelegramNonMemberError(error: unknown): boolean {
  const details = typeof error === "object" && error !== null
    ? error as { description?: unknown; message?: unknown }
    : null;
  const message = typeof details?.description === "string"
    ? details.description
    : typeof details?.message === "string"
      ? details.message
      : "";
  return /(?:USER_NOT_PARTICIPANT|user (?:is )?not a participant|user not found)/i.test(message);
}
