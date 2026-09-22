import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BANNER_ROW_LOADING_CLASS,
  BANNER_TRANSITION_DURATION_MS,
} from '../../../../src/renderer/src/lib/alertBanner';
import {
  createSaveReporter,
  createStatusBanner,
  reportSave,
  STATUS_AUTO_CLEAR_MS,
  type SaveOutcome,
  type StatusBanner,
  type StatusBannerAction,
} from '../../../../src/renderer/src/settings/statusBanner';

/**
 * The Settings panel's one status slot (statusBanner.ts). Rules under test,
 * matching the browser banner's contract where the two share behaviour:
 *
 * - exactly one message at a time, priority prompt > error > status; equal
 *   kinds replace equal kinds.
 * - `showStatus` is transient (auto-clears after `STATUS_AUTO_CLEAR_MS`),
 *   carries no close control, and never displaces an error or a prompt.
 * - `showError` is sticky and dismissible; it never displaces a prompt.
 * - `showPrompt` is sticky, dismissible, replaces anything, and renders its
 *   one `sp-action-button` (the browser banner's action-button idiom, not an
 *   accent `sp-button`) which invokes `onActivate`.
 * - the banner's own close control dispatches a cancelable `close` event that
 *   is prevented and turned into `hide()`.
 * - closing collapses: the row keeps `open` under the shared
 *   `banner-row--closing` class for `BANNER_TRANSITION_DURATION_MS` before the
 *   DOM is torn down, and `isPromptShowing` clears immediately; a message
 *   shown mid-collapse cancels the collapse and appears right away.
 * - `createSaveReporter` + `reportSave` collapse concurrent saves into one
 *   "Saving..." -> one outcome, first failure wins, and the reporter settles
 *   before the caller's own continuation (so a drained batch is announced
 *   before a reload re-renders the sections).
 */

let dom: JSDOM;

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;

