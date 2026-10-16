import type { WebContents } from 'electron';

/**
 * Per-`WebContents` zoom, driven by the application-wide shortcut layer
 * (`shortcuts.ts`): the numpad's `+` / `-` (`Ctrl+NumpadAdd` /
 * `Ctrl+NumpadSubtract`) step the level, and `Ctrl+0` returns it to 100%.
 *
 * The AEM view and the app shell are separate `WebContents`, so "zoom the
 * focused pane" falls out of applying the change to whichever view the keystroke
 * landed on - the AEM page when its view has focus, the shell document otherwise
 * (see `attachShortcutHandling` and `browserController.ts`). Ctrl+wheel is
 * deliberately not a zoom gesture (Electron only emits `zoom-changed` for it, which
 * nothing handles; both views are in 'isolated' zoom mode, never 'manual', which
 * reports a new factor without zooming the page).
 *
 * The level is Electron's own unit (`scale := 1.2 ^ level`), so a step is a
 * ±20% change and the bounds below span roughly 40%-250%. The app shell's level
 * is remembered across launches (`windowState.ts`); the AEM page starts at 100%
 * on every launch, and `Ctrl+0` returns a view to it.
 */
export type ZoomDirection = 'in' | 'out' | 'reset';

/** Inclusive bounds on the Electron zoom level; `1.2 ^ ±5` is ~0.40x to ~2.49x. */
export const ZOOM_LEVEL_MIN = -5;
export const ZOOM_LEVEL_MAX = 5;

/** The level a step from `current` should land on, clamped to {@link ZOOM_LEVEL_MIN}/{@link ZOOM_LEVEL_MAX}. */
export function nextZoomLevel(current: number, direction: ZoomDirection): number {
  if (direction === 'reset') return 0;
  const step = direction === 'in' ? 1 : -1;
  return Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, current + step));
}

/**
 * Applies one zoom step to `target`. A destroyed view is left alone: the app's
 * own zoom keys are bound on both views, and a keystroke can arrive in the last
 * moments before one is torn down.
 */
export function applyZoom(target: WebContents, direction: ZoomDirection): void {
  if (target.isDestroyed()) return;
  target.setZoomLevel(nextZoomLevel(target.getZoomLevel(), direction));
}
