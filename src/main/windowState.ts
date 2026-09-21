import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * Persistence for the main window's geometry (width, height, maximized-ness).
 *
 * This deliberately does *not* go through `AppSettings`/`settings:*` IPC: the
 * settings document is a step-03 contract whose write path belongs to the
 * Settings panel, while a window resize is renderer-external view state that
 * changes constantly. Folding it into `settings.json` would mean rewriting a
 * contract document (and racing the Settings panel's own atomic writes) on
 * every resize. A tiny dedicated file, owned by the main process that already
 * owns the window, has exactly the right lifetime and no contract impact.
 *
 * Position (`x`/`y`) is deliberately *not* stored: only size and the maximized
 * flag are restored, and the OS places the window. The stored size is clamped
 * to the primary display's work area before use, so a window remembered on a
 * larger monitor can never reopen larger than the current screen.
 *
 * Every filesystem access is best-effort: a failure to remember a window size
 * must never take the application down with it, and a missing/corrupt file
 * simply yields {@link DEFAULT_WINDOW_STATE}.
 */

export interface WindowState {
  readonly width: number;
  readonly height: number;
  readonly maximized: boolean;
}

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The window geometry used by every run that has no usable stored state -
 * matches the previous hard-coded `createMainWindow` dimensions, so a first
 * launch (or a corrupt state file) behaves exactly as before this feature.
 */
export const DEFAULT_WINDOW_STATE: WindowState = Object.freeze({
  width: 1280,
  height: 800,
  maximized: false,
});

const MIN_WINDOW_WIDTH = 640;
const MIN_WINDOW_HEIGHT = 480;
/** Guards against a hand-edited file asking for an absurd native window. */
const MAX_WINDOW_DIMENSION = 100_000;

function sanitizeDimension(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < minimum || rounded > MAX_WINDOW_DIMENSION) return fallback;
  return rounded;
}

/**
 * Coerces an untrusted value (a parsed JSON document, a hand-edited file) into
 * a usable {@link WindowState}. Every field falls back independently, so one
 * bad dimension does not discard the other or the maximized flag.
 */
export function normalizeWindowState(raw: unknown): WindowState {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_WINDOW_STATE;
  const record = raw as Record<string, unknown>;
  return {
    width: sanitizeDimension(record['width'], DEFAULT_WINDOW_STATE.width, MIN_WINDOW_WIDTH),
    height: sanitizeDimension(record['height'], DEFAULT_WINDOW_STATE.height, MIN_WINDOW_HEIGHT),
    maximized:
      typeof record['maximized'] === 'boolean'
        ? record['maximized']
        : DEFAULT_WINDOW_STATE.maximized,
  };
}

/** Parses stored JSON text, degrading to the default state on any unparseable input. */
export function parseWindowStateJson(text: string): WindowState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
  return normalizeWindowState(parsed);
}

export function serializeWindowState(state: WindowState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** Reads the stored state, or {@link DEFAULT_WINDOW_STATE} when it is missing or unusable. */
export function readWindowState(filePath: string): WindowState {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
  return parseWindowStateJson(text);
}

/**
 * Writes `state` atomically (temp file in the same directory, then rename), so
 * a crash mid-write leaves either the previous complete file or the new one -
 * never a truncated file. Failures are swallowed: this is view state, and a
 * read of a truncated file already degrades to the default.
 */
export function writeWindowState(filePath: string, state: WindowState): void {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${randomBytes(8).toString('hex')}`,
  );
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(tempPath, serializeWindowState(state), 'utf8');
    renameSync(tempPath, filePath);
  } catch {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Nothing further to do - the previous file (if any) is untouched.
    }
  }
}

/**
 * Clamps a stored size into the given work area, so a window remembered on a
 * larger display reopens fully on screen. The minimums win over a work area
 * smaller than them, since a window below its own minimum is worse than one
 * slightly larger than the screen.
 */
export function fitWindowStateToWorkArea(state: WindowState, workArea: WindowSize): WindowState {
  return {
    width: Math.min(state.width, Math.max(MIN_WINDOW_WIDTH, Math.round(workArea.width))),
    height: Math.min(state.height, Math.max(MIN_WINDOW_HEIGHT, Math.round(workArea.height))),
    maximized: state.maximized,
  };
}

/**
 * The narrow slice of `BrowserWindow` this module needs. Declared structurally
 * so the persistence logic below is unit-testable with a plain fake, and so a
 * real `BrowserWindow` satisfies it without a cast.
 */
export interface WindowStateSource {
  getNormalBounds(): WindowSize;
  isMaximized(): boolean;
  on(event: 'resize' | 'maximize' | 'unmaximize' | 'close', listener: () => void): unknown;
}

export interface WindowStatePersistence {
  /** Persists the current geometry immediately (used by tests and by callers that must not debounce). */
  saveNow(): void;
  /** Clears any debounced save that has not fired yet. */
  dispose(): void;
}

const SAVE_DEBOUNCE_MS = 400;

/**
 * Persists a window's geometry. Resizes are debounced (a drag fires a stream of
 * `resize` events, and each save is a disk write); `close` saves synchronously
 * and cancels any pending debounce, so a window closed mid-resize still records
 * its final size and no timer survives the window.
 */
export function attachWindowStatePersistence(
  source: WindowStateSource,
  filePath: string,
): WindowStatePersistence {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function capture(): WindowState {
    const bounds = source.getNormalBounds();
    return normalizeWindowState({
      width: bounds.width,
      height: bounds.height,
      maximized: source.isMaximized(),
    });
  }

  function clearPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function saveNow(): void {
    clearPending();
    writeWindowState(filePath, capture());
  }

  function scheduleSave(): void {
    clearPending();
    timer = setTimeout(() => {
      timer = undefined;
      writeWindowState(filePath, capture());
    }, SAVE_DEBOUNCE_MS);
  }

  source.on('resize', scheduleSave);
  source.on('maximize', scheduleSave);
  source.on('unmaximize', scheduleSave);
  source.on('close', saveNow);

  return { saveNow, dispose: clearPending };
}
