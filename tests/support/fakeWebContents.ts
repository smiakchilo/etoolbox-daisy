import type { WebContents } from 'electron';

/**
 * A minimal event-emitter-shaped `WebContents` for unit tests.
 *
 * A real `WebContents` cannot be constructed outside Electron, but the code
 * under test only ever attaches listeners (and, in some cases, calls a couple of
 * methods). This fake records the listeners so a test can *drive* the event the
 * production code registered - the only way to check that wiring is real rather
 * than merely present.
 */
export interface FakeWebContents {
  readonly webContents: WebContents;
  /** Drives a listener the production code registered, as Electron would. */
  emit(event: string, ...args: unknown[]): void;
  listenerCount(event: string): number;
  /** Grafts an extra method (e.g. `send`, `focus`) onto the fake. */
  define(name: string, value: unknown): void;
}

export function createFakeWebContents(): FakeWebContents {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const add = (event: string, listener: (...args: never[]) => void): void => {
    const existing = listeners.get(event) ?? new Set();
    existing.add(listener);
    listeners.set(event, existing);
  };
  const webContents = {
    on: (event: string, listener: (...args: never[]) => void) => {
      add(event, listener);
      return webContents;
    },
    once: (event: string, listener: (...args: never[]) => void) => {
      add(event, listener);
      return webContents;
    },
    off: (event: string, listener: (...args: never[]) => void) => {
      listeners.get(event)?.delete(listener);
      return webContents;
    },
    isDestroyed: () => false,
  } as unknown as WebContents;
  return {
    webContents,
    emit: (event, ...args) => {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        (listener as (...callArgs: unknown[]) => void)(...args);
      }
    },
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    define: (name, value) => {
      Reflect.set(webContents, name, value);
    },
  };
}
