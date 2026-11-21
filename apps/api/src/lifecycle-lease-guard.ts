export interface LifecycleLeaseGuard {
  isOwned(): boolean;
  markLost(): void;
}

export function createLifecycleLeaseGuard(): LifecycleLeaseGuard {
  let owned = true;

  return {
    isOwned: () => owned,
    markLost: () => {
      owned = false;
    }
  };
}


export function startLifecycleLeaseHeartbeat(input: {
  intervalMs: number;
  renew: () => Promise<boolean>;
  onLost?: (reason: "NOT_OWNER" | "RENEWAL_ERROR") => void;
}): { isOwned: () => boolean; stop: () => void } {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1) {
    throw new Error("Lifecycle heartbeat interval must be a positive integer.");
  }
  const guard = createLifecycleLeaseGuard();
  let inFlight = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || !guard.isOwned() || inFlight) return;
    inFlight = true;
    void input.renew()
      .then((renewed) => {
        if (!renewed && !stopped) {
          guard.markLost();
          try { input.onLost?.("NOT_OWNER"); } catch { /* diagnostics cannot affect lease ownership */ }
        }
      })
      .catch(() => {
        if (!stopped) {
          guard.markLost();
          try { input.onLost?.("RENEWAL_ERROR"); } catch { /* diagnostics cannot affect lease ownership */ }
        }
      })
      .finally(() => { inFlight = false; });
  }, input.intervalMs);
  timer.unref?.();

  return {
    isOwned: guard.isOwned,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}
