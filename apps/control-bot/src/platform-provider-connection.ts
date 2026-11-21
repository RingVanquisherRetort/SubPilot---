export const PLATFORM_EXTERNAL_PROVIDER_IDS = [
  "YOOKASSA",
  "YOOMONEY",
  "PRODAMUS",
  "ROBOKASSA",
  "CLOUDPAYMENTS",
  "CRYPTO_PAY"
] as const;

export type PlatformExternalProviderId = (typeof PLATFORM_EXTERNAL_PROVIDER_IDS)[number];
export type PlatformProviderEnvironment = "TEST" | "LIVE";

export interface PlatformProviderConnectionInput {
  provider: PlatformExternalProviderId;
  label: string;
  environment: PlatformProviderEnvironment;
}

export function parsePlatformProviderConnectionInput(
  raw: string
): PlatformProviderConnectionInput {
  const fields = raw.split("|").map((field) => field.trim());
  if (fields.length !== 3) {
    throw new Error(
      "Формат: PROVIDER | LABEL | TEST или LIVE. Провайдеры: " +
      PLATFORM_EXTERNAL_PROVIDER_IDS.join(", ")
    );
  }

  const provider = fields[0]?.toUpperCase() as PlatformExternalProviderId | undefined;
  const label = fields[1] ?? "";
  const environment = fields[2]?.toUpperCase() as PlatformProviderEnvironment | undefined;

  if (!provider || !PLATFORM_EXTERNAL_PROVIDER_IDS.includes(provider)) {
    throw new Error("Неизвестный провайдер. Доступны: " + PLATFORM_EXTERNAL_PROVIDER_IDS.join(", "));
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,59}$/.test(label)) {
    throw new Error("Метка подключения должна содержать от 1 до 60 безопасных символов.");
  }
  if (environment !== "TEST" && environment !== "LIVE") {
    throw new Error("Среда подключения должна быть TEST или LIVE.");
  }

  return { provider, label, environment };
}

/**
 * Credentials are deliberately accepted only as a flat JSON object of strings.
 * Provider-specific schemas and a connection test are required before activation.
 */
export function parsePlatformProviderCredentials(raw: string): Record<string, string> {
  if (!raw.trim() || raw.length > 4096) {
    throw new Error("Отправьте JSON с ключами и непустыми строковыми значениями (до 4096 символов).");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Не удалось разобрать JSON. Проверьте синтаксис и отправьте секреты повторно.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Секреты должны быть JSON-объектом, а не массивом или строкой.");
  }

  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 24) {
    throw new Error("JSON должен содержать от 1 до 24 полей.");
  }

  const credentials: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) ||
        typeof value !== "string" ||
        value.trim().length === 0 ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
      throw new Error("Каждое поле должно иметь безопасное имя и непустое строковое значение.");
    }
    credentials[key] = value.trim();
  }

  return credentials;
}
