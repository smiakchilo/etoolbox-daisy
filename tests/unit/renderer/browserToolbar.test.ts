import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserToolbar } from '../../../src/renderer/src/shell/browserToolbar';
import {
  BANNER_ROW_LOADING_CLASS,
  BANNER_TRANSITION_DURATION_MS,
} from '../../../src/renderer/src/lib/alertBanner';
import type {
  BrowserNavigationState,
  BrowserSwitchState,
  CertificateBlockedInfo,
} from '../../../src/shared';
import { newServerId } from '../../../src/shared';
import type { HostOption } from '../../../src/renderer/src/shell/viewModel';
import { installJsdomGlobals } from '../../support/jsdomGlobals';
import { byTestId } from '../../support/selectors';

/**
 * The toolbar's external-navigation loading state machine (browserToolbar.ts).
 * The toolbar is the only thing that knows a navigation was initiated outside
 * the webview (address bar, picker, Back/Forward/Refresh), so it owns whether
 * the "Loading…" banner + Refresh/Stop swap appear for a given `isLoading`
 * push. Rules under test:
 *
 * - Any load (`isLoading`), or an active switch, shows the banner and the
 *   Refresh→Stop swap - a navigation the page started (a link/button click)
 *   is treated exactly like a toolbar-initiated one.
 * - A sustained load is debounced by 200ms: the banner appears only after
 *   the load has outlived the debounce window, and a load that finishes
 *   inside the window never shows it (no layout shift for quick reloads).
 * - The banner clears when the load ends (`isLoading:false`), and a failed
 *   navigation result settles the load immediately (no stale Stop/banner).
 * - Opening/closing animates the row's block-size over
 *   `BANNER_TRANSITION_DURATION_MS` (the native view's reserved rectangle
 *   shrinks/grows gradually); the loading banner is never dismissible (no
 *   close control), error/prompt rows are.
 * - A user-initiated Stop swaps Refresh→Stop, and its ERR_ABORTED rejection
 *   is suppressed rather than surfaced as an error banner.
 * - Fetch failures surface as an error banner; dismissing it clears the row.
 */

interface FakeDaisyBrowser {
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  approveCertificateException: ReturnType<typeof vi.fn>;
  onStateChanged: ReturnType<typeof vi.fn>;
  onSwitchStateChanged: ReturnType<typeof vi.fn>;
  onCertificateBlocked: ReturnType<typeof vi.fn>;
}

interface FakeDaisySettings {
  addServer: ReturnType<typeof vi.fn>;
}

let dom: JSDOM;
let restoreGlobals: () => void;
let browser: FakeDaisyBrowser;
let settings: FakeDaisySettings;
let stateListeners: Array<(state: BrowserNavigationState) => void>;
let switchListeners: Array<(state: BrowserSwitchState) => void>;
let blockedListeners: Array<(info: CertificateBlockedInfo) => void>;

const AUTHOR_SERVER_ID = newServerId(() => 'server-a');

beforeEach(() => {
  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
  stateListeners = [];
  switchListeners = [];
  blockedListeners = [];
  browser = {
    goBack: vi.fn(() => Promise.resolve({ ok: true })),
    goForward: vi.fn(() => Promise.resolve({ ok: true })),
    reload: vi.fn(() => Promise.resolve({ ok: true })),
    stop: vi.fn(() => Promise.resolve({ ok: true })),
    navigate: vi.fn(() => Promise.resolve({ ok: true })),
    openExternal: vi.fn(() => Promise.resolve({ ok: true })),
    approveCertificateException: vi.fn(() => Promise.resolve({ ok: true })),
    onStateChanged: vi.fn((listener: (state: BrowserNavigationState) => void) => {
      stateListeners.push(listener);
      return () => {
        stateListeners = stateListeners.filter((candidate) => candidate !== listener);
      };
    }),
    onSwitchStateChanged: vi.fn((listener: (state: BrowserSwitchState) => void) => {
      switchListeners.push(listener);
      return () => {
        switchListeners = switchListeners.filter((candidate) => candidate !== listener);
      };
    }),
    onCertificateBlocked: vi.fn((listener: (info: CertificateBlockedInfo) => void) => {
      blockedListeners.push(listener);
      return () => {
        blockedListeners = blockedListeners.filter((candidate) => candidate !== listener);
      };
    }),
  };
  settings = {
    addServer: vi.fn(() => Promise.resolve({ ok: true, server: snapshotOf(AUTHOR_SERVER_ID) })),
  };
  Reflect.set(dom.window, 'daisy', { browser, settings });
});

afterEach(() => {
  vi.useRealTimers();
  restoreGlobals();
});

let refreshLabel = '';

function build(): ReturnType<typeof createBrowserToolbar> {
  const toolbar = createBrowserToolbar({ onHostsPickerClick: () => {}, onHomeClick: () => {} });
  // A freshly built toolbar is idle, so its nav button is in Refresh mode.
  refreshLabel = findNavButton(toolbar).getAttribute('aria-label') ?? '';
  return toolbar;
}

function expectRefreshMode(toolbar: ReturnType<typeof createBrowserToolbar>): void {
  expect(refreshLabel.length).toBeGreaterThan(0);
  expect(findNavButton(toolbar).getAttribute('aria-label')).toBe(refreshLabel);
}

function expectStopMode(toolbar: ReturnType<typeof createBrowserToolbar>): void {
  const label = findNavButton(toolbar).getAttribute('aria-label');
  expect(label?.length).toBeGreaterThan(0);
  expect(label).not.toBe(refreshLabel);
}

function loadingState(isLoading: boolean): BrowserNavigationState {
  return {
    url: 'https://author.example/content/page.html',
    canGoBack: true,
    canGoForward: false,
    isLoading,
    hasDocument: true,
  };
}

