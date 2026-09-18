export const AUTO_SAVE_MS = 1000;

/**
 * A debounced job. `Promise<unknown>` rather than `Promise<void>`: a caller
 * (section) returns its IPC outcome promise so `start`/`flushNow` actually
 * await the save itself, not just the debounce callback returning. The
 * resolved value is irrelevant - the scheduler only waits for settlement.
 */
type Run = () => void | Promise<unknown>;

export interface AutoSave {
  arm(run: Run): void;
  flushNow(): Promise<void>;
  /** True while a debounced (not yet run) save is waiting, or a save is running. */
  hasPending(): boolean;
  /** Drops a not-yet-run save and its timer. An in-flight save keeps running. */
  cancel(): void;
  dispose(): void;
}

export function createAutoSave(delayMs: number = AUTO_SAVE_MS): AutoSave {
  let pending: Run | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  let flushing = false;

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule(): void {
    clearTimer();
    if (disposed || pending === null || running !== null || flushing) return;
    timer = setTimeout(() => {
      timer = null;
      void start();
    }, delayMs);
  }

  function start(): Promise<void> {
    if (running !== null) return running;
    const run = pending;
    if (disposed || run === null) return Promise.resolve();
    pending = null;
    running = Promise.resolve()
      .then(run)
      .then(() => undefined)
      .catch(() => {
        console.error('[daisy] Settings auto-save failed.');
      })
      .finally(() => {
        running = null;
        schedule();
      });
    return running;
  }

  return {
    arm(run): void {
      if (disposed) return;
      pending = run;
      schedule();
    },
    async flushNow(): Promise<void> {
      clearTimer();
      flushing = true;
      try {
        while (running !== null || (!disposed && pending !== null)) {
          await start();
        }
      } finally {
        flushing = false;
        schedule();
      }
    },
    hasPending: () => pending !== null || running !== null,
    cancel(): void {
      pending = null;
      clearTimer();
    },
    dispose(): void {
      disposed = true;
      pending = null;
      clearTimer();
    },
  };
}
