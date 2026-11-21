const MAX_TELEGRAM_ID = 9_223_372_036_854_775_807n;

/**
 * Parses a comma-separated platform-operator allowlist.
 * Any malformed entry invalidates the entire configuration (fail closed).
 */
export function parsePlatformAdminTelegramIds(
  value: string | undefined
): ReadonlySet<string> {
  if (!value?.trim()) return new Set();

  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !/^[1-9][0-9]{0,18}$/.test(entry))) {
    return new Set();
  }

  const ids = new Set<string>();
  for (const entry of entries) {
    try {
      const parsed = BigInt(entry);
      if (parsed > MAX_TELEGRAM_ID) return new Set();
      ids.add(parsed.toString());
    } catch {
      return new Set();
    }
  }
  return ids;
}

export function isPlatformAdminTelegramId(
  telegramId: number | string | bigint,
  allowlist: string | undefined
): boolean {
  let normalizedId: string;
  try {
    normalizedId = BigInt(telegramId).toString();
  } catch {
    return false;
  }

  if (!/^[1-9][0-9]{0,18}$/.test(normalizedId)) return false;
  if (BigInt(normalizedId) > MAX_TELEGRAM_ID) return false;
  return parsePlatformAdminTelegramIds(allowlist).has(normalizedId);
}