function findMessage(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement {
  const message = toolbar.messageElement;
  if (!message) throw new Error('toolbar.messageElement missing');
  return message;
}

function findNavButton(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement {
  const button = toolbar.element.querySelector(
    `${byTestId('browser-refresh')}, ${byTestId('browser-stop')}`,
  );
  if (!button) throw new Error('nav (refresh/stop) button not found');
  return button as HTMLElement;
}

describe('createBrowserToolbar loading state machine', () => {
  it('swaps to Stop immediately while the banner stays debounced, and restores on did-stop-loading', () => {
    vi.useFakeTimers();
    const toolbar = build();
    const message = findMessage(toolbar);

    // Arm: click Refresh (rebinds from the initial cosmetic icon to the wired
    // handler), then the load starts.
    findNavButton(toolbar).click();
    stateListeners[0]?.(loadingState(true));

    // The Refresh→Stop swap is immediate (same moment the address target is
    // committed); only the banner waits 200ms of sustained load.
    expect(message.hasAttribute('open')).toBe(false);
    expectStopMode(toolbar);

    vi.advanceTimersByTime(1000);

    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent?.length).toBeGreaterThan(0);
    expect(message.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(true);
    // The loading presentation is not dismissible and ends in a progress line.
    expect(message.hasAttribute('dismissible')).toBe(false);
    expect(message.querySelector('.banner-row__progress')).not.toBeNull();
    expectStopMode(toolbar);
    expect(browser.reload).toHaveBeenCalledTimes(1);

    stateListeners[0]?.(loadingState(false));
    // Closing collapses the row: `open`/children stay until the animation
    // finishes, then the DOM is torn down.
    expect(message.hasAttribute('open')).toBe(true);
    vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
    expect(message.hasAttribute('open')).toBe(false);
    expect(message.textContent).toBe('');
    expect(message.querySelector('.banner-row__progress')).toBeNull();
    expectRefreshMode(toolbar);
  });

  it('treats an in-webview navigation exactly like a chrome-initiated one', () => {
    vi.useFakeTimers();
    const toolbar = build();
    const message = findMessage(toolbar);

    // No toolbar action started this load - the page did (a link or button).
    stateListeners[0]?.(loadingState(true));
    // The Refresh→Stop swap is immediate; the banner waits out the debounce.
    expectStopMode(toolbar);
    expect(message.hasAttribute('open')).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent?.length).toBeGreaterThan(0);

    stateListeners[0]?.(loadingState(false));
    vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
    expect(message.hasAttribute('open')).toBe(false);
    expectRefreshMode(toolbar);
  });

  it('arms the loading presentation from Back/Forward too', () => {
    vi.useFakeTimers();
    const toolbar = build();
    const message = findMessage(toolbar);
    // Back is the Refresh/Stop button's sibling.
    const back = toolbar.element.querySelector(byTestId('browser-back')) as HTMLElement;
    if (!back) throw new Error('back button not found');

    back.click();
    expect(browser.goBack).toHaveBeenCalledTimes(1);
    stateListeners[0]?.(loadingState(true));
    expect(message.hasAttribute('open')).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(true);
    expectStopMode(toolbar);

    stateListeners[0]?.(loadingState(false));
    vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
    expect(message.hasAttribute('open')).toBe(false);
  });

  it('shows the banner for a later in-webview load after a chrome load ended', () => {
    vi.useFakeTimers();
    const toolbar = build();
    const message = findMessage(toolbar);

    findNavButton(toolbar).click();
    stateListeners[0]?.(loadingState(true));
    stateListeners[0]?.(loadingState(false));
    // Even long after the load ended, the timer never fires (it was
    // cancelled by the idle transition).
    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(false);

    // A later in-webview navigation is not "silent": it drives the same
    // loading presentation as any other load.
    stateListeners[0]?.(loadingState(true));
    expectStopMode(toolbar);
    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent?.length).toBeGreaterThan(0);
  });

  it('never shows the banner when the armed load finishes inside the 200ms debounce window', () => {
    vi.useFakeTimers();
    const toolbar = build();
    const message = findMessage(toolbar);

    findNavButton(toolbar).click();
    stateListeners[0]?.(loadingState(true));
    expect(message.hasAttribute('open')).toBe(false);

    // did-stop-loading arrives at ~150ms — well inside the window.
    stateListeners[0]?.(loadingState(false));
    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(false);
    expect(message.textContent).toBe('');
    expect(message.querySelector('.banner-row__progress')).toBeNull();
    expectRefreshMode(toolbar);
  });

  it('suppresses the ERR_ABORTED from a user-initiated Stop (no error banner)', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    // An address submit navigates (source: the address bar, routed through
    // `browser:navigate`). The load briefly starts — inside the 200ms debounce
    // window, so no banner has appeared yet.
    browser.navigate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'network_error', message: 'net::ERR_ABORTED', errorCode: 'ERR_ABORTED' },
    });
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    address.value = 'https://author.example/content/page.html';
    address.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
    stateListeners[0]?.(loadingState(true));
    expect(message.hasAttribute('open')).toBe(false);
    expectStopMode(toolbar);

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
    // `browser:navigate` is the one toolbar IPC that reports load failure
    // (`reload`/`goBack`/`goForward` return ok immediately), and an abort
    // from a user Stop is a cancellation - the error banner must stay
    // suppressed and the arm cleared (back to idle/Refresh).
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });
    expect(message.textContent).toBe('');
    expectRefreshMode(toolbar);
  });

  it('suppresses the real Stop cancellation (ERR_FAILED from Electron 44) without an error banner', async () => {
    vi.useFakeTimers();
    const toolbar = build();
    const message = findMessage(toolbar);

    // An address submit starts a navigation whose in-flight promise we
    // resolve later (the load is slow).
    let resolveNavigation: ((value: unknown) => void) | undefined;
    const pendingNavigation = new Promise((resolve) => {
      resolveNavigation = resolve;
    });
    browser.navigate.mockReturnValueOnce(pendingNavigation);

    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    address.value = 'https://author.example/content/page.html';
    address.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
    stateListeners[0]?.(loadingState(true));
    expect(message.hasAttribute('open')).toBe(false);
    expectStopMode(toolbar);

    // The load persists past the debounce, so the banner appears too.
    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(true);
    expectStopMode(toolbar);

    // The user clicks Stop: verified against Electron 44.3.0, a Stop during a
    // pending loadURL makes that promise reject with ERR_FAILED, not
    // ERR_ABORTED (probe in the Step 05 verification records). Suppression
    // keys on the user action captured when Stop was clicked.
    findNavButton(toolbar).click();
    expect(browser.stop).toHaveBeenCalledTimes(1);
    // Let the ok Stop result flow through `handleVoidResult`.
    await Promise.resolve();
    await Promise.resolve();

    resolveNavigation?.({
      ok: false,
      error: {
        code: 'network_error',
        message: "ERR_FAILED (-2) loading 'https://author.example/content/page.html'",
        errorCode: 'ERR_FAILED',
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
    expect(message.hasAttribute('open')).toBe(false);
    expect(message.textContent).toBe('');
    expectRefreshMode(toolbar);
  });

  it('shows error copy for a failed fetch navigation, and closes on dismissal', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    browser.navigate.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'network_error',
        message: "Can't connect to https://dead.example",
        errorCode: 'ERR_CONNECTION_REFUSED',
      },
    });

    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    address.value = 'https://dead.example';
    address.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent).toContain('dead.example');
    // Error/prompt rows are dismissible, unlike the loading presentation.
    expect(message.hasAttribute('dismissible')).toBe(true);
    expectRefreshMode(toolbar);

    message.dispatchEvent(new dom.window.Event('close', { bubbles: true, composed: true }));
    // The dismissal collapses the row, then tears it down.
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });
    expect(message.textContent).toBe('');
    expect(message.hasAttribute('dismissible')).toBe(false);
  });

  it('keeps the banner open across a switch+load overlap, then closes when both clear', () => {
    vi.useFakeTimers();
    const toolbar = build();
    const message = findMessage(toolbar);

    // A picker selection starts a navigation and begins a server switch.
    toolbar.navigateTo('https://author.example/');
    switchListeners[0]?.({ switching: true });
    // Debounce: loading presentation waits 200ms.
    expect(message.hasAttribute('open')).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent?.length).toBeGreaterThan(0);

    // The load starts; then the switch controller reports done while the page
    // is still loading — the banner must not close early (the load is still in
    // progress).
    stateListeners[0]?.(loadingState(true));
    switchListeners[0]?.({ switching: false });
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent?.length).toBeGreaterThan(0);
    expect(message.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(true);

    // did-stop-loading collapses it.
    stateListeners[0]?.(loadingState(false));
    vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
    expect(message.hasAttribute('open')).toBe(false);
    expect(message.textContent).toBe('');
    expect(message.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(false);
  });

  it('keeps the address field enabled through a server switch while back/forward disable', () => {
    const toolbar = build();
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement;
    const back = toolbar.element.querySelector(byTestId('browser-back')) as HTMLElement;

    switchListeners[0]?.({ switching: true });
    expect(address.hasAttribute('disabled')).toBe(false);
    expect(back.hasAttribute('disabled')).toBe(true);

    switchListeners[0]?.({ switching: false });
    expect(address.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the hosts picker enabled during a server switch when hosts are configured', () => {
    const toolbar = build();
    const picker = toolbar.element.querySelector('#hosts-button') as HTMLElement;
    toolbar.setHostOptions([hostOption()]);

    // The user must never be trapped in a slow/flaky load with no way to pick
    // another host: the picker stays live through the whole switch.
    switchListeners[0]?.({ switching: true });
    expect(picker.hasAttribute('disabled')).toBe(false);

    switchListeners[0]?.({ switching: false });
    expect(picker.hasAttribute('disabled')).toBe(false);
  });

  it('disables the hosts picker only when no hosts are configured', () => {
    const toolbar = build();
    const picker = toolbar.element.querySelector('#hosts-button') as HTMLElement;

    toolbar.setHostOptions([]);
    expect(picker.hasAttribute('disabled')).toBe(true);

    toolbar.setHostOptions([hostOption()]);
    expect(picker.hasAttribute('disabled')).toBe(false);
  });

  it('tracks an in-page navigation in the address field immediately', () => {
    const toolbar = build();
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };

    // An in-page link fired this push: the pushed URL must land in the field
    // straight away, loading or not.
    stateListeners[0]?.({
      url: 'https://author.example/content/page.html#section',
      canGoBack: true,
      canGoForward: false,
      isLoading: true,
      hasDocument: true,
    });

    expect(address.value).toBe('https://author.example/content/page.html#section');
  });

  it('applies every pushed URL so the address tracks the live navigation', () => {
    const toolbar = build();
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };

    // A picker selection writes the chosen host; no synchronous arm is needed.
    toolbar.navigateTo('https://author.example/');
    expect(address.value).toBe('https://author.example/');

    // did-start-navigation now reports the navigation's destination (see
    // `hostView.ts`), so the field keeps showing it while the load runs.
    stateListeners[0]?.({
      url: 'https://author.example/',
      canGoBack: false,
      canGoForward: false,
      isLoading: true,
      hasDocument: true,
    });
    expect(address.value).toBe('https://author.example/');

    // A redirect while still loading updates the field immediately.
    stateListeners[0]?.({
      url: 'https://author.example/content/page.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: true,
      hasDocument: true,
    });
    expect(address.value).toBe('https://author.example/content/page.html');

    // The completed load's final URL is applied too.
    stateListeners[0]?.({
      url: 'https://author.example/content/page.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    });
    expect(address.value).toBe('https://author.example/content/page.html');
  });

  it('re-opens seamlessly when a new external load starts right after the previous one ended', () => {
    vi.useFakeTimers();
    const toolbar = build();
    const message = findMessage(toolbar);

    findNavButton(toolbar).click();
    stateListeners[0]?.(loadingState(true));
    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent?.length).toBeGreaterThan(0);
    expect(message.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(true);
    expect(message.querySelector('.banner-row__progress')).not.toBeNull();

    stateListeners[0]?.(loadingState(false));
    vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
    expect(message.hasAttribute('open')).toBe(false);
    expect(message.textContent).toBe('');

    // A new load starts: the debounce arms again and the banner re-opens
    // after the 200ms window.
    findNavButton(toolbar).click();
    stateListeners[0]?.(loadingState(true));
    expect(message.hasAttribute('open')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent?.length).toBeGreaterThan(0);
    expect(message.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(true);
    expect(message.querySelector('.banner-row__progress')).not.toBeNull();
  });

  it('shows a fetch error immediately even while a loading debounce is armed', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    browser.navigate.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'network_error',
        message: "Can't connect to https://dead.example",
        errorCode: 'ERR_CONNECTION_REFUSED',
      },
    });

    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    address.value = 'https://dead.example';
    address.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
    // A loading push arms the 200ms timer; the error arrives first and
    // supersedes it.
    stateListeners[0]?.(loadingState(true));

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
    // The error appears immediately — the user never waits for the debounce
    // timer to fire.
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(true);
    });
    expect(message.textContent).toContain('dead.example');
    expect(message.hasAttribute('dismissible')).toBe(true);
    expectRefreshMode(toolbar);
  });
});

