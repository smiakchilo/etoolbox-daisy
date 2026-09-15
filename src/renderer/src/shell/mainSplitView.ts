import { MIN_BROWSER_PANE_PX, MIN_CHAT_PANE_PX } from './splitLayout';

/**
 * The subset of `sp-split-view`'s element API this wrapper reads/writes.
 * Kept as a narrow local interface rather than importing the package's own
 * types, since only these two reactive properties are used here.
 */
interface SplitViewElement extends HTMLElement {
  primarySize: string;
  readonly splitterPos: number | undefined;
}

export interface MainSplitViewHost {
  /** Records a settled fraction, so it survives a restart. Never called per pointermove/resize. */
  persist(fraction: number): void;
}

export interface MainSplitView {
  readonly element: HTMLElement;
  /** Re-derives the pixel split from the current fraction, e.g. after the window resized. */
  relayout(): void;
  dispose(): void;
}

/**
 * Wraps `<sp-split-view>` as the main window's draggable boundary between
 * the browser pane and the chat pane, replacing the previous hand-built
 * splitter bar + CSS grid track.
 *
 * The component owns dragging, keyboard stepping, ARIA and min/max clamping
 * itself; this wrapper only bridges the one thing it cannot know about:
 * persisting a *fraction* of the resizable width (so a resized window keeps
 * proportions rather than a stale pixel width - `sp-split-view` does not
 * rescale `primary-size` on its own when its container resizes).
 *
 * The native AEM view needs no suspending for a drag, and this wrapper
 * deliberately does none: the splitter's pointer capture spans the whole
 * window at the OS level, so the composited WebContentsView simply cannot
 * swallow a drag over its own rectangle. A real leftward drag against the
 * built app proves it (splitter-layout.spec.ts).
 *
 * Drag detection relies on standard shadow-DOM event retargeting rather than
 * any of the component's internal structure: an event whose real origin is
 * inside the component's own (open) shadow tree - i.e. the internal splitter
 * - is reported to a listener on the host element with `event.target` equal
 * to the host itself. An event originating in one of our own slotted panes
 * keeps its real target. That is what `event.target === element` below
 * distinguishes.
 */
export function createMainSplitView(
  initialFraction: number,
  host: MainSplitViewHost,
): MainSplitView {
  const element = document.createElement('sp-split-view') as SplitViewElement;
  element.setAttribute('resizable', '');
  element.setAttribute('primary-min', String(MIN_BROWSER_PANE_PX));
  element.setAttribute('secondary-min', String(MIN_CHAT_PANE_PX));
  element.setAttribute('label', 'Resize the browser and chat panes');
  element.setAttribute('data-testid', 'pane-splitter');

  let currentFraction = initialFraction;

  /**
   * Re-derives `currentFraction` from the component's own reactive state.
   * Runs on every settle *and* on every intermediate drag/resize tick - it
   * only caches a value, it never persists one, so it is safe to call this
   * often.
   */
  function onChange(): void {
    const widthPx = element.getBoundingClientRect().width;
    const splitterPos = element.splitterPos;
    if (widthPx <= 0 || splitterPos === undefined) return;
    currentFraction = Math.min(Math.max(splitterPos / widthPx, 0), 1);
  }

  let activePointerId: number | undefined;

  function onPointerDown(event: PointerEvent): void {
    if (event.target !== element || activePointerId !== undefined) return;
    activePointerId = event.pointerId;
    document.body.classList.add('daisy-pane-resizing');
  }

  function endDrag(event: PointerEvent): void {
    if (event.target !== element || activePointerId !== event.pointerId) return;
    activePointerId = undefined;
    document.body.classList.remove('daisy-pane-resizing');
    host.persist(currentFraction);
  }

  /**
   * Keyboard stepping is handled entirely inside the component; by the time
   * this (bubble-phase) listener runs, its own keydown handler has already
   * run and dispatched the synchronous `change` event that updated
   * `currentFraction`, so persisting here reflects the settled value.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.target !== element) return;
    host.persist(currentFraction);
  }

  element.addEventListener('change', onChange);
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointerup', endDrag);
  element.addEventListener('pointercancel', endDrag);
  element.addEventListener('keydown', onKeyDown);

  return {
    element,
    relayout(): void {
      const widthPx = element.getBoundingClientRect().width;
      if (widthPx <= 0) return;
      element.primarySize = `${Math.round(currentFraction * widthPx)}px`;
    },
    dispose(): void {
      element.removeEventListener('change', onChange);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointerup', endDrag);
      element.removeEventListener('pointercancel', endDrag);
      element.removeEventListener('keydown', onKeyDown);
    },
  };
}
