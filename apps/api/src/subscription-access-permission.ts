export interface SubscriptionAccessPermissionState {
  subscriptionStatus: string;
  subscriptionStartsAt: Date | null;
  subscriptionEndsAt: Date | null;
  grantRevokedAt: Date | null | undefined;
}

/**
 * A subscription is the billing entitlement; each access grant is a separate,
 * concrete permission for one Telegram chat. An active subscription must never
 * override a revoked/missing per-chat grant.
 */
export function isSubscriptionAccessPermissionActive(
  state: SubscriptionAccessPermissionState,
  now = new Date()
): boolean {
  if (state.subscriptionStatus !== "ACTIVE") return false;
  if (state.grantRevokedAt !== null) return false;
  if (state.subscriptionStartsAt && state.subscriptionStartsAt > now) return false;
  if (state.subscriptionEndsAt && state.subscriptionEndsAt <= now) return false;
  return true;
}