describe('createBrowserToolbar navigation failure recovery', () => {
  function buildWith(): ReturnType<typeof createBrowserToolbar> {
    return createBrowserToolbar({ onHostsPickerClick: () => {}, onHomeClick: () => {} });
  }

  /** Reports the page the view is showing, so it can be remembered as "previous". */
  function pushPage(url: string): void {
    stateListeners[0]?.({
      url,
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    });
  }

  function typeAndSubmit(toolbar: ReturnType<typeof createBrowserToolbar>, value: string): void {
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    address.value = value;
    address.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
  }

  const TIMEOUT_ERROR = {
    ok: false as const,
    error: {
      code: 'network_error' as const,
      message: 'Timed out reaching https://dead.example',
      errorCode: 'ERR_TIMED_OUT',
    },
  };

  it('adds a size-s Reload action that re-issues the failed target', async () => {
    const toolbar = buildWith();
    const message = findMessage(toolbar);
    browser.navigate.mockResolvedValue(TIMEOUT_ERROR);

    typeAndSubmit(toolbar, 'https://dead.example/content/page.html');
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(true);
    });

    const reload = message.querySelector('sp-action-button');
    expect(reload).not.toBeNull();
    expect(message.textContent).toContain('dead.example');
    expect(reload?.textContent?.length).toBeGreaterThan(0);
    expect(reload?.getAttribute('size')).toBe('s');

    const before = browser.navigate.mock.calls.length;
    (reload as HTMLElement).click();
    await vi.waitFor(() => {
      expect(browser.navigate.mock.calls.length).toBe(before + 1);
    });
    expect(browser.navigate).toHaveBeenLastCalledWith('https://dead.example/content/page.html');
  });

  it('restores the page displayed before a failed load via history, then keeps the error row', async () => {
    const toolbar = buildWith();
    const message = findMessage(toolbar);
    pushPage('https://author.example/content/page.html');

    browser.navigate.mockResolvedValueOnce(TIMEOUT_ERROR);

    typeAndSubmit(toolbar, 'https://author.example/content/other.html');

    // A fresh navigation's failure restores through history (instant bfcache
    // back), not a network re-navigation of the remembered URL.
    await vi.waitFor(() => {
      expect(browser.goBack).toHaveBeenCalledTimes(1);
    });
    expect(browser.navigate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(true);
    });
    expect(message.textContent).toContain('Timed out reaching');
    expect(message.querySelector('sp-action-button')?.textContent?.length).toBeGreaterThan(0);
  });

  it('keeps the error row readable while the silent restore is loading', async () => {
    const toolbar = buildWith();
    const message = findMessage(toolbar);
    pushPage('https://author.example/content/page.html');

    let resolveGoBack: ((value: { ok: boolean }) => void) | undefined;
    browser.goBack.mockReturnValueOnce(
      new Promise<{ ok: boolean }>((resolve) => {
        resolveGoBack = resolve;
      }),
    );
    browser.navigate.mockResolvedValueOnce(TIMEOUT_ERROR);

    typeAndSubmit(toolbar, 'https://author.example/content/other.html');
    await vi.waitFor(() => {
      expect(browser.goBack).toHaveBeenCalledTimes(1);
    });

    // The restore's own load begins. Its `isLoading` push must NOT replace the
    // error row with the loading presentation - that is the whole point of a
    // silent recovery.
    stateListeners[0]?.({
      url: 'https://author.example/content/page.html',
      canGoBack: false,
      canGoForward: false,
      isLoading: true,
      hasDocument: true,
    });
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(false);
    expect(message.textContent).toContain('Timed out reaching');

    resolveGoBack?.({ ok: true });
    await vi.waitFor(() => {
      expect(message.textContent).toContain('Timed out reaching');
    });
  });

  it('keeps an unacknowledged error row through a page-initiated load, then clears it on a user navigation', async () => {
    const toolbar = buildWith();
    const message = findMessage(toolbar);
    pushPage('https://author.example/content/page.html');

    browser.navigate.mockResolvedValueOnce(TIMEOUT_ERROR);
    typeAndSubmit(toolbar, 'https://author.example/content/other.html');
    await vi.waitFor(() => {
      expect(message.textContent).toContain('Timed out reaching');
    });

    // The restored page starts its own load (a redirect/SSO hop). The error
    // row must survive it rather than being replaced by the loading
    // presentation - this is the regression that lost the message entirely.
    stateListeners[0]?.({
      url: 'https://author.example/content/page.html',
      canGoBack: false,
      canGoForward: false,
      isLoading: true,
      hasDocument: true,
    });
    expect(message.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(false);
    expect(message.textContent).toContain('Timed out reaching');

    // A user-initiated navigation acknowledges the error; the row lets go
    // (it collapses, then is torn down).
    browser.navigate.mockResolvedValueOnce({ ok: true });
    typeAndSubmit(toolbar, 'https://author.example/content/third.html');
    stateListeners[0]?.({
      url: 'https://author.example/content/third.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    });
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });
    expect(message.textContent).not.toContain('Timed out reaching');
  });

  it('does not rebuild the error row (or detach its Reload) on repeated state pushes', async () => {
    const toolbar = buildWith();
    const message = findMessage(toolbar);

    browser.navigate.mockResolvedValueOnce(TIMEOUT_ERROR);
    typeAndSubmit(toolbar, 'https://dead.example/');
    await vi.waitFor(() => {
      expect(message.querySelector('sp-action-button')).not.toBeNull();
    });
    const reload = message.querySelector('sp-action-button');

    // Several pushes arrive while the error persists (a long restored-page
    // load); the same button node must remain in the row.
    for (let i = 0; i < 3; i += 1) {
      stateListeners[0]?.({
        url: 'https://author.example/content/page.html',
        canGoBack: false,
        canGoForward: false,
        isLoading: true,
        hasDocument: true,
      });
    }
    expect(message.querySelector('sp-action-button')).toBe(reload);
    expect(message.textContent).toContain('Timed out reaching');
  });

  it('does not attempt a restore when nothing was displayed before the failure', async () => {
    const toolbar = buildWith();
    browser.navigate.mockResolvedValueOnce(TIMEOUT_ERROR);

    typeAndSubmit(toolbar, 'https://dead.example/');

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
    // No previous page: only the original navigation was issued. The pane's
    // home screen covers the empty page-view region (the native view stays
    // collapsed while `hasDocument` is false), so the toolbar has nothing to
    // recover here.
    expect(browser.goBack).not.toHaveBeenCalled();
    expect(browser.navigate).toHaveBeenCalledTimes(1);
  });

  it('shows the error row (with Reload) on a failed reload', async () => {
    const toolbar = buildWith();
    const message = findMessage(toolbar);
    pushPage('https://author.example/');
    browser.reload.mockResolvedValueOnce(TIMEOUT_ERROR);

    // Refresh with the address matching the loaded page issues a reload.
    findNavButton(toolbar).click();

    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(true);
    });
    expect(message.querySelector('sp-action-button')?.textContent?.length).toBeGreaterThan(0);
    // A reload's "previous page" is the very page that just failed, so there
    // is nothing to fall back to.
    expect(browser.navigate).not.toHaveBeenCalled();
  });
});

const BLOCKED_INFO: CertificateBlockedInfo = {
  origin: 'https://author.example',
  certificateSha256Fingerprint: 'a'.repeat(64),
  errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
};

function snapshotOf(id: string): {
  id: string;
  label: string;
  origin: string;
  color: { kind: 'swatch'; swatch: 'red' };
  revision: number;
} {
  return {
    id,
    label: 'Author',
    origin: 'https://author.example',
    color: { kind: 'swatch', swatch: 'red' },
    revision: 0,
  };
}

function hostOption(overrides: Partial<HostOption> = {}): HostOption {
  return {
    id: AUTHOR_SERVER_ID,
    label: 'Author',
    origin: 'https://author.example',
    colorCss: 'color: rgb(20, 115, 230)',
    ...overrides,
  };
}

