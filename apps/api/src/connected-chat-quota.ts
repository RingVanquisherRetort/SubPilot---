const REQUIRED_LIMIT_KEYS = [
  "projects",
  "members",
  "plansPerProject",
  "connectedChatsPerProject"
] as const;

export interface ConnectedChatQuotaBillingState {
  status: string;
  currentPeriodEnd?: Date | null;
  platformPlanIsActive: boolean;
  features: unknown;
}

export interface ConnectedChatQuotaDecisionInput {
  hasRequiredRights: boolean;
  wasAlreadyActive: boolean;
  billing: ConnectedChatQuotaBillingState | null;
  currentActiveChats: number;
}

/**
 * Fail-closed gate for a Telegram-confirmed chat activation.
 *
 * Existing active chats remain active while Telegram permissions remain valid;
 * a new/reactivated chat consumes one slot. Workspaces without an assigned
 * platform billing record are temporarily grandfathered until plan assignment.
 */
export function shouldActivateConnectedChat(
  input: ConnectedChatQuotaDecisionInput
): boolean {
  if (!input.hasRequiredRights) return false;
  if (input.wasAlreadyActive) return true;
  if (!input.billing) return true;

  if (
    input.billing.status !== "ACTIVE" &&
    input.billing.status !== "TRIALING"
  ) return false;
  if (input.billing.currentPeriodEnd && !(input.billing.currentPeriodEnd.getTime() > Date.now())) return false;
  if (!input.billing.platformPlanIsActive) return false;
  if (!Number.isSafeInteger(input.currentActiveChats) || input.currentActiveChats < 0) {
    return false;
  }

  const features = input.billing.features;
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    return false;
  }
  const featureObject = features as Record<string, unknown>;
  if (featureObject.schemaVersion !== 1) return false;

  const limits = featureObject.limits;
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
    return false;
  }
  const limitObject = limits as Record<string, unknown>;
  if (Object.keys(limitObject).length !== REQUIRED_LIMIT_KEYS.length) return false;

  for (const key of REQUIRED_LIMIT_KEYS) {
    const value = limitObject[key];
    if (!Object.hasOwn(limitObject, key)) return false;
    if (
      value !== null &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    ) return false;
  }

  const chatLimit = limitObject.connectedChatsPerProject;
  if (chatLimit === null) return true;
  return typeof chatLimit === "number" &&
    Number.isSafeInteger(chatLimit) &&
    chatLimit >= 0 &&
    input.currentActiveChats < chatLimit;
}
