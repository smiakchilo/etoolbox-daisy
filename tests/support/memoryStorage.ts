import { stubGlobals } from './jsdomGlobals';

/** The slice of `Storage` the renderer's persistence stores use. */
export interface StubStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface MemoryStorage extends StubStorage {
  readonly values: Record<string, string>;
  removeItem(key: string): void;
}

/** An in-memory `Storage` stand-in whose backing map is exposed as `values`. */
export function memoryStorage(seed: Readonly<Record<string, string>> = {}): MemoryStorage {
  const values: Record<string, string> = { ...seed };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
    removeItem: (key) => {
      delete values[key];
    },
  };
}

export interface WindowStorageInstaller {
  /** Makes `window.localStorage` the given storage; may be called repeatedly within a test. */
  readonly install: (storage: StubStorage) => void;
  /** Puts the original `window` back (call from `afterEach`). */
  readonly restore: () => void;
}

/** Installs a `window` whose only member is `localStorage`, for stores that touch nothing else. */
export function createWindowStorageInstaller(): WindowStorageInstaller {
  let restoreWindow: (() => void) | undefined;
  return {
    install: (storage) => {
      const stubWindow = { localStorage: storage };
      if (restoreWindow === undefined) {
        restoreWindow = stubGlobals({ window: stubWindow });
      } else {
        Reflect.set(globalThis, 'window', stubWindow);
      }
    },
    restore: () => {
      restoreWindow?.();
      restoreWindow = undefined;
    },
  };
}
