/** Resolve the recorded purchase destinations. Ambiguous legacy invoices must be reissued. */
export function paidInvoiceChatIds(metadata: unknown): bigint[] | null {
  if (!metadata || typeof metadata !== "object" || !("chatIds" in metadata)) return null;
  const ids = metadata.chatIds;
  if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === "string" && /^-?\d{1,19}$/.test(id))) return null;
  const values = [...new Set(ids.map(id => BigInt(id)))];
  return values.every(id => BigInt.asIntN(64, id) === id) ? values : null;
}
