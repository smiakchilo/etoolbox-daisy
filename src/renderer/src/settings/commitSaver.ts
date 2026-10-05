/**
 * The one saver every editable Settings field is built on. A "commit" is a
 * deliberate act - leaving a text field (`change`: blur or Enter), picking from
 * a picker, or choosing a colour swatch - so there is no debounce: an armed run
 * executes as soon as the current event finishes.
 *
 * The scheduler exists only to serialize. A commit armed while a previous one
 * is still in flight is held and started once that one settles, so two quick
 * commits can never run concurrently - which is what would otherwise let a
 * draft row be created twice. It uses a microtask, never a timer.
 *
 * Rules under test:
 * - Each arm replaces any not-yet-started run: only the latest wins.
 * - A run armed during an in-flight commit starts only after it settles.
 * - `flushNow` runs pending work immediately and waits for in-flight work
 *   (the close-and-persist path); `hasPending` tracks both states.
 * - A throwing/rejected run is swallowed and logged, never a rejection that
 *   could bubble into an unhandled promise across IPC.
 * - `cancel` drops a not-yet-started run; an in-flight run keeps running.
 * - `dispose` cancels pending work and ignores later arms.
 */

type Run = () => void | Promise<unknown>;

export interface CommitSaver {
  /** Queues a commit. It runs as soon as the current event finishes. */
  arm(run: Run): void;
  /** Runs pending work now and waits for everything in flight to settle. */
  flushNow(): Promise<void>;
  /** True while a commit is queued or in flight. */
  hasPending(): boolean;
  /** Drops a not-yet-started commit. An in-flight commit keeps running. */
  cancel(): void;
  dispose(): void;
}

export function createCommitSaver(): CommitSaver {
  let pending: Run | null = null;
  let running: Promise<void> | null = null;
  let scheduled = false;
  let disposed = false;

  function start(): Promise<void> {
    if (running !== null) return running;
    const run = pending;
    if (disposed || run === null) return Promise.resolve();
    pending = null;
    running = Promise.resolve()
      .then(run)
      .then(() => undefined)
      .catch(() => {
        console.error('[daisy] Settings save failed');
      })
      .finally(() => {
        running = null;
        if (!disposed && pending !== null) schedule();
      });
    return running;
  }

  // Defer the start to the end of the current event, so a burst of arms within
  // one event coalesces into the latest run and `cancel` can still drop it.
  function schedule(): void {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void start();
    });
  }

  return {
    arm(run): void {
      if (disposed) return;
      pending = run;
      if (running === null) schedule();
    },
    async flushNow(): Promise<void> {
      while (!disposed && (running !== null || pending !== null)) {
        await start();
      }
    },
    hasPending: () => pending !== null || running !== null,
    cancel(): void {
      pending = null;
    },
    dispose(): void {
      disposed = true;
      pending = null;
    },
  };
}
