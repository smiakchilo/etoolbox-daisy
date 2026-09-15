import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadBrowserPaneFraction,
  saveBrowserPaneFraction,
} from '../../../src/renderer/src/lib/paneLayoutStore';

/**
 * `paneLayoutStore.ts` touches nothing but `window.localStorage`, so a
 * minimal stub is enough here - and it is the only way to exercise the
 * "storage throws" paths (a real `localStorage` will not throw on demand),
 * which are exactly the paths that must not take the window down with them.
 */

interface StubStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const previousWindow = Reflect.get(globalThis, 'window') as unknown;

function installStorage(storage: StubStorage): void {
  Reflect.set(globalThis, 'window', { localStorage: storage });
}

function memoryStorage(seed: Record<string, string> = {}): StubStorage & {
  readonly values: Record<string, string>;
} {
  const values: Record<string, string> = { ...seed };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

beforeEach(() => {
  installStorage(memoryStorage());
});

afterEach(() => {
  Reflect.set(globalThis, 'window', previousWindow);
});

describe('pane layout persistence', () => {
  it('round-trips a committed fraction', () => {
    saveBrowserPaneFraction(0.42);
    expect(loadBrowserPaneFraction()).toBeCloseTo(0.42, 10);
  });

  it('reports no stored value on a first run', () => {
    expect(loadBrowserPaneFraction()).toBeUndefined();
  });

  it('discards a stored value that would collapse a pane', () => {
    const storage = memoryStorage({ 'daisy.mainShell.browserPaneFraction': '1' });
    installStorage(storage);
    expect(loadBrowserPaneFraction()).toBeUndefined();
  });

  it('discards an unparseable stored value instead of yielding NaN', () => {
    installStorage(memoryStorage({ 'daisy.mainShell.browserPaneFraction': 'not-a-number' }));
    expect(loadBrowserPaneFraction()).toBeUndefined();
  });

  it('never writes a fraction that could not be read back', () => {
    const storage = memoryStorage();
    installStorage(storage);
    saveBrowserPaneFraction(Number.NaN);
    saveBrowserPaneFraction(0);
    saveBrowserPaneFraction(1);
    expect(Object.keys(storage.values)).toHaveLength(0);
  });

  it('survives storage that throws on read', () => {
    installStorage({
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => undefined,
    });
    expect(loadBrowserPaneFraction()).toBeUndefined();
  });

  it('survives storage that throws on write', () => {
    installStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    });
    expect(() => saveBrowserPaneFraction(0.5)).not.toThrow();
  });
});
