export type AndroidBackFailure = "register" | "remove" | "navigate";
export type AndroidBackRelease = () => void | Promise<void>;
export type AndroidBackRegistrar = (
  handler: () => void,
) => Promise<AndroidBackRelease | undefined>;
export type BackAction = () => void | Promise<void>;
export type RegisterBackAction = (action: BackAction) => () => void;

/** Screen cleanup cannot retire a newer screen's on-screen Back action. */
export function createBackActionSlot() {
  let current: BackAction | undefined;
  return {
    register(action: BackAction) {
      current = action;
      return () => { if (current === action) current = undefined; };
    },
    run: () => current?.(),
  };
}

export interface AndroidBackTarget {
  owner: object;
  scope: string;
  isActive: () => boolean;
  back: BackAction;
}

/** One app-owned lease, only while an in-app surface needs Back. */
export function createAndroidBackNavigation(options: {
  register: AndroidBackRegistrar;
  onFailure: (failure: AndroidBackFailure | undefined) => void;
}) {
  let target: AndroidBackTarget | undefined;
  let generation = 0;
  let attempted: number | undefined;
  let handling: number | undefined;
  let lease: { generation: number; release: AndroidBackRelease } | undefined;
  let disposed = false;
  let dirty = false;
  let running: Promise<void> | undefined;

  async function reconcile() {
    while (true) {
      if (lease && (lease.generation !== generation || !target || disposed)) {
        try {
          await lease.release();
          lease = undefined;
          options.onFailure(undefined);
        } catch {
          // Keep the handle for explicit retry. A fenced JS callback alone
          // does not restore Android's default behavior while a listener exists.
          options.onFailure("remove");
          return;
        }
        continue;
      }
      if (disposed || !target || lease || attempted === generation) return;
      const owner = generation;
      attempted = owner;
      let release: AndroidBackRelease | undefined;
      try {
        release = await options.register(() => {
          if (
            disposed || owner !== generation || lease?.generation !== owner ||
            !target?.isActive() || handling === owner
          ) return;
          handling = owner;
          void Promise.resolve().then(() => {
            // Render updates can replace a target object without changing its
            // owner/account. Generation, not object equality, fences Back.
            if (owner === generation && target?.isActive()) return target.back();
          }).catch(() => {
            if (owner === generation) options.onFailure("navigate");
          }).finally(() => {
            if (handling === owner) handling = undefined;
          });
        });
      } catch {
        options.onFailure("register");
        return;
      }
      if (!release) {
        if (owner === generation) options.onFailure(undefined);
        return; // Non-Android/web registrars deliberately return no listener.
      }
      lease = { generation: owner, release };
      if (owner === generation) options.onFailure(undefined);
      // A late registration must be removed before another can be created.
    }
  }

  function schedule(): Promise<void> {
    dirty = true;
    if (!running) {
      running = Promise.resolve().then(async () => {
        while (dirty) {
          dirty = false;
          await reconcile();
        }
      }).finally(() => {
        running = undefined;
        if (dirty) void schedule();
      });
    }
    return running;
  }

  function setTarget(next: AndroidBackTarget | undefined): Promise<void> {
    if (disposed) return Promise.resolve();
    const unchanged = target?.owner === next?.owner && target?.scope === next?.scope;
    target = next;
    if (unchanged) return running ?? Promise.resolve();
    generation++;
    return schedule();
  }

  return {
    setTarget,
    clear(owner: object) {
      return target?.owner === owner ? setTarget(undefined) : Promise.resolve();
    },
    retry() {
      attempted = undefined;
      return schedule();
    },
    dispose() {
      disposed = true;
      target = undefined;
      generation++;
      return schedule();
    },
  };
}
