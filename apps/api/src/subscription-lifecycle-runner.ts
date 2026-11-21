export interface LifecycleLeaseRunnerOptions {
  leaseId: string;
  heartbeatMs: number;
  acquire: (leaseId: string) => Promise<boolean>;
  renew: (leaseId: string) => Promise<boolean>;
  release: (leaseId: string) => Promise<void>;
  stages: readonly ((isLeaseOwned: () => boolean) => Promise<void>)[];
  onLeaseLost?: (reason: "NOT_OWNER" | "RENEWAL_ERROR") => void;
  onReleaseError?: (error: unknown) => void;
}

/**
 * Runs ordered lifecycle stages under a distributed lease.
 *
 * A heartbeat is never overlapped with another heartbeat. Once renewal fails
 * or throws, ownership is permanently considered lost for this pass. No later
 * stage is started, and release is scoped to this lease ID so a stale worker
 * cannot release a successor's lease.
 */
export async function runLifecyclePassWithLease(
  options: LifecycleLeaseRunnerOptions
): Promise<boolean> {
  if (!Number.isSafeInteger(options.heartbeatMs) || options.heartbeatMs < 1) {
    throw new Error("Lifecycle heartbeat interval must be a positive integer.");
  }
  if (!await options.acquire(options.leaseId)) return false;

  let owned = true;
  let heartbeatInFlight = false;
  const isLeaseOwned = (): boolean => owned;
  const loseLease = (reason: "NOT_OWNER" | "RENEWAL_ERROR"): void => {
    if (!owned) return;
    owned = false;
    try { options.onLeaseLost?.(reason); } catch { /* diagnostics must not affect lease safety */ }
  };

  const heartbeat = setInterval(() => {
    if (!owned || heartbeatInFlight) return;
    heartbeatInFlight = true;
    void options.renew(options.leaseId)
      .then((renewed) => {
        if (!renewed) loseLease("NOT_OWNER");
      })
      .catch(() => loseLease("RENEWAL_ERROR"))
      .finally(() => { heartbeatInFlight = false; });
  }, options.heartbeatMs);
  heartbeat.unref?.();

  try {
    for (const stage of options.stages) {
      if (!owned) return false;
      await stage(isLeaseOwned);
    }
    return owned;
  } finally {
    clearInterval(heartbeat);
    try {
      await options.release(options.leaseId);
    } catch (error) {
      try { options.onReleaseError?.(error); } catch { /* diagnostics must not mask the stage result */ }
    }
  }
}