function findPromptOk(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement {
  const message = findMessage(toolbar);
  const ok = message.querySelector('sp-action-button');
  if (!ok) throw new Error('certificate prompt OK button not found');
  return ok as HTMLElement;
}

describe('createBrowserToolbar certificate prompt', () => {
  it('renders the prompt with copy and an enabled OK when a configured server matches the blocked origin', () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    toolbar.setHostOptions([
      hostOption(),
      hostOption({ id: newServerId(() => 'server-b'), label: 'Other' }),
    ]);

    blockedListeners[0]?.(BLOCKED_INFO);

    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent?.length).toBeGreaterThan(0);
    expect(findPromptOk(toolbar).hasAttribute('disabled')).toBe(false);
    expect(findPromptOk(toolbar).getAttribute('size')).toBe('s');
    expect(findMessage(toolbar).hasAttribute('dismissible')).toBe(true);
  });

  it('disables OK while the blocked origin has no matching configured server, then enables it once a match arrives', () => {
    const toolbar = build();

    // Normal flow cannot reach this state - an unknown origin is refused and
    // created *before* any certificate check, so a matching configured server
    // always exists by the time this banner appears. The guard still holds for
    // the edge case where that server was deleted concurrently.
    blockedListeners[0]?.(BLOCKED_INFO);
    expect(findPromptOk(toolbar).hasAttribute('disabled')).toBe(true);

    // The settings snapshot lands after the prompt: OK re-evaluates against
    // the now-present server.
    toolbar.setHostOptions([hostOption()]);
    expect(findPromptOk(toolbar).hasAttribute('disabled')).toBe(false);
  });

  it('approves with the exact decision main pushed and clears the prompt', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    toolbar.setHostOptions([hostOption()]);
    blockedListeners[0]?.(BLOCKED_INFO);

    findPromptOk(toolbar).click();

    await vi.waitFor(() => {
      expect(browser.approveCertificateException).toHaveBeenCalledWith({
        serverId: AUTHOR_SERVER_ID,
        exception: BLOCKED_INFO,
      });
    });
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });
    expect(message.textContent).toBe('');
  });

  it('surfaces an approval failure as an error row instead of leaving the prompt up', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    toolbar.setHostOptions([hostOption()]);
    blockedListeners[0]?.(BLOCKED_INFO);
    browser.approveCertificateException.mockResolvedValueOnce({
      ok: false,
      error: { code: 'server_not_found', message: `no server with id server-a` },
    });

    const promptText = message.textContent;

    findPromptOk(toolbar).click();
    await vi.waitFor(() => {
      expect(message.textContent).not.toBe(promptText);
      expect(message.textContent?.length).toBeGreaterThan(0);
    });
    expect(message.hasAttribute('open')).toBe(true);
    expect(findMessage(toolbar).hasAttribute('dismissible')).toBe(true);
  });

  it('the banner close control dismisses the prompt without persisting anything', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    toolbar.setHostOptions([hostOption()]);
    blockedListeners[0]?.(BLOCKED_INFO);
    expect(message.hasAttribute('open')).toBe(true);

    message.dispatchEvent(new dom.window.Event('close', { bubbles: true, composed: true }));

    expect(browser.approveCertificateException).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });
    expect(message.textContent).toBe('');
  });

  it('re-appears after a dismissal when the address is re-requested (Enter/Refresh re-fires the block)', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    toolbar.setHostOptions([hostOption()]);
    blockedListeners[0]?.(BLOCKED_INFO);
    expect(message.hasAttribute('open')).toBe(true);

    // The user waves the banner away; nothing is persisted.
    message.dispatchEvent(new dom.window.Event('close', { bubbles: true, composed: true }));
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });

    // Re-requesting the address (Enter in the address bar, or Refresh)
    // re-runs navigation, `certificate-error` re-fires, and main re-pushes
    // the decision - so the prompt must come back, exactly like the
    // unknown-origin prompt after its dismissal.
    blockedListeners[0]?.(BLOCKED_INFO);
    expect(message.hasAttribute('open')).toBe(true);
    expect(browser.approveCertificateException).not.toHaveBeenCalled();
  });

  it('a new navigation supersedes the prompt', () => {
    vi.useFakeTimers();
    try {
      const toolbar = build();
      const message = findMessage(toolbar);
      toolbar.setHostOptions([hostOption()]);
      blockedListeners[0]?.(BLOCKED_INFO);
      expect(message.hasAttribute('open')).toBe(true);

      // Approving should not be possible after the user has moved on; a new
      // load clears the prompt at the same boundary main clears its retry
      // target. The row collapses before the loading presentation's 200ms
      // debounce would re-show it.
      stateListeners[0]?.(loadingState(true));

      expect(message.hasAttribute('open')).toBe(true);
      vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
      expect(message.hasAttribute('open')).toBe(false);
      expect(message.textContent).toBe('');
      expect(message.querySelector('sp-action-button')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

function findUnknownOriginOk(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement {
  const message = findMessage(toolbar);
  const ok = message.querySelector('sp-action-button');
  if (!ok) throw new Error('unknown-origin OK button not found');
  return ok as HTMLElement;
}

function triggerUnknownOrigin(
  toolbar: ReturnType<typeof createBrowserToolbar>,
  url: string,
  origin = 'https://unknown.example',
): void {
  browser.navigate.mockResolvedValueOnce({
    ok: false,
    error: { code: 'unknown_origin', message: `${origin} is not a configured server`, origin },
  });
  const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
    value: string;
  };
  address.value = url;
  address.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
  );
}

describe('createBrowserToolbar unknown-origin prompt', () => {
  it('renders an OK action-button prompt instead of a text-only error', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    triggerUnknownOrigin(toolbar, 'https://unknown.example/content/page.html');
    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });

    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent?.length).toBeGreaterThan(0);
    // The origin is visible in the address bar above the banner; the copy
    // must not repeat it (noise, and invites reading the banner instead of
    // the real navigated address).
    expect(message.textContent).not.toContain('https://unknown.example');
    // Exactly one accepting action: an `sp-action-button` (never an accent
    // `sp-button` - no blue fill). Cancel is the banner's dismiss cross.
    const okButtons = message.querySelectorAll('sp-action-button');
    expect(okButtons).toHaveLength(1);
    expect(okButtons[0]?.textContent?.length).toBeGreaterThan(0);
    // Banner actions are always size "s" (createBannerActionButton).
    expect(okButtons[0]?.getAttribute('size')).toBe('s');
    expect(message.querySelector('sp-button[variant="accent"]')).toBeNull();
    expect(findMessage(toolbar).hasAttribute('dismissible')).toBe(true);
  });

  it('"OK" creates the server with defaults derived from the origin, then retries the exact URL', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    triggerUnknownOrigin(
      toolbar,
      'https://unknown.example:4502/content/page.html',
      'https://unknown.example:4502',
    );
    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });

    findUnknownOriginOk(toolbar).click();

    await vi.waitFor(() => {
      expect(settings.addServer).toHaveBeenCalledWith({
        label: 'unknown.example:4502',
        origin: 'https://unknown.example:4502',
        color: { kind: 'swatch', swatch: 'red' },
      });
    });
    // The retry navigates to the address that was refused, now that the
    // origin is a configured server.
    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenLastCalledWith(
        'https://unknown.example:4502/content/page.html',
      );
    });
    expect(browser.navigate).toHaveBeenCalledTimes(2);
    // The prompt cleared once the auto-navigation started (the row collapses
    // before the DOM is torn down).
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });
  });

  it('surfaces an add failure as an error row instead of leaving the prompt up', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    settings.addServer.mockResolvedValueOnce({
      ok: false,
      error: { code: 'storage_error', message: 'settings file could not be written' },
    });

    triggerUnknownOrigin(toolbar, 'https://unknown.example/content/page.html');
    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });

    findUnknownOriginOk(toolbar).click();

    await vi.waitFor(() => {
      expect(message.textContent).toContain('settings file could not be written');
    });
    expect(message.hasAttribute('open')).toBe(true);
    // The failed add must not have auto-retried the navigation.
    expect(browser.navigate).toHaveBeenCalledTimes(1);
    expect(findMessage(toolbar).hasAttribute('dismissible')).toBe(true);
  });

  it('the banner close control dismisses the prompt too', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    triggerUnknownOrigin(toolbar, 'https://unknown.example/content/page.html');
    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
    expect(message.hasAttribute('open')).toBe(true);

    message.dispatchEvent(new dom.window.Event('close', { bubbles: true, composed: true }));

    expect(settings.addServer).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });
    expect(message.textContent).toBe('');
  });

  it('a new navigation supersedes the prompt', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    triggerUnknownOrigin(toolbar, 'https://unknown.example/content/page.html');
    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
    expect(message.hasAttribute('open')).toBe(true);

    // The prompt collapses immediately; the loading presentation would only
    // re-show it after its 200ms debounce, which this does not reach.
    vi.useFakeTimers();
    try {
      stateListeners[0]?.(loadingState(true));

      expect(message.hasAttribute('open')).toBe(true);
      vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
      expect(message.hasAttribute('open')).toBe(false);
      expect(message.textContent).toBe('');
      expect(message.querySelector('sp-action-button')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pressing Enter again on the same address re-triggers the banner after dismissal', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    const UNKNOWN_URL = 'https://unknown.example/content/page.html';
    const UNKNOWN_ORIGIN = 'https://unknown.example';

    // First attempt: type + Enter → banner.
    triggerUnknownOrigin(toolbar, UNKNOWN_URL, UNKNOWN_ORIGIN);
    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
    expect(message.hasAttribute('open')).toBe(true);

    // Dismiss.
    message.dispatchEvent(new dom.window.Event('close', { bubbles: true, composed: true }));
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });

    // Address bar still holds the refused URL (no state push from a failed
    // navigate). Pressing Enter via keydown — value unchanged, so `change`
    // would not fire — must still re-trigger the prompt.
    browser.navigate.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'unknown_origin',
        message: `${UNKNOWN_ORIGIN} is not a configured server`,
        origin: UNKNOWN_ORIGIN,
      },
    });
    address.value = UNKNOWN_URL;
    address.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(2);
    });
    expect(browser.navigate).toHaveBeenLastCalledWith(UNKNOWN_URL);
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent?.length).toBeGreaterThan(0);
  });

  it('Refresh navigates the address bar URL when it differs from the loaded page', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    const UNKNOWN_URL = 'https://unknown.example/content/page.html';
    const UNKNOWN_ORIGIN = 'https://unknown.example';
    const refreshButton = findNavButton(toolbar);

    // First attempt → banner.
    triggerUnknownOrigin(toolbar, UNKNOWN_URL, UNKNOWN_ORIGIN);
    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
    expect(message.hasAttribute('open')).toBe(true);

    // Dismiss. Address bar still holds the refused URL.
    message.dispatchEvent(new dom.window.Event('close', { bubbles: true, composed: true }));
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });

    // Simulate a loaded page on a different origin so the Refresh handler
    // sees address !== currentUrl.
    stateListeners[0]?.({
      url: 'https://author.example/',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    });

    browser.navigate.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'unknown_origin',
        message: `${UNKNOWN_ORIGIN} is not a configured server`,
        origin: UNKNOWN_ORIGIN,
      },
    });
    address.value = UNKNOWN_URL;
    refreshButton.click();

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(2);
    });
    expect(browser.navigate).toHaveBeenLastCalledWith(UNKNOWN_URL);
    expect(message.hasAttribute('open')).toBe(true);
  });

  it('Refresh still reloads when the address bar matches the loaded page', () => {
    const toolbar = build();
    const refreshButton = findNavButton(toolbar);

    stateListeners[0]?.({
      url: 'https://author.example/',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    });

    refreshButton.click();

    expect(browser.reload).toHaveBeenCalledTimes(1);
    expect(browser.navigate).not.toHaveBeenCalled();
  });

  it('Refresh navigates the address bar URL when NO page has loaded yet (fresh state)', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    const UNKNOWN_URL = 'https://unknown.example/content/page.html';
    const UNKNOWN_ORIGIN = 'https://unknown.example';
    const refreshButton = findNavButton(toolbar);

    // First attempt → banner. The refused navigation fires no
    // did-navigate/did-stop-loading state push, so `lastNavigationState`
    // stays null - exactly the fresh-profile repro.
    triggerUnknownOrigin(toolbar, UNKNOWN_URL, UNKNOWN_ORIGIN);
    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
    expect(message.hasAttribute('open')).toBe(true);
    expect(stateListeners[0]).toBeDefined();

    // Dismiss. Address bar still holds the refused URL; no state was pushed.
    message.dispatchEvent(new dom.window.Event('close', { bubbles: true, composed: true }));
    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });

    // Refresh with no `lastNavigationState` must still re-request the address
    // bar value (previously it fell back to `reload()` of the blank view,
    // which does nothing - the reported bug).
    browser.navigate.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'unknown_origin',
        message: `${UNKNOWN_ORIGIN} is not a configured server`,
        origin: UNKNOWN_ORIGIN,
      },
    });
    address.value = UNKNOWN_URL;
    refreshButton.click();

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(2);
    });
    expect(browser.navigate).toHaveBeenLastCalledWith(UNKNOWN_URL);
    expect(browser.reload).not.toHaveBeenCalled();
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent?.length).toBeGreaterThan(0);
  });

  it('navigates on Enter exactly once and ignores a stray change (blur)', async () => {
    const toolbar = build();
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };

    browser.navigate.mockResolvedValue({ ok: true });
    address.value = 'https://author.example/content/page.html';
    address.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
    // A blur-driven `change` (the native event sp-textfield forwards when
    // focus leaves the field) must not navigate again — or at all.
    const blurChange = new dom.window.Event('change', { bubbles: true });
    address.dispatchEvent(blurChange);

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
  });

  it('does not navigate on a blur-driven change (e.g. clicking the hosts picker)', () => {
    const toolbar = build();
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    browser.navigate.mockResolvedValue({ ok: true });

    // "loc" typed, then focus moves to the hosts picker: the field blurs and
    // sp-textfield forwards the native `change`. No navigation may start.
    address.value = 'loc';
    const blurChange = new dom.window.Event('change', { bubbles: true });
    address.dispatchEvent(blurChange);

    expect(browser.navigate).not.toHaveBeenCalled();
  });
});

