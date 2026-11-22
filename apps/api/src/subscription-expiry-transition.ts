/**
 * Compare-and-set guard for the transition from ACTIVE to EXPIRED.
 *
 * The callback is run in the caller's transaction. Side effects are executed
 * only when the conditional state update changed exactly one row. Callers must
 * not revoke external access when this returns false.
 */
export async function claimSubscriptionExpiry(
  updateStatus: () => Promise<{ count: number }>,
  enqueueTransitionEffects: () => Promise<void>
): Promise<boolean> {
  const result = await updateStatus();
  if (result.count !== 1) return false;
  await enqueueTransitionEffects();
  return true;
}
