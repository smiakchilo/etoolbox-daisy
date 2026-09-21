import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachWindowStatePersistence,
  DEFAULT_WINDOW_STATE,
  fitWindowStateToWorkArea,
  normalizeWindowState,
  parseWindowStateJson,
  readWindowState,
  serializeWindowState,
  writeWindowState,
  type WindowSize,
  type WindowStateSource,
} from '../../../src/main/windowState';

/**
 * Scratch directories live under the project's own `test-results/` (already
 * gitignored) and are removed after every test - never `/tmp`/`os.tmpdir()`.
 * Matches tests/unit/main/appPaths.test.ts.
 */
const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'main-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'windowState-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FakeWindow extends WindowStateSource {
  bounds: WindowSize;
  maximized: boolean;
  emit(event: 'resize' | 'maximize' | 'unmaximize' | 'close'): void;
}

function createFakeWindow(initial: {
  width: number;
  height: number;
  maximized: boolean;
}): FakeWindow {
  const listeners = new Map<string, Set<() => void>>();
  const window: FakeWindow = {
    bounds: { width: initial.width, height: initial.height },
    maximized: initial.maximized,
    getNormalBounds: () => ({ ...window.bounds }),
    isMaximized: () => window.maximized,
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(event, set);
      return window;
    },
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
  return window;
}

describe('normalizeWindowState', () => {
  it('falls back to the default for a non-object value', () => {
    expect(normalizeWindowState(undefined)).toEqual(DEFAULT_WINDOW_STATE);
    expect(normalizeWindowState('nonsense')).toEqual(DEFAULT_WINDOW_STATE);
    expect(normalizeWindowState(null)).toEqual(DEFAULT_WINDOW_STATE);
  });

  it('accepts a fully valid stored state unchanged', () => {
    expect(normalizeWindowState({ width: 1600, height: 900, maximized: true })).toEqual({
      width: 1600,
      height: 900,
      maximized: true,
    });
  });

  it('falls back per-field, so one bad dimension keeps the others', () => {
    expect(normalizeWindowState({ width: 'wide', height: 900, maximized: true })).toEqual({
      width: DEFAULT_WINDOW_STATE.width,
      height: 900,
      maximized: true,
    });
  });

  it('rounds a fractional dimension', () => {
    expect(normalizeWindowState({ width: 1280.4, height: 800.6, maximized: false })).toEqual({
      width: 1280,
      height: 801,
      maximized: false,
    });
  });

  it('rejects a dimension below the usable minimum', () => {
    expect(normalizeWindowState({ width: 100, height: 800, maximized: false }).width).toBe(
      DEFAULT_WINDOW_STATE.width,
    );
  });

  it('rejects an absurd dimension', () => {
    expect(normalizeWindowState({ width: 1e9, height: 800, maximized: false }).width).toBe(
      DEFAULT_WINDOW_STATE.width,
    );
  });

  it('treats a non-boolean maximized flag as false', () => {
    expect(normalizeWindowState({ width: 1280, height: 800, maximized: 'yes' }).maximized).toBe(
      false,
    );
  });
});

describe('parseWindowStateJson / serializeWindowState', () => {
  it('degrades to the default on unparseable JSON', () => {
    expect(parseWindowStateJson('{not json')).toEqual(DEFAULT_WINDOW_STATE);
  });

  it('round-trips through text', () => {
    const state = { width: 1440, height: 900, maximized: true };
    expect(parseWindowStateJson(serializeWindowState(state))).toEqual(state);
  });
});

describe('readWindowState / writeWindowState', () => {
  it('returns the default when the file does not exist', () => {
    const filePath = path.join(createScratchRoot(), 'window-state.json');
    expect(readWindowState(filePath)).toEqual(DEFAULT_WINDOW_STATE);
  });

  it('returns the default when the file is corrupt', () => {
    const filePath = path.join(createScratchRoot(), 'window-state.json');
    writeFileSync(filePath, 'not json at all', 'utf8');
    expect(readWindowState(filePath)).toEqual(DEFAULT_WINDOW_STATE);
  });

  it('round-trips a written state', () => {
    const filePath = path.join(createScratchRoot(), 'window-state.json');
    writeWindowState(filePath, { width: 1024, height: 768, maximized: true });
    expect(readWindowState(filePath)).toEqual({ width: 1024, height: 768, maximized: true });
  });

  it('creates any missing parent directory', () => {
    const filePath = path.join(createScratchRoot(), 'nested', 'deeper', 'window-state.json');
    writeWindowState(filePath, { width: 1024, height: 768, maximized: false });
    expect(readFileSync(filePath, 'utf8')).toContain('"width": 1024');
  });

  it('leaves no temp files behind after a successful write', () => {
    const dir = createScratchRoot();
    const filePath = path.join(dir, 'window-state.json');
    writeWindowState(filePath, { width: 1024, height: 768, maximized: false });

    // Only the target file remains: the temp file was renamed onto it, not copied.
    expect(readdirSync(dir)).toEqual(['window-state.json']);
  });
});

