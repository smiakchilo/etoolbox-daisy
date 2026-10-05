import { JSDOM } from 'jsdom';
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
let browser: FakeDaisyBrowser;
let settings: FakeDaisySettings;
let stateListeners: Array<(state: BrowserNavigationState) => void>;
let switchListeners: Array<(state: BrowserSwitchState) => void>;
let blockedListeners: Array<(info: CertificateBlockedInfo) => void>;

const AUTHOR_SERVER_ID = newServerId(() => 'server-a');

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;

beforeEach(() => {
  dom = new JSDOM();
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
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
});

afterEach(() => {
  vi.useRealTimers();
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

function build(): ReturnType<typeof createBrowserToolbar> {
  return createBrowserToolbar({ onHostsPickerClick: () => {} });
}

function loadingState(isLoading: boolean): BrowserNavigationState {
  return {
    url: 'https://author.example/content/page.html',
    canGoBack: true,
    canGoForward: false,
    isLoading,
  };
}

function findMessage(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement {
  const message = toolbar.messageElement;
  if (!message) throw new Error('toolbar.messageElement missing');
  return message;
}

function findNavButton(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement {
  const button = toolbar.element.querySelector('[aria-label="Refresh"], [aria-label="Stop"]');
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
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');

    vi.advanceTimersByTime(1000);

    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent).toBe('Loading\u2026');
    expect(message.classList.contains(BANNER_ROW_LOADING_CLASS)).toBe(true);
    // The loading presentation is not dismissible and ends in a progress line.
    expect(message.hasAttribute('dismissible')).toBe(false);
    expect(message.querySelector('.banner-row__progress')).not.toBeNull();
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');
    // The stop affordance is a cross, not the media "stop playback" glyph.
    expect(findNavButton(toolbar).querySelector('sp-icon-cross600')).not.toBeNull();
    expect(browser.reload).toHaveBeenCalledTimes(1);

    stateListeners[0]?.(loadingState(false));
    // Closing collapses the row: `open`/children stay until the animation
    // finishes, then the DOM is torn down.
    expect(message.hasAttribute('open')).toBe(true);
    vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
    expect(message.hasAttribute('open')).toBe(false);
    expect(message.textContent).toBe('');
    expect(message.querySelector('.banner-row__progress')).toBeNull();
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');
  });

  it('treats an in-webview navigation exactly like a chrome-initiated one', () => {
    vi.useFakeTimers();
    const toolbar = build();
    const message = findMessage(toolbar);

    // No toolbar action started this load - the page did (a link or button).
    stateListeners[0]?.(loadingState(true));
    // The Refresh→Stop swap is immediate; the banner waits out the debounce.
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');
    expect(message.hasAttribute('open')).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent).toBe('Loading\u2026');

    stateListeners[0]?.(loadingState(false));
    vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
    expect(message.hasAttribute('open')).toBe(false);
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');
  });

  it('arms the loading presentation from Back/Forward too', () => {
    vi.useFakeTimers();
    const toolbar = build();
    const message = findMessage(toolbar);
    // Back is the Refresh/Stop button's sibling with aria-label "Back".
    const back = toolbar.element.querySelector('[aria-label="Back"]') as HTMLElement;
    if (!back) throw new Error('back button not found');

    back.click();
    expect(browser.goBack).toHaveBeenCalledTimes(1);
    stateListeners[0]?.(loadingState(true));
    expect(message.hasAttribute('open')).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(true);
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');

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
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');
    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent).toBe('Loading\u2026');
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
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');
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
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');

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
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');
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
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');

    // The load persists past the debounce, so the banner appears too.
    vi.advanceTimersByTime(1000);
    expect(message.hasAttribute('open')).toBe(true);
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');

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
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');
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
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');

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
    expect(message.textContent).toBe('Loading\u2026');

    // The load starts; then the switch controller reports done while the page
    // is still loading — the banner must not close early (the load is still in
    // progress).
    stateListeners[0]?.(loadingState(true));
    switchListeners[0]?.({ switching: false });
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent).toBe('Loading\u2026');
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
    const back = toolbar.element.querySelector('[aria-label="Back"]') as HTMLElement;

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
    // `aemBrowserView.ts`), so the field keeps showing it while the load runs.
    stateListeners[0]?.({
      url: 'https://author.example/',
      canGoBack: false,
      canGoForward: false,
      isLoading: true,
    });
    expect(address.value).toBe('https://author.example/');

    // A redirect while still loading updates the field immediately.
    stateListeners[0]?.({
      url: 'https://author.example/content/page.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: true,
    });
    expect(address.value).toBe('https://author.example/content/page.html');

    // The completed load's final URL is applied too.
    stateListeners[0]?.({
      url: 'https://author.example/content/page.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
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
    expect(message.textContent).toBe('Loading\u2026');
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
    expect(message.textContent).toBe('Loading\u2026');
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
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');
  });
});

