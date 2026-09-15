import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMainSplitView,
  type MainSplitView,
} from '../../../src/renderer/src/shell/mainSplitView';

/**
 * `mainSplitView.ts`'s own responsibilities only - not `sp-split-view`'s
 * dragging/clamping/keyboard internals, which are the upstream package's own
 * tested behaviour. What this wrapper adds, and what is worth pinning here:
 *
 *  - fraction<->px conversion on `relayout()`;
 *  - that `persist()` is called on a settled pointer-drag or keypress, but
 *    never merely because the component's `change` event fired (which also
 *    fires on every intermediate drag tick and on our own resize-driven
 *    `relayout()` writes);
 *  - that persistence only reacts to events whose real origin is the
 *    component's own internal splitter, distinguished (as in the real,
 *    open-shadow-DOM component) by `event.target === element` - never to
 *    events bubbling up from our own slotted pane content;
 *  - that the drag only toggles the whole-window `daisy-pane-resizing`
 *    cursor/selection class for its duration. The native AEM view is
 *    deliberately NOT suspended by a drag (splitter-layout.spec.ts), so
 *    there is no suspend hook to assert here.
 *
 * Since the real `@spectrum-web-components/split-view` custom element is not
 * registered in this jsdom instance, `element` behaves as a plain
 * (unupgraded) element: `.splitterPos`/`.primarySize` are ordinary JS
 * properties with no side effects, so the component's own `change` dispatch
 * is simulated explicitly wherever a test needs it.
 */

let dom: JSDOM;
const previousDocument = Reflect.get(globalThis, 'document') as unknown;

const WIDTH_PX = 1000;

interface Harness {
  readonly splitView: MainSplitView;
  readonly persist: ReturnType<typeof vi.fn>;
}

function setWidthPx(element: HTMLElement, widthPx: number): void {
  Reflect.set(element, 'getBoundingClientRect', () => ({ width: widthPx }));
}

/** Reads the `primarySize` property the way the real `sp-split-view` element exposes it. */
function primarySizeOf(element: HTMLElement): string | undefined {
  return Reflect.get(element, 'primarySize') as string | undefined;
}

function build(initialFraction = 2 / 3): Harness {
  const persist = vi.fn();

  const splitView = createMainSplitView(initialFraction, { persist });
  setWidthPx(splitView.element, WIDTH_PX);
  dom.window.document.body.append(splitView.element);

  return { splitView, persist };
}

/** Simulates the component setting `splitterPos` and dispatching its own `change` event. */
function simulateSplitterMove(element: HTMLElement, splitterPos: number): void {
  Reflect.set(element, 'splitterPos', splitterPos);
  element.dispatchEvent(new dom.window.Event('change', { bubbles: true, composed: true }));
}

function pointer(
  target: HTMLElement,
  type: 'pointerdown' | 'pointerup' | 'pointercancel',
  pointerId = 1,
): void {
  const PointerEventCtor = Reflect.get(dom.window, 'PointerEvent') as typeof PointerEvent;
  target.dispatchEvent(new PointerEventCtor(type, { bubbles: true, pointerId }));
}

function keydown(target: HTMLElement, key = 'ArrowLeft'): void {
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
}

beforeEach(() => {
  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
});

describe('createMainSplitView', () => {
  it("builds a resizable sp-split-view with the app's min widths and an accessible label", () => {
    const { splitView } = build();
    const { element } = splitView;
    expect(element.tagName.toLowerCase()).toBe('sp-split-view');
    expect(element.hasAttribute('resizable')).toBe(true);
    expect(element.getAttribute('primary-min')).toBe('320');
    expect(element.getAttribute('secondary-min')).toBe('280');
    expect(element.getAttribute('label')).toBe('Resize the browser and chat panes');
    expect(element.getAttribute('data-testid')).toBe('pane-splitter');
  });

  it('derives the initial pixel split from the restored fraction on relayout', () => {
    const { splitView } = build(0.4);
    splitView.relayout();
    expect(primarySizeOf(splitView.element)).toBe('400px');
  });

  it('never writes a pixel size when the element has no measurable width yet', () => {
    const { splitView } = build(0.4);
    setWidthPx(splitView.element, 0);
    splitView.relayout();
    expect(primarySizeOf(splitView.element)).toBeUndefined();
  });

  it('keeps the whole-window resizing cursor/selection class for exactly the duration of a drag on the internal splitter', () => {
    const { splitView } = build();
    // Dispatched directly on the host: mirrors how a real, open-shadow-DOM
    // `sp-split-view` retargets an event whose origin is its own internal
    // splitter to report `event.target === element`.
    pointer(splitView.element, 'pointerdown');
    expect(dom.window.document.body.classList.contains('daisy-pane-resizing')).toBe(true);

    pointer(splitView.element, 'pointerup');
    expect(dom.window.document.body.classList.contains('daisy-pane-resizing')).toBe(false);
  });

  it('ignores a pointerdown/pointerup originating from slotted pane content', () => {
    const { splitView, persist } = build();
    const paneContent = dom.window.document.createElement('div');
    splitView.element.append(paneContent);

    pointer(paneContent, 'pointerdown');
    pointer(paneContent, 'pointerup');
    expect(dom.window.document.body.classList.contains('daisy-pane-resizing')).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it('persists once the drag settles, never merely because change fired mid-drag', () => {
    const { splitView, persist } = build();
    pointer(splitView.element, 'pointerdown');
    simulateSplitterMove(splitView.element, 600);
    simulateSplitterMove(splitView.element, 500);
    expect(persist).not.toHaveBeenCalled();

    pointer(splitView.element, 'pointerup');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.lastCall?.[0]).toBeCloseTo(0.5, 10);
  });

  it('persists a drag that is cancelled rather than released', () => {
    const { splitView, persist } = build();
    pointer(splitView.element, 'pointerdown');
    pointer(splitView.element, 'pointercancel');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('persists on a keydown that reaches the internal splitter, reflecting the settled position', () => {
    const { splitView, persist } = build();
    // The component's own keydown handling runs first (it lives on the
    // actual origin of the event) and dispatches `change` synchronously
    // before this listener's bubble-phase turn, so simulate that ordering.
    simulateSplitterMove(splitView.element, 480);
    keydown(splitView.element, 'ArrowLeft');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.lastCall?.[0]).toBeCloseTo(0.48, 10);
  });

  it('ignores a keydown originating from slotted pane content', () => {
    const { splitView, persist } = build();
    const paneContent = dom.window.document.createElement('input');
    splitView.element.append(paneContent);

    keydown(paneContent, 'ArrowLeft');
    expect(persist).not.toHaveBeenCalled();
  });

  it('stops responding to input once disposed', () => {
    const { splitView, persist } = build();
    splitView.dispose();
    pointer(splitView.element, 'pointerdown');
    pointer(splitView.element, 'pointerup');
    keydown(splitView.element, 'ArrowLeft');
    expect(persist).not.toHaveBeenCalled();
  });
});
