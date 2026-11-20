export function hasInvoiceDispatchStarted(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  return typeof record.invoiceDispatchStartedAt === "string" ||
    (typeof record.invoiceMessageId === "number" && Number.isSafeInteger(record.invoiceMessageId));
}