beforeEach(() => {
  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

function dismiss(banner: StatusBanner): void {
  banner.element.dispatchEvent(new dom.window.Event('close', { bubbles: true, composed: true }));
}

describe('createStatusBanner single slot', () => {
  it('carries a caller-supplied surface class (the chat status row) and defaults to the Settings one', () => {
    const settings = createStatusBanner();
    expect(settings.element.classList.contains('settings-banner')).toBe(true);

    const chat = createStatusBanner({ surfaceClassName: 'chat-status-banner' });
    expect(chat.element.classList.contains('chat-status-banner')).toBe(true);
    expect(chat.element.classList.contains('settings-banner')).toBe(false);
    // The shared base class is what actually styles it; the surface class only
    // disambiguates the row (e.g. for a Playwright locator while both are open).
    expect(chat.element.classList.contains('banner-row')).toBe(true);
  });

  it('shows a transient status without a close control and auto-clears it', () => {
    vi.useFakeTimers();
    try {
      const banner = createStatusBanner();
      expect(banner.element.hasAttribute('open')).toBe(false);

      banner.showStatus('Saving\u2026');
      expect(banner.element.hasAttribute('open')).toBe(true);
      expect(banner.element.textContent).toBe('Saving\u2026');
      expect(banner.element.hasAttribute('dismissible')).toBe(false);

      // The timeout clears the slot, then the row collapses before the DOM
      // teardown finishes.
      vi.advanceTimersByTime(STATUS_AUTO_CLEAR_MS);
      expect(banner.element.classList.contains('banner-row--closing')).toBe(true);
      vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
      expect(banner.element.hasAttribute('open')).toBe(false);
      expect(banner.element.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an error row supersedes a status, is sticky and dismissible, and the close control hides it', () => {
    vi.useFakeTimers();
    try {
      const banner = createStatusBanner();
      banner.showStatus('Saving\u2026');
      banner.showError('Save failed');
      expect(banner.element.textContent).toBe('Save failed');
      expect(banner.element.hasAttribute('dismissible')).toBe(true);

      // Sticky: advancing time never clears an error.
      vi.advanceTimersByTime(60_000);
      expect(banner.element.hasAttribute('open')).toBe(true);

      // The close control starts a collapse: `isPromptShowing` clears at once,
      // the row stays under the closing class for the animation, then the DOM
      // is torn down.
      dismiss(banner);
      expect(banner.element.classList.contains('banner-row--closing')).toBe(true);
      vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
      expect(banner.element.hasAttribute('open')).toBe(false);
      expect(banner.element.textContent).toBe('');
      expect(banner.element.hasAttribute('dismissible')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a status never displaces an error or a prompt', () => {
    const banner = createStatusBanner();
    banner.showError('Save failed');
    banner.showStatus('Saving\u2026');
    expect(banner.element.textContent).toBe('Save failed');

    const action: StatusBannerAction = { label: 'Apply', onActivate: () => undefined };
    banner.showPrompt('Changing this server\u2019s address keeps its chats.', action);
    banner.showError('Another failure');
    expect(banner.element.textContent).toContain('Changing this server');
  });

  it('equal kinds replace equal kinds', () => {
    const banner = createStatusBanner();
    banner.showStatus('one');
    banner.showStatus('two');
    expect(banner.element.textContent).toBe('two');

    banner.clear();
    banner.showError('err one');
    banner.showError('err two');
    expect(banner.element.textContent).toBe('err two');
  });

  it('a prompt renders its single action button and invoking it fires onActivate', () => {
    const onActivate = vi.fn();
    const banner = createStatusBanner();
    banner.showPrompt('Click Apply again to confirm.', { label: 'Apply', onActivate });

    expect(banner.isPromptShowing()).toBe(true);
    expect(banner.element.textContent).toContain('Click Apply again to confirm.');
    const button = banner.element.querySelector('sp-action-button');
    expect(button?.textContent).toBe('Apply');
    // Banner actions are always size "s" (createBannerActionButton).
    expect(button?.getAttribute('size')).toBe('s');
    expect(banner.element.hasAttribute('dismissible')).toBe(true);

    (button as HTMLElement).click();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('a prompt is superseded by a newer prompt, and the old action never fires', () => {
    const firstAction = vi.fn();
    const secondAction = vi.fn();
    const banner = createStatusBanner();
    banner.showPrompt('First', { label: 'Apply', onActivate: firstAction });
    banner.showPrompt('Second', { label: 'Apply', onActivate: secondAction });

    expect(banner.isPromptShowing()).toBe(true);
    expect(banner.element.querySelector('.banner-row__copy')?.textContent).toBe('Second');
    banner.element
      .querySelector('sp-action-button')
      ?.dispatchEvent(new dom.window.MouseEvent('click'));
    expect(firstAction).not.toHaveBeenCalled();
    expect(secondAction).toHaveBeenCalledTimes(1);
  });

  it('the banner close control dismisses a prompt without activating it', () => {
    vi.useFakeTimers();
    try {
      const onActivate = vi.fn();
      const banner = createStatusBanner();
      banner.showPrompt('Confirm?', { label: 'Apply', onActivate });
      dismiss(banner);

      expect(onActivate).not.toHaveBeenCalled();
      expect(banner.isPromptShowing()).toBe(false);
      // The collapse is in flight: `open`/text stay until it completes.
      expect(banner.element.classList.contains('banner-row--closing')).toBe(true);
      vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
      expect(banner.element.hasAttribute('open')).toBe(false);
      expect(banner.element.textContent).toBe('');
      expect(banner.isPromptShowing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear() hides whatever is showing', () => {
    vi.useFakeTimers();
    try {
      const banner = createStatusBanner();
      banner.showStatus('Saving\u2026');
      banner.clear();
      expect(banner.element.classList.contains('banner-row--closing')).toBe(true);
      vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
      expect(banner.element.hasAttribute('open')).toBe(false);
      // The auto-clear timer was cancelled along with the row.
      vi.advanceTimersByTime(STATUS_AUTO_CLEAR_MS);
      expect(banner.element.hasAttribute('open')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a message shown mid-collapse cancels the collapse and appears immediately', () => {
    vi.useFakeTimers();
    try {
      const banner = createStatusBanner();
      banner.showError('Gone.');
      banner.clear();
      expect(banner.element.classList.contains('banner-row--closing')).toBe(true);

      banner.showError('Back.');
      expect(banner.element.classList.contains('banner-row--closing')).toBe(false);
      expect(banner.element.hasAttribute('open')).toBe(true);
      expect(banner.element.textContent).toBe('Back.');

      // No stale teardown is waiting: passing the animation duration never
      // clears the second row.
      vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
      expect(banner.element.hasAttribute('open')).toBe(true);
      expect(banner.element.textContent).toBe('Back.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a superseded collapse never tears down a later presentation (no orphaned timer)', () => {
    vi.useFakeTimers();
    try {
      const banner = createStatusBanner();
      banner.showStatus('Saving\u2026');
      // Two dismissals in a row: the second must not orphan the first's
      // collapse timer. An orphan fired later and emptied whatever row was on
      // screen by then - in the real app it tore a confirmation away while the
      // user was clicking its OK button.
      banner.clear();
      banner.clear();

      banner.showError('Back.');
      expect(banner.element.textContent).toBe('Back.');

      vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS * 3);
      expect(banner.element.hasAttribute('open')).toBe(true);
      expect(banner.element.textContent).toBe('Back.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-presenting the same prompt keeps the very same action button (no rebuild)', () => {
    const banner = createStatusBanner();
    const action: StatusBannerAction = { label: 'OK', onActivate: vi.fn() };
    banner.showPrompt('Confirm?', action);
    const button = banner.element.querySelector('sp-action-button');
    expect(button).not.toBeNull();

    // The auto-save re-affirms the same confirmation; it must not replace the
    // button, or a click in flight would land on a detached element.
    banner.showPrompt('Confirm?', action);
    expect(banner.element.querySelector('sp-action-button')).toBe(button);
  });

  it('dispose removes the banner element from the DOM', () => {
    const banner = createStatusBanner();
    document.body.append(banner.element);
    banner.dispose();
    expect(document.body.contains(banner.element)).toBe(false);
  });
});

describe('createStatusBanner standing floor', () => {
  it('shows standing content only while no presentation is active, and restores it after one clears', () => {
    const banner = createStatusBanner();
    banner.setStanding([document.createTextNode('Standing')]);
    expect(banner.element.hasAttribute('open')).toBe(true);
    expect(banner.element.textContent).toBe('Standing');
    // A standing condition is not an error to wave away.
    expect(banner.element.hasAttribute('dismissible')).toBe(false);

    // The later error takes the single row and suppresses the floor.
    banner.showError('Later');
    expect(banner.element.textContent).toBe('Later');
    expect(banner.element.hasAttribute('dismissible')).toBe(true);

    // Dismissing it returns to the floor - on the same element, never a second
    // banner stacked beneath it.
    dismiss(banner);
    expect(banner.element.textContent).toBe('Standing');
    expect(banner.element.hasAttribute('dismissible')).toBe(false);
  });

  it('a standing prompt never displaces a live error, and clearing it leaves the error alone', () => {
    const banner = createStatusBanner();
    banner.showError('Later');
    banner.setStanding([document.createTextNode('Floor')]);
    expect(banner.element.textContent).toBe('Later');

    banner.setStanding(null);
    expect(banner.element.textContent).toBe('Later');
  });

  it('re-asserting the same standing content does not rebuild the row', () => {
    const banner = createStatusBanner();
    const standing: readonly Node[] = [document.createTextNode('Floor')];
    banner.setStanding(standing);
    const child = banner.element.firstChild;

    banner.setStanding(standing);
    expect(banner.element.firstChild).toBe(child);
  });

  it('clear() drops the standing floor and closes the row', () => {
    vi.useFakeTimers();
    try {
      const banner = createStatusBanner();
      banner.setStanding([document.createTextNode('Floor')]);
      banner.clear();
      expect(banner.element.classList.contains('banner-row--closing')).toBe(true);
      vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
      expect(banner.element.hasAttribute('open')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearing the standing floor collapses the row', () => {
    vi.useFakeTimers();
    try {
      const banner = createStatusBanner();
      banner.setStanding([document.createTextNode('Floor')]);
      banner.setStanding(null);
      expect(banner.element.classList.contains('banner-row--closing')).toBe(true);
      vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
      expect(banner.element.hasAttribute('open')).toBe(false);
      expect(banner.element.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the loading presentation as the shared light row plus progress line, and drops both for a plain row', () => {
    const banner = createStatusBanner();

    banner.setStanding([document.createTextNode('Connecting to agent...')], 'loading');
    expect(banner.element.hasAttribute('open')).toBe(true);
    expect(banner.element.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(true);
    expect(banner.element.querySelector('.banner-row__progress')).not.toBeNull();
    expect(banner.element.textContent).toBe('Connecting to agent...');

    // A plain standing row must not inherit the light fill or the progress line
    // (the presentation is part of the standing state, not sticky on the row).
    banner.setStanding([document.createTextNode('Plain')]);
    expect(banner.element.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(false);
    expect(banner.element.querySelector('.banner-row__progress')).toBeNull();
    expect(banner.element.textContent).toBe('Plain');
  });

  it('a live presentation supersedes a loading standing row without inheriting its fill', () => {
    const banner = createStatusBanner();
    banner.setStanding([document.createTextNode('Connecting to agent...')], 'loading');

    banner.showError('Later');
    expect(banner.element.textContent).toBe('Later');
    expect(banner.element.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(false);
    expect(banner.element.querySelector('.banner-row__progress')).toBeNull();

    // Dismissing restores the loading floor - class and progress line included.
    dismiss(banner);
    expect(banner.element.textContent).toBe('Connecting to agent...');
    expect(banner.element.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(true);
    expect(banner.element.querySelector('.banner-row__progress')).not.toBeNull();
  });
});

describe('createSaveReporter aggregation', () => {
  it('one pending-start and one drain for a concurrent batch, with the first failure', () => {
    const onPendingStart = vi.fn();
    const onDrained = vi.fn();
    const reporter = createSaveReporter({ onPendingStart, onDrained });

    reporter.begin();
    reporter.begin();
    expect(onPendingStart).toHaveBeenCalledTimes(1);

    reporter.settle(false, 'first failure');
    reporter.settle(true, undefined);

    expect(onPendingStart).toHaveBeenCalledTimes(1);
    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(onDrained).toHaveBeenCalledWith('first failure');
  });

  it('a success-only batch drains with no error', () => {
    const onDrained = vi.fn();
    const reporter = createSaveReporter({ onPendingStart: () => undefined, onDrained });

    reporter.begin();
    reporter.settle(true, undefined);
    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(onDrained).toHaveBeenCalledWith(undefined);
  });

  it('a settle before any begin is ignored', () => {
    const onDrained = vi.fn();
    const reporter = createSaveReporter({ onPendingStart: () => undefined, onDrained });
    reporter.settle(false, 'orphan');
    expect(onDrained).not.toHaveBeenCalled();
  });

  it('a failure without a message falls back to "Save failed"', () => {
    const onDrained = vi.fn();
    const reporter = createSaveReporter({ onPendingStart: () => undefined, onDrained });
    reporter.begin();
    reporter.settle(false, undefined);
    expect(onDrained).toHaveBeenCalledWith('Save failed');
  });

  it('the aggregation resets between batches (a later success is reported as success)', () => {
    const onDrained = vi.fn();
    const reporter = createSaveReporter({ onPendingStart: () => undefined, onDrained });

    reporter.begin();
    reporter.settle(false, 'first batch failure');
    reporter.begin();
    reporter.settle(true, undefined);

    expect(onDrained.mock.calls).toEqual([['first batch failure'], [undefined]]);
  });
});

describe('reportSave wiring', () => {
  it('settles the reporter before the caller-owned continuation runs', async () => {
    const order: string[] = [];
    const reporter = createSaveReporter({
      onPendingStart: () => order.push('pending'),
      onDrained: () => order.push('drained'),
    });

    let resolveOutcome: (value: SaveOutcome) => void = () => undefined;
    const outcome = new Promise<SaveOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    reportSave(reporter, outcome);
    order.push('caller-attach');
    void outcome.then(() => order.push('caller-continuation'));

    resolveOutcome({ ok: true });
    await outcome;

    // The aggregator sees begin immediately, and its settle (which is what
    // drains the batch) is attached before the caller's own continuation.
    expect(order).toEqual(['pending', 'caller-attach', 'drained', 'caller-continuation']);
  });

  it('folds a rejected save into a failed settle', async () => {
    const onDrained = vi.fn();
    const reporter = createSaveReporter({ onPendingStart: () => undefined, onDrained });
    const outcome = Promise.reject(new Error('ipc down'));

    reportSave(reporter, outcome);
    await outcome.catch(() => undefined);

    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(onDrained).toHaveBeenCalledWith('ipc down');
  });
});