describe('createBrowserToolbar navigation failure recovery', () => {
  function buildWith(
    overrides: {
      readonly onHostsPickerRequest?: () => void;
    } = {},
  ): ReturnType<typeof createBrowserToolbar> {
    return createBrowserToolbar({
      onHostsPickerClick: () => {},
      ...(overrides.onHostsPickerRequest !== undefined
        ? { onHostsPickerRequest: overrides.onHostsPickerRequest }
        : {}),
    });
  }

  /** Reports the page the view is showing, so it can be remembered as "previous". */
  function pushPage(url: string): void {
    stateListeners[0]?.({ url, canGoBack: true, canGoForward: false, isLoading: false });
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
    expect(reload?.textContent).toBe('Reload');
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
    expect(message.querySelector('sp-action-button')?.textContent).toBe('Reload');
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
      });
    }
    expect(message.querySelector('sp-action-button')).toBe(reload);
    expect(message.textContent).toContain('Timed out reaching');
  });

  it('asks for the hosts picker when nothing was displayed before the failure', async () => {
    const onHostsPickerRequest = vi.fn();
    const toolbar = buildWith({ onHostsPickerRequest });
    browser.navigate.mockResolvedValueOnce(TIMEOUT_ERROR);

    typeAndSubmit(toolbar, 'https://dead.example/');

    await vi.waitFor(() => {
      expect(onHostsPickerRequest).toHaveBeenCalledTimes(1);
    });
    // No restore attempt: only the original navigation was issued.
    expect(browser.navigate).toHaveBeenCalledTimes(1);
  });

  it('shows the error row (with Reload) on a failed reload, without the hosts picker', async () => {
    const onHostsPickerRequest = vi.fn();
    const toolbar = buildWith({ onHostsPickerRequest });
    const message = findMessage(toolbar);
    pushPage('https://author.example/');
    browser.reload.mockResolvedValueOnce(TIMEOUT_ERROR);

    // Refresh with the address matching the loaded page issues a reload.
    findNavButton(toolbar).click();

    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(true);
    });
    expect(message.querySelector('sp-action-button')?.textContent).toBe('Reload');
    // A reload's "previous page" is the very page that just failed, so there
    // is nothing to fall back to and the picker is not forced on the user.
    expect(onHostsPickerRequest).not.toHaveBeenCalled();
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
  it('renders the prompt with the fixed copy and an enabled OK when a configured server matches the blocked origin', () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    toolbar.setHostOptions([
      hostOption(),
      hostOption({ id: newServerId(() => 'server-b'), label: 'Other' }),
    ]);

    blockedListeners[0]?.(BLOCKED_INFO);

    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent).toContain('Untrusted certificate. Press OK to allow');
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

    findPromptOk(toolbar).click();
    await vi.waitFor(() => {
      expect(message.textContent).toContain('no longer exists');
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
    expect(message.textContent).toContain('Unknown host. Press OK to add it');
    // The origin is visible in the address bar above the banner; the copy
    // must not repeat it (noise, and invites reading the banner instead of
    // the real navigated address).
    expect(message.textContent).not.toContain('https://unknown.example');
    // Exactly one accepting action: an `sp-action-button` (never an accent
    // `sp-button` - no blue fill). Cancel is the banner's dismiss cross.
    const okButtons = message.querySelectorAll('sp-action-button');
    expect(okButtons).toHaveLength(1);
    expect(okButtons[0]?.textContent).toBe('OK');
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
      expect(message.textContent).toContain("Couldn't add");
    });
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent).toContain('settings file could not be written');
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
    expect(message.textContent).toContain('Unknown host. Press OK to add it');
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
    expect(message.textContent).toContain('Unknown host. Press OK to add it');
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

