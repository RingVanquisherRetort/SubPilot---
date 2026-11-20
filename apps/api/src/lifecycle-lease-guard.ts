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
