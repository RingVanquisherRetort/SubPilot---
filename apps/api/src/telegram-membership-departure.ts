export type TelegramMembershipDepartureKind = "VOLUNTARY_EXIT" | "ADMIN_EXCLUSION" | null;

/**
 * Telegram reports a voluntary leave as "left". A ban or a non-member
 * restricted state is an administrative exclusion and must not trigger
 * automatic invite re-issuance.
 */
export function classifyTelegramMembershipDeparture(
  status: string,
  isMember: boolean
): TelegramMembershipDepartureKind {
  if (status === "kicked" || (status === "restricted" && !isMember)) {
    return "ADMIN_EXCLUSION";
  }
  if (status === "left") return "VOLUNTARY_EXIT";
  return null;
}
