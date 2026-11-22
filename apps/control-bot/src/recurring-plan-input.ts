/**
 * Parse the optional recurring-plan flag accepted by owner tariff commands.
 * undefined means the caller should keep its default/current value;
 * null means the supplied value is invalid.
 */
export function parseOptionalRecurringFlag(value: string | undefined): boolean | null | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  switch (value.trim().toLowerCase()) {
    case "да":
    case "yes":
    case "true":
    case "1":
      return true;
    case "нет":
    case "no":
    case "false":
    case "0":
      return false;
    default:
      return null;
  }
}
