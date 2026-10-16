import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFindBar,
  LIVE_SEARCH_DEBOUNCE_MS,
  type FindBar,
} from '../../../src/renderer/src/shell/findBar';
import type { FindController, FindState } from '../../../src/renderer/src/shell/findController';
import { installJsdomGlobals } from '../../support/jsdomGlobals';
import { byTestId } from '../../support/selectors';

/**
 * One pane's find bar (`shell/findBar.ts`). Two instances exist in the app - one
 * per pane - but they are the same component, so its keyboard handling, its
 * debounce and the match-count render are exercised once here against a fake
 * controller. What the controller *does* (native find, or the transcript
 * search) lives in its own tests.
 */

let dom: JSDOM;
let restoreGlobals: () => void;
let bars: FindBar[];

interface FakeController {
  readonly controller: FindController;
  readonly setQuery: ReturnType<typeof vi.fn>;
  readonly step: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly refresh: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly emit: (state: FindState) => void;
}

function makeFakeController(): FakeController {
  const listeners = new Set<(state: FindState) => void>();
  const setQuery = vi.fn();
  const step = vi.fn();
  const stop = vi.fn();
  const refresh = vi.fn();
  const dispose = vi.fn();
  return {
    controller: {
      setQuery,
      step,
      stop,
      refresh,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      dispose,
    },
    setQuery,
    step,
    stop,
    refresh,
    dispose,
    emit: (state) => {
      for (const listener of listeners) listener(state);
    },
  };
}

beforeEach(() => {
  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
  bars = [];
});

afterEach(() => {
  for (const bar of bars) bar.dispose();
  bars = [];
  vi.useRealTimers();
  restoreGlobals();
});

function build(fake: FakeController, testIdPrefix = 'browser-find'): FindBar {
  const bar = createFindBar({ testIdPrefix, controller: fake.controller });
  bars.push(bar);
  return bar;
}

function fieldOf(bar: FindBar): HTMLElement & { value: string } {
  const field = bar.element.querySelector<HTMLElement>('sp-textfield');
  if (field === null) throw new Error('the find field is missing');
  return field as HTMLElement & { value: string };
}

function type(bar: FindBar, value: string): void {
  const field = fieldOf(bar);
  field.value = value;
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

function press(bar: FindBar, key: string, shiftKey = false): void {
  fieldOf(bar).dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
  );
}

