export const WORKSPACE_PLAN_LIMIT_KEYS = [
  "projects",
  "members",
  "plansPerProject",
  "connectedChatsPerProject"
] as const;

export type WorkspacePlanLimitKey = (typeof WORKSPACE_PLAN_LIMIT_KEYS)[number];
export type WorkspacePlanLimit = number | null;

export interface WorkspacePlanFeatureConfig {
  schemaVersion: 1;
  limits: Record<WorkspacePlanLimitKey, WorkspacePlanLimit>;
}

export interface WorkspaceLimitDecision {
  allowed: boolean;
  limit: WorkspacePlanLimit;
  currentUsage: number;
  requested: number;
  remaining: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLimit(value: unknown, key: WorkspacePlanLimitKey): WorkspacePlanLimit {
  if (value === null) return null;

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid workspace plan limit "${key}": expected a non-negative safe integer or null.`);
  }

  return value;
}

/**
 * Validates the versioned JSON stored in PlatformPlan.features.
 *
 * Example:
 * {
 *   schemaVersion: 1,
 *   limits: {
 *     projects: 3,
 *     members: 1,
 *     plansPerProject: 5,
 *     connectedChatsPerProject: 2
 *   }
 * }
 *
 * A null limit explicitly means unlimited. All keys are required so a typo or
 * missing value cannot silently turn a paid feature into an unlimited one.
 */
export function parseWorkspacePlanFeatureConfig(value: unknown): WorkspacePlanFeatureConfig {
  if (!isRecord(value)) {
    throw new Error("Workspace plan features must be a JSON object.");
  }

  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported workspace plan feature schema version.");
  }

  if (!isRecord(value.limits)) {
    throw new Error("Workspace plan features must include a limits object.");
  }

  const allowedKeys = new Set<string>(WORKSPACE_PLAN_LIMIT_KEYS);
  for (const key of Object.keys(value.limits)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown workspace plan limit "${key}".`);
    }
  }

  const limits = {} as Record<WorkspacePlanLimitKey, WorkspacePlanLimit>;
  for (const key of WORKSPACE_PLAN_LIMIT_KEYS) {
    if (!Object.hasOwn(value.limits, key)) {
      throw new Error(`Missing workspace plan limit "${key}".`);
    }
    limits[key] = parseLimit(value.limits[key], key);
  }

  return { schemaVersion: 1, limits };
}

function assertUsageValue(value: number, name: string, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
}

/**
 * Evaluates whether a requested operation fits the configured workspace plan.
 * Pass null for an explicitly unlimited resource.
 */
export function evaluateWorkspaceLimit(
  limit: WorkspacePlanLimit,
  currentUsage: number,
  requested = 1
): WorkspaceLimitDecision {
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error("Workspace limit must be a non-negative safe integer or null.");
  }
  assertUsageValue(currentUsage, "Current usage", true);
  assertUsageValue(requested, "Requested amount", false);

  const remaining = limit === null ? null : Math.max(0, limit - currentUsage);

  return {
    allowed: limit === null || currentUsage + requested <= limit,
    limit,
    currentUsage,
    requested,
    remaining
  };
}

/**
 * Evaluates a named resource directly against a validated plan configuration.
 */
export function evaluateWorkspacePlanLimit(
  config: WorkspacePlanFeatureConfig,
  resource: WorkspacePlanLimitKey,
  currentUsage: number,
  requested = 1
): WorkspaceLimitDecision {
  return evaluateWorkspaceLimit(config.limits[resource], currentUsage, requested);
}

export type WorkspacePlanUsage = Record<WorkspacePlanLimitKey, number>;
export type WorkspacePlanRequests = Partial<Record<WorkspacePlanLimitKey, number>>;
export type WorkspacePlanEvaluation = Record<WorkspacePlanLimitKey, WorkspaceLimitDecision>;

/**
 * Evaluates every quota in one pass. Omitted requested increments default to
 * one resource, matching the common create-one operation.
 */
export function evaluateWorkspacePlanUsage(
  config: WorkspacePlanFeatureConfig,
  currentUsage: WorkspacePlanUsage,
  requested: WorkspacePlanRequests = {}
): WorkspacePlanEvaluation {
  const result = {} as WorkspacePlanEvaluation;

  for (const resource of WORKSPACE_PLAN_LIMIT_KEYS) {
    result[resource] = evaluateWorkspacePlanLimit(
      config,
      resource,
      currentUsage[resource],
      requested[resource] ?? 1
    );
  }

  return result;
}