function addressHostLabel(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement | null {
  return toolbar.element.querySelector<HTMLElement>('.address-bar__host-label');
}

describe('createBrowserToolbar address host label', () => {
  const authorHost: HostOption = {
    id: AUTHOR_SERVER_ID,
    label: 'Author',
    origin: 'https://author.example',
    colorCss: '#2680eb',
  };

  function navigationState(url: string): BrowserNavigationState {
    return { url, canGoBack: false, canGoForward: false, isLoading: false, hasDocument: true };
  }

  it('shows the matching host label on its colour once a URL on that origin is loaded', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    stateListeners[0]?.(navigationState('https://author.example/content/page.html'));

    const label = addressHostLabel(toolbar);
    expect(label?.hidden).toBe(false);
    expect(label?.textContent).toBe('Author');
    expect(label?.style.backgroundColor).toBe('rgb(38, 128, 235)');
    // Blue is dark enough that white text keeps its contrast.
    expect(label?.style.color).toBe('rgb(255, 255, 255)');
  });

  it('hides the label when the address matches no host', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    stateListeners[0]?.(navigationState('https://unknown.example/content/page.html'));

    const label = addressHostLabel(toolbar);
    expect(label?.hidden).toBe(true);
    expect(label?.textContent).toBe('');
    expect(label?.style.backgroundColor).toBe('');
  });

  it('hides the label before any address is loaded', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    expect(addressHostLabel(toolbar)?.hidden).toBe(true);
  });

  it('re-derives the label when the host list arrives after the address (snapshot reload)', () => {
    const toolbar = build();
    stateListeners[0]?.(navigationState('https://author.example/'));
    expect(addressHostLabel(toolbar)?.hidden).toBe(true);

    toolbar.setHostOptions([authorHost]);

    const label = addressHostLabel(toolbar);
    expect(label?.hidden).toBe(false);
    expect(label?.textContent).toBe('Author');
    expect(label?.style.backgroundColor).toBe('rgb(38, 128, 235)');
  });

  it('switches to dark text on a light host colour', () => {
    const toolbar = build();
    toolbar.setHostOptions([{ ...authorHost, label: 'Staging', colorCss: '#dfbf00' }]);

    stateListeners[0]?.(navigationState('https://author.example/'));

    const label = addressHostLabel(toolbar);
    expect(label?.textContent).toBe('Staging');
    expect(label?.style.color).toBe('rgb(46, 46, 46)');
  });

  it('clears a previously matched label when a later address matches nothing', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);
    stateListeners[0]?.(navigationState('https://author.example/'));
    expect(addressHostLabel(toolbar)?.hidden).toBe(false);

    stateListeners[0]?.(navigationState('https://unknown.example/'));

    expect(addressHostLabel(toolbar)?.hidden).toBe(true);
    expect(addressHostLabel(toolbar)?.textContent).toBe('');
  });

  it('clamps the label to the field width, reserving room for the address', () => {
    const toolbar = build();
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement;
    address.getBoundingClientRect = () => ({ width: 200 }) as DOMRect;
    toolbar.setHostOptions([authorHost]);

    stateListeners[0]?.(navigationState('https://author.example/'));

    // 200 - left inset - gap - field padding - reserved address slice = 136.
    expect(addressHostLabel(toolbar)?.style.maxInlineSize).toBe('136px');
  });

  it('shrinks the label further on a narrower field, down to zero', () => {
    const toolbar = build();
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement;
    toolbar.setHostOptions([authorHost]);

    address.getBoundingClientRect = () => ({ width: 120 }) as DOMRect;
    stateListeners[0]?.(navigationState('https://author.example/'));
    expect(addressHostLabel(toolbar)?.style.maxInlineSize).toBe('56px');

    address.getBoundingClientRect = () => ({ width: 60 }) as DOMRect;
    stateListeners[0]?.(navigationState('https://author.example/'));
    expect(addressHostLabel(toolbar)?.style.maxInlineSize).toBe('0px');
  });

  it('keeps the CSS upper bound before the field has a measurable width', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    stateListeners[0]?.(navigationState('https://author.example/'));

    expect(addressHostLabel(toolbar)?.style.maxInlineSize).toBe('');
  });
});

