export function shouldQueueNewSubscriberNotification(
  payload: unknown,
  paymentStatus: string
): boolean {
  return paymentStatus === "SUCCEEDED" &&
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).isInitialActivation === true;
}