describe('createFindBar', () => {
  it('starts hidden and does not search until opened', () => {
    const fake = makeFakeController();
    const bar = build(fake);

    expect(bar.isOpen).toBe(false);
    expect(bar.element.hidden).toBe(true);
    expect(fake.setQuery).not.toHaveBeenCalled();
  });

  it('opens by revealing the bar and focusing its field', () => {
    const fake = makeFakeController();
    const bar = build(fake);
    const focus = vi.fn();
    fieldOf(bar).focus = focus;

    bar.open();

    expect(bar.isOpen).toBe(true);
    expect(bar.element.hidden).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('searches once typing pauses, not on every keystroke', () => {
    vi.useFakeTimers();
    const fake = makeFakeController();
    const bar = build(fake);
    bar.open();

    type(bar, 'needle');
    expect(fake.setQuery).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LIVE_SEARCH_DEBOUNCE_MS);
    expect(fake.setQuery).toHaveBeenCalledWith('needle');
  });

  it('restarts the wait on each keystroke', () => {
    vi.useFakeTimers();
    const fake = makeFakeController();
    const bar = build(fake);
    bar.open();

    type(bar, 'nee');
    vi.advanceTimersByTime(LIVE_SEARCH_DEBOUNCE_MS - 10);
    type(bar, 'need');
    vi.advanceTimersByTime(LIVE_SEARCH_DEBOUNCE_MS - 10);
    expect(fake.setQuery).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10);
    expect(fake.setQuery).toHaveBeenCalledTimes(1);
    expect(fake.setQuery).toHaveBeenLastCalledWith('need');
  });

  it('flushes a pending query on Enter (showing the first match, not the second)', () => {
    vi.useFakeTimers();
    const fake = makeFakeController();
    const bar = build(fake);
    bar.open();
    type(bar, 'needle');

    press(bar, 'Enter');

    expect(fake.setQuery).toHaveBeenCalledWith('needle');
    expect(fake.step).not.toHaveBeenCalled();
    // The pending wait was cancelled, so it does not run again.
    vi.advanceTimersByTime(LIVE_SEARCH_DEBOUNCE_MS * 4);
    expect(fake.setQuery).toHaveBeenCalledTimes(1);
  });

  it('steps forward on Enter and backward on Shift+Enter once a query is applied', () => {
    vi.useFakeTimers();
    const fake = makeFakeController();
    const bar = build(fake);
    bar.open();
    type(bar, 'needle');
    vi.advanceTimersByTime(LIVE_SEARCH_DEBOUNCE_MS);

    press(bar, 'Enter');
    expect(fake.step).toHaveBeenLastCalledWith(true);

    press(bar, 'Enter', true);
    expect(fake.step).toHaveBeenLastCalledWith(false);
  });

  it('steps with the prev/next controls', () => {
    vi.useFakeTimers();
    const fake = makeFakeController();
    const bar = build(fake);
    bar.open();
    type(bar, 'needle');
    vi.advanceTimersByTime(LIVE_SEARCH_DEBOUNCE_MS);

    bar.element.querySelector<HTMLElement>(byTestId('browser-find-next'))?.click();
    expect(fake.step).toHaveBeenLastCalledWith(true);

    bar.element.querySelector<HTMLElement>(byTestId('browser-find-prev'))?.click();
    expect(fake.step).toHaveBeenLastCalledWith(false);
  });

  it('applies a still-pending query before stepping, rather than stepping past it', () => {
    vi.useFakeTimers();
    const fake = makeFakeController();
    const bar = build(fake);
    bar.open();
    type(bar, 'needle');

    bar.element.querySelector<HTMLElement>(byTestId('browser-find-next'))?.click();

    expect(fake.setQuery).toHaveBeenLastCalledWith('needle');
    expect(fake.step).not.toHaveBeenCalled();
  });

  it('clears the search when the query is emptied', () => {
    const fake = makeFakeController();
    const bar = build(fake);
    bar.open();
    type(bar, 'needle');

    type(bar, '');

    expect(fake.setQuery).toHaveBeenLastCalledWith('');
  });

  it('closes on Escape and stops the search', () => {
    const fake = makeFakeController();
    const bar = build(fake);
    bar.open();
    type(bar, 'needle');

    press(bar, 'Escape');

    expect(bar.isOpen).toBe(false);
    expect(bar.element.hidden).toBe(true);
    expect(fake.stop).toHaveBeenCalled();
  });

  it('closes from the close control and stops the search', () => {
    const fake = makeFakeController();
    const bar = build(fake);
    bar.open();

    bar.element.querySelector<HTMLElement>(byTestId('browser-find-close'))?.click();

    expect(bar.isOpen).toBe(false);
    expect(fake.stop).toHaveBeenCalled();
  });

  it('renders the match count from the controller state', () => {
    const fake = makeFakeController();
    const bar = build(fake, 'chat-find');
    bar.open();
    type(bar, 'needle');
    const count = bar.element.querySelector<HTMLElement>(byTestId('chat-find-count'));

    fake.emit({ matches: 5, activeMatchOrdinal: 2 });
    expect(count?.textContent).toBe('2/5');
  });

  it('refreshes the controller only while open', () => {
    const fake = makeFakeController();
    const bar = build(fake);

    bar.refresh();
    expect(fake.refresh).not.toHaveBeenCalled();

    bar.open();
    bar.refresh();
    expect(fake.refresh).toHaveBeenCalledTimes(1);
  });
});
