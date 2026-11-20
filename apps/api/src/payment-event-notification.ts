export function wasInitialSubscriptionActivationEvent(payload: unknown): boolean {
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).isInitialActivation === true;
}