function addressSwatch(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement | null {
  return toolbar.element.querySelector<HTMLElement>('.address-bar__swatch');
}

describe('createBrowserToolbar address swatch', () => {
  const authorHost: HostOption = {
    id: AUTHOR_SERVER_ID,
    label: 'Author',
    origin: 'https://author.example',
    colorCss: '#2680eb',
  };

  function navigationState(url: string): BrowserNavigationState {
    return { url, canGoBack: false, canGoForward: false, isLoading: false };
  }

  it('shows the matching host colour once a URL on that origin is loaded', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    stateListeners[0]?.(navigationState('https://author.example/content/page.html'));

    expect(addressSwatch(toolbar)?.style.backgroundColor).toBe('rgb(38, 128, 235)');
    expect(addressSwatch(toolbar)?.classList.contains('address-bar__swatch--known')).toBe(true);
  });

  it('leaves the inline colour unset (CSS default gray) when the address matches no host', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    stateListeners[0]?.(navigationState('https://unknown.example/content/page.html'));

    expect(addressSwatch(toolbar)?.style.backgroundColor).toBe('');
    expect(addressSwatch(toolbar)?.classList.contains('address-bar__swatch--known')).toBe(false);
  });

  it('leaves the inline colour unset before any address is loaded', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);

    expect(addressSwatch(toolbar)?.style.backgroundColor).toBe('');
    expect(addressSwatch(toolbar)?.classList.contains('address-bar__swatch--known')).toBe(false);
  });

  it('re-derives the swatch when the host list arrives after the address (snapshot reload)', () => {
    const toolbar = build();
    stateListeners[0]?.(navigationState('https://author.example/'));
    expect(addressSwatch(toolbar)?.style.backgroundColor).toBe('');

    toolbar.setHostOptions([authorHost]);

    expect(addressSwatch(toolbar)?.style.backgroundColor).toBe('rgb(38, 128, 235)');
    expect(addressSwatch(toolbar)?.classList.contains('address-bar__swatch--known')).toBe(true);
  });

  it('clears a previously matched colour when a later address matches nothing', () => {
    const toolbar = build();
    toolbar.setHostOptions([authorHost]);
    stateListeners[0]?.(navigationState('https://author.example/'));
    expect(addressSwatch(toolbar)?.style.backgroundColor).toBe('rgb(38, 128, 235)');

    stateListeners[0]?.(navigationState('https://unknown.example/'));

    expect(addressSwatch(toolbar)?.style.backgroundColor).toBe('');
    expect(addressSwatch(toolbar)?.classList.contains('address-bar__swatch--known')).toBe(false);
  });
});

describe('createBrowserToolbar agent-pane toggle', () => {
  function toggleButton(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement {
    const button = toolbar.element.querySelector<HTMLElement>(
      '[title="Close Agent"], [title="Open Agent"]',
    );
    if (!button) throw new Error('agent-pane toggle button not found');
    return button;
  }

  function buildWithToggle(): {
    toolbar: ReturnType<typeof createBrowserToolbar>;
    onToggle: ReturnType<typeof vi.fn>;
  } {
    const onToggle = vi.fn();
    return {
      toolbar: createBrowserToolbar({ onHostsPickerClick: () => {}, onToggleAgentPane: onToggle }),
      onToggle,
    };
  }

  it('renders the toggle as the toolbar\'s right-most control, starting selected ("Close Agent")', () => {
    const { toolbar } = buildWithToggle();
    const button = toggleButton(toolbar);

    // Right-most: nothing else follows it in the toolbar.
    expect(toolbar.element.lastElementChild).toBe(button);
    expect(button.getAttribute('title')).toBe('Close Agent');
    expect(button.getAttribute('aria-label')).toBe('Close Agent');
    expect(button.hasAttribute('selected')).toBe(true);
    expect(button.querySelector('sp-icon-padding-right')).not.toBeNull();
    // Icon-only: no text content of its own.
    expect(button.textContent).toBe('');
  });

  it('calls back when activated', () => {
    const { toolbar, onToggle } = buildWithToggle();
    toggleButton(toolbar).click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('drops `selected` and renames to "Open Agent" when the pane is hidden, and back', () => {
    const { toolbar } = buildWithToggle();
    const button = toggleButton(toolbar);

    toolbar.setAgentPaneOpen(false);
    expect(button.getAttribute('title')).toBe('Open Agent');
    expect(button.getAttribute('aria-label')).toBe('Open Agent');
    expect(button.hasAttribute('selected')).toBe(false);
    // One fixed glyph: the state is carried by `selected`, not an icon swap.
    expect(button.querySelector('sp-icon-padding-right')).not.toBeNull();

    toolbar.setAgentPaneOpen(true);
    expect(button.getAttribute('title')).toBe('Close Agent');
    expect(button.getAttribute('aria-label')).toBe('Close Agent');
    expect(button.hasAttribute('selected')).toBe(true);
    expect(button.querySelector('sp-icon-padding-right')).not.toBeNull();
  });
});

describe('createBrowserToolbar open-in-external-browser button', () => {
  function externalButton(toolbar: ReturnType<typeof createBrowserToolbar>): HTMLElement {
    const button = toolbar.element.querySelector<HTMLElement>('[title="Open in external browser"]');
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
    expect(button.querySelector('sp-icon-open-in-light')).not.toBeNull();
    expect(button.getAttribute('title')).toBe('Open in external browser');
    expect(button.getAttribute('aria-label')).toBe('Open in external browser');
    // Disabled until a valid URL is in the address field.
    expect(button.hasAttribute('disabled')).toBe(true);

    // Placed after the address group, before the last control (agent toggle).
    const last = toolbar.element.lastElementChild;
    expect(last?.getAttribute('title')).toBe('Close Agent');
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
