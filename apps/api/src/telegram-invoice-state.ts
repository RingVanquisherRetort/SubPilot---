export type InvoiceDispatchState = "NOT_STARTED" | "AMBIGUOUS" | "SENT";

export function getInvoiceDispatchState(metadata: unknown): InvoiceDispatchState {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "NOT_STARTED";
  }
  const record = metadata as Record<string, unknown>;
  if (typeof record.invoiceMessageId === "number" && Number.isSafeInteger(record.invoiceMessageId)) {
    return "SENT";
  }
  if (typeof record.invoiceDispatchStartedAt === "string") {
    return "AMBIGUOUS";
  }
  return "NOT_STARTED";
}

export function hasInvoiceDispatchStarted(metadata: unknown): boolean {
  return getInvoiceDispatchState(metadata) !== "NOT_STARTED";
}