describe('createBrowserToolbar address type-ahead', () => {
  const authorHost: HostOption = {
    id: AUTHOR_SERVER_ID,
    label: 'Author',
    origin: 'https://author.example',
    colorCss: '#2680eb',
  };

  function address(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement & {
    value: string;
  } {
    return toolbar.element.querySelector('.address-bar') as HTMLElement & { value: string };
  }

  function typeInto(
    toolbar: ReturnType<typeof createBrowserToolbar>,
    value: string,
  ): HTMLElement & { value: string } {
    const field = address(toolbar);
    field.value = value;
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true, composed: true }));
    return field;
  }

  it('completes a typed address prefix with the matching host origin', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    const field = typeInto(toolbar, 'https://auth');

    expect(field.value).toBe('https://author.example');
  });

  it('completes a typed label prefix to the host origin', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    expect(typeInto(toolbar, 'Auth').value).toBe('https://author.example');
  });

  it('leaves a non-matching or already-complete value untouched', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    expect(typeInto(toolbar, 'nope').value).toBe('nope');
    expect(typeInto(toolbar, 'https://author.example').value).toBe('https://author.example');
  });

  it('does not complete when no hosts are configured', () => {
    const toolbar = build();

    expect(typeInto(toolbar, 'https://auth').value).toBe('https://auth');
  });

  it('completes with a label block shown for the matched host', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    typeInto(toolbar, 'Auth');

    expect(addressHostLabel(toolbar)?.hidden).toBe(false);
    expect(addressHostLabel(toolbar)?.textContent).toBe('Author');
  });

  /**
   * Drives one edit the way a real browser does: the field already holds the
   * post-edit text, and the native `input` event carries its `inputType` (and
   * `isComposing`). A bare `typeInto` cannot express a deletion.
   */
  function editInto(
    toolbar: ReturnType<typeof createBrowserToolbar>,
    value: string,
    init: { inputType: string; isComposing?: boolean },
  ): HTMLElement & { value: string } {
    const field = address(toolbar);
    field.value = value;
    const event = new dom.window.Event('input', { bubbles: true, composed: true });
    Object.defineProperty(event, 'inputType', { value: init.inputType });
    Object.defineProperty(event, 'isComposing', { value: init.isComposing ?? false });
    field.dispatchEvent(event);
    return field;
  }

  it('does not re-append the completion when the user presses Backspace', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    // Completion shown, then Backspace removes the inferred tail; the shorter
    // value is still a host prefix, so naively re-inferring would restore it.
    expect(typeInto(toolbar, 'https://auth').value).toBe('https://author.example');
    const field = editInto(toolbar, 'https://autho', { inputType: 'deleteContentBackward' });

    expect(field.value).toBe('https://autho');
  });

  it('does not re-append the completion when the user presses Delete', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    const field = editInto(toolbar, 'https://author.', { inputType: 'deleteContentForward' });

    expect(field.value).toBe('https://author.');
  });

  it('does not re-append on a word-delete, cut, drag or undo/redo either', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    for (const inputType of [
      'deleteWordBackward',
      'deleteWordForward',
      'deleteByCut',
      'deleteByDrag',
      'historyUndo',
      'historyRedo',
    ]) {
      expect(editInto(toolbar, 'https://autho', { inputType }).value).toBe('https://autho');
    }
  });

  it('still completes for a textual insertion', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    expect(editInto(toolbar, 'https://auth', { inputType: 'insertText' }).value).toBe(
      'https://author.example',
    );
    expect(editInto(toolbar, 'Auth', { inputType: 'insertFromPaste' }).value).toBe(
      'https://author.example',
    );
  });

  it('does not complete while an IME composition is in progress', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    const field = editInto(toolbar, 'https://auth', {
      inputType: 'insertCompositionText',
      isComposing: true,
    });

    expect(field.value).toBe('https://auth');
  });

  it('still refreshes the paired host label on a deletion', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    editInto(toolbar, 'https://author.example', { inputType: 'deleteContentBackward' });
    expect(addressHostLabel(toolbar)?.hidden).toBe(false);

    editInto(toolbar, 'https://other.example', { inputType: 'deleteContentBackward' });
    expect(addressHostLabel(toolbar)?.hidden).toBe(true);
  });

  it('keeps the host chip while backspacing through the host prefix, without blinking', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    editInto(toolbar, 'https://author.example', { inputType: 'insertText' });
    expect(addressHostLabel(toolbar)?.hidden).toBe(false);

    // Each partial is still a prefix of the host's origin, so the chip stays
    // put instead of flickering off on every Backspace.
    for (const partial of ['https://author.exampl', 'https://auth', 'https://', 'https:']) {
      editInto(toolbar, partial, { inputType: 'deleteContentBackward' });
      expect(addressHostLabel(toolbar)?.hidden).toBe(false);
      expect(addressHostLabel(toolbar)?.textContent).toBe('Author');
    }

    // It hides only once the value can no longer be that host.
    editInto(toolbar, 'https://other.example', { inputType: 'deleteContentBackward' });
    expect(addressHostLabel(toolbar)?.hidden).toBe(true);
  });
});

describe('createBrowserToolbar home button', () => {
  it('is the leftmost control and fires onHomeClick', () => {
    const onHomeClick = vi.fn();
    const toolbar = createBrowserToolbar({ onHostsPickerClick: () => {}, onHomeClick });

    const home = toolbar.element.querySelector<HTMLElement>(byTestId('browser-home'));
    expect(home).not.toBeNull();
    expect(toolbar.element.firstElementChild).toBe(home);

    home?.click();
    expect(onHomeClick).toHaveBeenCalledTimes(1);
  });
});