describe('fitWindowStateToWorkArea', () => {
  it('clamps a size larger than the display', () => {
    expect(
      fitWindowStateToWorkArea(
        { width: 3840, height: 2160, maximized: false },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ width: 1920, height: 1080, maximized: false });
  });

  it('keeps a size that fits, including the maximized flag', () => {
    expect(
      fitWindowStateToWorkArea(
        { width: 1200, height: 700, maximized: true },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ width: 1200, height: 700, maximized: true });
  });

  it('never clamps below the usable minimum even on a tiny display', () => {
    expect(fitWindowStateToWorkArea(DEFAULT_WINDOW_STATE, { width: 320, height: 240 })).toEqual({
      width: 640,
      height: 480,
      maximized: false,
    });
  });
});

describe('attachWindowStatePersistence', () => {
  it('debounces a resize into a single write', () => {
    vi.useFakeTimers();
    const filePath = path.join(createScratchRoot(), 'window-state.json');
    const window = createFakeWindow({ width: 900, height: 700, maximized: false });
    const persistence = attachWindowStatePersistence(window, filePath);

    window.bounds = { width: 1000, height: 800 };
    window.emit('resize');
    window.bounds = { width: 1100, height: 820 };
    window.emit('resize');
    vi.advanceTimersByTime(399);
    expect(readWindowState(filePath)).toEqual(DEFAULT_WINDOW_STATE);

    vi.advanceTimersByTime(1);
    expect(readWindowState(filePath)).toEqual({ width: 1100, height: 820, maximized: false });
    persistence.dispose();
  });

  it('records the maximized flag on maximize/unmaximize', () => {
    vi.useFakeTimers();
    const filePath = path.join(createScratchRoot(), 'window-state.json');
    const window = createFakeWindow({ width: 900, height: 700, maximized: false });
    const persistence = attachWindowStatePersistence(window, filePath);

    window.maximized = true;
    window.emit('maximize');
    vi.advanceTimersByTime(400);
    expect(readWindowState(filePath).maximized).toBe(true);

    window.maximized = false;
    window.emit('unmaximize');
    vi.advanceTimersByTime(400);
    expect(readWindowState(filePath).maximized).toBe(false);
    persistence.dispose();
  });

  it('writes immediately on close and cancels the pending debounce', () => {
    vi.useFakeTimers();
    const filePath = path.join(createScratchRoot(), 'window-state.json');
    const window = createFakeWindow({ width: 900, height: 700, maximized: false });
    const persistence = attachWindowStatePersistence(window, filePath);

    window.bounds = { width: 1234, height: 567 };
    window.emit('resize');
    window.emit('close');
    expect(readWindowState(filePath)).toEqual({ width: 1234, height: 567, maximized: false });

    // Advancing past the debounce must not write again over the close value.
    window.bounds = { width: 1, height: 1 };
    vi.advanceTimersByTime(1000);
    expect(readWindowState(filePath)).toEqual({ width: 1234, height: 567, maximized: false });
    persistence.dispose();
  });

  it('drops a pending debounced save when disposed', () => {
    vi.useFakeTimers();
    const filePath = path.join(createScratchRoot(), 'window-state.json');
    const window = createFakeWindow({ width: 900, height: 700, maximized: false });
    const persistence = attachWindowStatePersistence(window, filePath);

    persistence.saveNow();
    expect(readWindowState(filePath)).toEqual({ width: 900, height: 700, maximized: false });

    window.bounds = { width: 1200, height: 900 };
    window.emit('resize');
    persistence.dispose();
    vi.advanceTimersByTime(1000);
    expect(readWindowState(filePath)).toEqual({ width: 900, height: 700, maximized: false });
  });
});
