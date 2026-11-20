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