describe('createBrowserToolbar forced home screen', () => {
  const addressOf = (toolbar: ReturnType<typeof createBrowserToolbar>): { value: string } =>
    toolbar.element.querySelector('#browser-address-bar') as unknown as { value: string };

  function withDocument(): ReturnType<typeof createBrowserToolbar> {
    const toolbar = build();
    stateListeners[0]?.({
      url: 'https://author.example/content/page.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    });
    return toolbar;
  }

  it('blanks the address and disables Back/Forward while shown, restoring both on dismiss', () => {
    const toolbar = withDocument();
    const back = toolbar.element.querySelector(byTestId('browser-back')) as HTMLElement;
    const forward = toolbar.element.querySelector(byTestId('browser-forward')) as HTMLElement;

    expect(addressOf(toolbar).value).toBe('https://author.example/content/page.html');
    expect(back.hasAttribute('disabled')).toBe(false);

    toolbar.setHomeShown(true);
    expect(addressOf(toolbar).value).toBe('');
    expect(back.hasAttribute('disabled')).toBe(true);
    expect(forward.hasAttribute('disabled')).toBe(true);

    toolbar.setHomeShown(false);
    expect(addressOf(toolbar).value).toBe('https://author.example/content/page.html');
    expect(back.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the address blank while shown even as the hidden page navigates itself', () => {
    const toolbar = withDocument();
    toolbar.setHomeShown(true);

    // The covered page keeps loading and navigating behind the veil; that must
    // not repopulate the (blank) address bar, but its latest URL is remembered
    // for the moment the veil is dismissed.
    stateListeners[0]?.({
      url: 'https://author.example/content/next.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    });
    expect(addressOf(toolbar).value).toBe('');

    toolbar.setHomeShown(false);
    expect(addressOf(toolbar).value).toBe('https://author.example/content/next.html');
  });
});

describe('createBrowserToolbar agent-pane toggle', () => {
  function toggleButton(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement {
    const button = toolbar.element.querySelector<HTMLElement>(byTestId('agent-pane-toggle'));
    if (!button) throw new Error('agent-pane toggle button not found');
    return button;
  }

  function buildWithToggle(): {
    toolbar: ReturnType<typeof createBrowserToolbar>;
    onToggle: ReturnType<typeof vi.fn>;
  } {
    const onToggle = vi.fn();
    return {
      toolbar: createBrowserToolbar({
        onHostsPickerClick: () => {},
        onHomeClick: () => {},
        onToggleAgentPane: onToggle,
      }),
      onToggle,
    };
  }

  it("renders the toggle as the toolbar's right-most control, starting selected", () => {
    const { toolbar } = buildWithToggle();
    const button = toggleButton(toolbar);

    // Right-most: nothing else follows it in the toolbar.
    expect(toolbar.element.lastElementChild).toBe(button);
    expect(button.getAttribute('title')?.length).toBeGreaterThan(0);
    expect(button.getAttribute('aria-label')).toBe(button.getAttribute('title'));
    expect(button.hasAttribute('selected')).toBe(true);
    expect(button.children.length).toBeGreaterThan(0);
    // Icon-only: no text content of its own.
    expect(button.textContent).toBe('');
  });

  it('calls back when activated', () => {
    const { toolbar, onToggle } = buildWithToggle();
    toggleButton(toolbar).click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('drops `selected` and renames itself when the pane is hidden, and back', () => {
    const { toolbar } = buildWithToggle();
    const button = toggleButton(toolbar);
    const openLabel = button.getAttribute('title');

    toolbar.setAgentPaneOpen(false);
    const closedLabel = button.getAttribute('title');
    expect(closedLabel?.length).toBeGreaterThan(0);
    expect(closedLabel).not.toBe(openLabel);
    expect(button.getAttribute('aria-label')).toBe(closedLabel);
    expect(button.hasAttribute('selected')).toBe(false);
    // One fixed glyph: the state is carried by `selected`, not an icon swap.
    expect(button.children.length).toBeGreaterThan(0);

    toolbar.setAgentPaneOpen(true);
    expect(button.getAttribute('title')).toBe(openLabel);
    expect(button.getAttribute('aria-label')).toBe(openLabel);
    expect(button.hasAttribute('selected')).toBe(true);
    expect(button.children.length).toBeGreaterThan(0);
  });
});

describe('createBrowserToolbar open-in-external-browser button', () => {
  function externalButton(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement {
    const button = toolbar.element.querySelector<HTMLElement>(byTestId('browser-external'));
    if (!button) throw new Error('open-in-external-browser button not found');
    return button;
  }

  function typeAddress(
    toolbar: ReturnType<typeof createBrowserToolbar>,
    value: string,
  ): HTMLElement & { value: string } {
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    address.value = value;
    address.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    return address;
  }

  it('renders labelless, titled, icon-led, disabled, and immediately before the agent-pane toggle', () => {
    const toolbar = build();
    const button = externalButton(toolbar);

    // Labelless, like the rest of the toolbar buttons: no text, just the icon.
    expect(button.textContent).toBe('');
    expect(button.children.length).toBeGreaterThan(0);
    expect(button.getAttribute('title')?.length).toBeGreaterThan(0);
    expect(button.getAttribute('aria-label')).toBe(button.getAttribute('title'));
    // Disabled until a valid URL is in the address field.
    expect(button.hasAttribute('disabled')).toBe(true);

    // Placed after the address group, before the last control (agent toggle).
    const last = toolbar.element.lastElementChild;
    expect(last).not.toBe(button);
    expect(button.nextElementSibling).toBe(last);
  });

  it('enables only while the address field holds an absolute http(s) URL', () => {
    const toolbar = build();
    const button = externalButton(toolbar);

    typeAddress(toolbar, 'https://author.example/content/page.html');
    expect(button.hasAttribute('disabled')).toBe(false);

    typeAddress(toolbar, 'author.example/content/page.html');
    expect(button.hasAttribute('disabled')).toBe(true);

    typeAddress(toolbar, 'javascript:alert(1)');
    expect(button.hasAttribute('disabled')).toBe(true);

    typeAddress(toolbar, '');
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('follows the live navigation state into the address field', () => {
    const toolbar = build();
    const button = externalButton(toolbar);

    stateListeners[0]?.({
      url: 'https://author.example/content/page.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    });
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('opens the trimmed address field value via browser:openExternal', async () => {
    const toolbar = build();
    const address = typeAddress(toolbar, '  https://author.example/content/page.html  ');

    externalButton(toolbar).click();

    await vi.waitFor(() => {
      expect(browser.openExternal).toHaveBeenCalledWith({
        url: 'https://author.example/content/page.html',
      });
    });
    // The address field itself is untouched by the click.
    expect(address.value).toBe('  https://author.example/content/page.html  ');
  });

  it('surfaces an open failure as an error banner', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    browser.openExternal.mockResolvedValueOnce({
      ok: false,
      error: { code: 'open_external_failed', message: 'no handler registered' },
    });
    typeAddress(toolbar, 'https://author.example/');

    externalButton(toolbar).click();

    await vi.waitFor(() => {
      expect(message.textContent).toContain('no handler registered');
    });
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.hasAttribute('dismissible')).toBe(true);
  });
});

describe('createBrowserToolbar edit-mode toggle', () => {
  function editButton(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement {
    const button = toolbar.element.querySelector<HTMLElement>('.browser-toolbar__edit-toggle');
    if (!button) throw new Error('edit-mode toggle button not found');
    return button;
  }

  function addressValue(toolbar: ReturnType<typeof createBrowserToolbar>): string {
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    return address.value;
  }

  /** Reports the page the view is showing, which is what the toggle derives from. */
  function pushPage(url: string): void {
    stateListeners[0]?.({
      url,
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    });
  }

  it('renders icon-led and hidden by default, right after the address bar', () => {
    const toolbar = build();
    const button = editButton(toolbar);

    // Labelless, like the rest of the toolbar buttons: icon only.
    expect(button.textContent).toBe('');
    // An icon in the icon slot (queried by slot, not tag, so the assertion
    // does not depend on the element being registered in jsdom).
    expect(button.querySelector('[slot="icon"]')).not.toBeNull();
    expect(button.getAttribute('title')?.length).toBeGreaterThan(0);
    expect(button.getAttribute('aria-label')).toBe(button.getAttribute('title'));
    // Hidden (not merely disabled) until an editable page loads.
    expect(button.hasAttribute('hidden')).toBe(true);
    expect(button.hasAttribute('selected')).toBe(false);

    // Immediately after the address group, before "Open in external browser".
    const addressGroup = toolbar.element.querySelector('.browser-toolbar__address-group');
    expect(button.previousElementSibling).toBe(addressGroup);
    expect(button.nextElementSibling).toBe(
      toolbar.element.querySelector(byTestId('browser-external')),
    );
  });

  it('shows and stays off for a /content .html page in the web-content view', () => {
    const toolbar = build();
    const button = editButton(toolbar);
    const offLabel = button.getAttribute('title');

    pushPage('https://author.example/content/site/page.html');

    expect(button.hasAttribute('hidden')).toBe(false);
    expect(button.hasAttribute('selected')).toBe(false);
    expect(button.getAttribute('title')).toBe(offLabel);
  });

  it('turns on for a page already open in the editor', () => {
    const toolbar = build();
    const button = editButton(toolbar);
    pushPage('https://author.example/content/site/page.html');
    const offLabel = button.getAttribute('title');

    pushPage('https://author.example/editor.html/content/site/page.html');

    expect(button.hasAttribute('hidden')).toBe(false);
    expect(button.hasAttribute('selected')).toBe(true);
    expect(button.getAttribute('title')?.length).toBeGreaterThan(0);
    expect(button.getAttribute('title')).not.toBe(offLabel);
    expect(button.getAttribute('aria-label')).toBe(button.getAttribute('title'));
  });

  it('navigates to the editor URL when clicked from the web-content view', async () => {
    const toolbar = build();
    const button = editButton(toolbar);
    pushPage('https://author.example/content/site/page.html');

    button.click();

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledWith(
        'https://author.example/editor.html/content/site/page.html',
      );
    });
    expect(addressValue(toolbar)).toBe('https://author.example/editor.html/content/site/page.html');
  });

  it('navigates back to the web-content visitor URL when clicked from the editor', async () => {
    const toolbar = build();
    const button = editButton(toolbar);
    pushPage('https://author.example/editor.html/content/site/page.html');

    button.click();

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledWith(
        'https://author.example/content/site/page.html?wcmmode=disabled',
      );
    });
    expect(addressValue(toolbar)).toBe(
      'https://author.example/content/site/page.html?wcmmode=disabled',
    );
  });

  it('turns on for a Cloud Service shell editor and untoggles out of the shell', async () => {
    const toolbar = build();
    const button = editButton(toolbar);
    pushPage('https://author.example/ui#/aem/editor.html/content/site/page.html?appId=aemshell');

    expect(button.hasAttribute('hidden')).toBe(false);
    expect(button.hasAttribute('selected')).toBe(true);

    button.click();

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledWith(
        'https://author.example/content/site/page.html?wcmmode=disabled',
      );
    });
    expect(addressValue(toolbar)).toBe(
      'https://author.example/content/site/page.html?wcmmode=disabled',
    );
  });

  it('drops wcmmode=disabled when toggling into the editor', async () => {
    const toolbar = build();
    const button = editButton(toolbar);
    pushPage('https://author.example/content/site/page.html?wcmmode=disabled');

    button.click();

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledWith(
        'https://author.example/editor.html/content/site/page.html',
      );
    });
    expect(addressValue(toolbar)).toBe('https://author.example/editor.html/content/site/page.html');
  });

  it('carries the hold affordance for its long press', () => {
    const toolbar = build();
    expect(editButton(toolbar).hasAttribute('hold-affordance')).toBe(true);
  });

  it('opens the web-content visitor view on a long press from the web-content view', async () => {
    const toolbar = build();
    const button = editButton(toolbar);
    pushPage('https://author.example/content/site/page.html');

    button.dispatchEvent(new dom.window.CustomEvent('longpress', { bubbles: true }));

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledWith(
        'https://author.example/content/site/page.html?wcmmode=disabled',
      );
    });
    expect(addressValue(toolbar)).toBe(
      'https://author.example/content/site/page.html?wcmmode=disabled',
    );
  });

  it('opens the web-content visitor view on a long press from the editor', async () => {
    const toolbar = build();
    const button = editButton(toolbar);
    pushPage('https://author.example/editor.html/content/site/page.html');

    button.dispatchEvent(new dom.window.CustomEvent('longpress', { bubbles: true }));

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledWith(
        'https://author.example/content/site/page.html?wcmmode=disabled',
      );
    });
  });

  it('swallows the click that follows a long press, then toggles on the next click', async () => {
    const toolbar = build();
    const button = editButton(toolbar);
    pushPage('https://author.example/content/site/page.html');

    button.dispatchEvent(new dom.window.CustomEvent('longpress', { bubbles: true }));
    // Spectrum still delivers the release's click; it must not re-toggle.
    button.click();

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
    expect(browser.navigate).toHaveBeenCalledWith(
      'https://author.example/content/site/page.html?wcmmode=disabled',
    );

    // The page has landed on the visitor view; the next ordinary click toggles
    // into the editor as usual.
    pushPage('https://author.example/content/site/page.html?wcmmode=disabled');
    button.click();

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(2);
    });
    expect(browser.navigate).toHaveBeenLastCalledWith(
      'https://author.example/editor.html/content/site/page.html',
    );
  });

  it('treats a later click as a click when the long press had no release on it', () => {
    const toolbar = build();
    const button = editButton(toolbar);
    pushPage('https://author.example/content/site/page.html');

    // The pointer was carried off the button before it came up, so no click
    // followed the long press; the next interaction starts with pointerdown.
    button.dispatchEvent(new dom.window.CustomEvent('longpress', { bubbles: true }));
    button.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    button.click();

    // The long press's own navigation plus this click's toggle.
    expect(browser.navigate).toHaveBeenCalledTimes(2);
    expect(browser.navigate).toHaveBeenLastCalledWith(
      'https://author.example/editor.html/content/site/page.html',
    );
  });

  it('does nothing on a long press while hidden', () => {
    const toolbar = build();

    editButton(toolbar).dispatchEvent(new dom.window.CustomEvent('longpress', { bubbles: true }));

    expect(browser.navigate).not.toHaveBeenCalled();
  });

  it('hides for a DAM asset, a non-.html resource, or no page at all', () => {
    const toolbar = build();
    const button = editButton(toolbar);

    pushPage('https://author.example/content/dam/site/page.html');
    expect(button.hasAttribute('hidden')).toBe(true);

    pushPage('https://author.example/content/site/page.json');
    expect(button.hasAttribute('hidden')).toBe(true);

    pushPage('https://author.example/');
    expect(button.hasAttribute('hidden')).toBe(true);
  });

  it('does nothing when clicked while hidden', () => {
    const toolbar = build();
    editButton(toolbar).click();
    expect(browser.navigate).not.toHaveBeenCalled();
  });

  it('follows the loaded page, not the address field text', () => {
    const toolbar = build();
    const button = editButton(toolbar);
    pushPage('https://author.example/');
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };

    // Typing a content URL without navigating must not reveal the toggle: it
    // describes the page that is open, not a target the user is considering.
    address.value = 'https://author.example/content/site/page.html';
    address.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    expect(button.hasAttribute('hidden')).toBe(true);
    expect(button.hasAttribute('selected')).toBe(false);
  });

  it('hides while the forced home veil covers the page, and restores on dismiss', () => {
    const toolbar = build();
    const button = editButton(toolbar);
    pushPage('https://author.example/content/site/page.html');
    expect(button.hasAttribute('hidden')).toBe(false);

    // The veil is not the page: like Back/Forward, the toggle acts on the
    // covered page rather than what is on screen, so it goes hidden.
    toolbar.setHomeShown(true);
    expect(button.hasAttribute('hidden')).toBe(true);

    toolbar.setHomeShown(false);
    expect(button.hasAttribute('hidden')).toBe(false);
  });
});

describe('createBrowserToolbar host picker selection (navigateToHost)', () => {
  const author = hostOption();
  const cloud = hostOption({
    id: newServerId(() => 'server-cloud'),
    label: 'Acme Cloud',
    origin: 'https://acme.adobe.com',
  });

  function pushPage(url: string, hasDocument = true): void {
    stateListeners[0]?.({
      url,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      hasDocument,
    });
  }

  const addressOf = (toolbar: ReturnType<typeof createBrowserToolbar>): { value: string } =>
    toolbar.element.querySelector('#browser-address-bar') as unknown as { value: string };

  function loaded(url: string): ReturnType<typeof createBrowserToolbar> {
    const toolbar = build();
    toolbar.setHostOptions([author, cloud]);
    pushPage(url);
    return toolbar;
  }

  it('carries the open page to the picked host and shows it in the address bar', () => {
    const toolbar = loaded('https://author.example/content/acme/us/en/home.html?wcmmode=disabled');

    toolbar.navigateToHost(cloud.origin);

    const expected = 'https://acme.adobe.com/content/acme/us/en/home.html?wcmmode=disabled';
    expect(browser.navigate).toHaveBeenCalledWith(expected);
    expect(addressOf(toolbar).value).toBe(expected);
  });

  it('opens the bare origin for a page outside the allowlist', () => {
    const toolbar = loaded('https://author.example/libs/granite/core/content/login.html');

    toolbar.navigateToHost(cloud.origin);

    expect(browser.navigate).toHaveBeenCalledWith('https://acme.adobe.com');
  });

  it('opens the root when the host picked is the one already open', () => {
    const toolbar = loaded('https://author.example/content/acme/us/en/home.html');

    toolbar.navigateToHost(author.origin);

    expect(browser.navigate).toHaveBeenCalledWith('https://author.example');
  });

  it('opens the bare origin while no page is loaded', () => {
    const toolbar = build();
    toolbar.setHostOptions([author, cloud]);

    toolbar.navigateToHost(cloud.origin);

    expect(browser.navigate).toHaveBeenCalledWith('https://acme.adobe.com');

    browser.navigate.mockClear();
    pushPage('https://author.example/content/acme/home.html', false);
    toolbar.navigateToHost(cloud.origin);
    expect(browser.navigate).toHaveBeenCalledWith('https://acme.adobe.com');
  });

  it('opens the bare origin while the home veil covers the page', () => {
    const toolbar = loaded('https://author.example/content/acme/home.html');
    toolbar.setHomeShown(true);

    toolbar.navigateToHost(cloud.origin);

    expect(browser.navigate).toHaveBeenCalledWith('https://acme.adobe.com');
  });

  it('opens the bare origin while an error row is showing', async () => {
    const toolbar = loaded('https://author.example/content/acme/home.html');
    browser.navigate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'network_error', message: 'Timed out', errorCode: 'ERR_TIMED_OUT' },
    });
    toolbar.navigateTo('https://dead.example/');
    await vi.waitFor(() => {
      expect(findMessage(toolbar).hasAttribute('open')).toBe(true);
    });
    browser.navigate.mockClear();

    toolbar.navigateToHost(cloud.origin);

    expect(browser.navigate).toHaveBeenCalledWith('https://acme.adobe.com');
  });

  it('leaves typing an origin in the address bar as the way to open a host root', () => {
    const toolbar = loaded('https://author.example/content/acme/home.html');

    toolbar.navigateTo(cloud.origin);

    expect(browser.navigate).toHaveBeenCalledWith('https://acme.adobe.com');
  });
});

describe('createBrowserToolbar shortcut targets', () => {
  it('Refresh runs the Refresh control action (reload when the address bar matches)', () => {
    const toolbar = build();

    toolbar.refresh();

    expect(browser.reload).toHaveBeenCalledTimes(1);
  });

  it('Back and Forward run their control', () => {
    const toolbar = build();

    toolbar.goBack();
    toolbar.goForward();

    expect(browser.goBack).toHaveBeenCalledTimes(1);
    expect(browser.goForward).toHaveBeenCalledTimes(1);
  });

  it('focuses the address bar', () => {
    const toolbar = build();
    const address = toolbar.element.querySelector('#browser-address-bar') as HTMLElement;
    const focus = vi.spyOn(address, 'focus');

    toolbar.focusAddress();

    expect(focus).toHaveBeenCalledTimes(1);
  });
});
