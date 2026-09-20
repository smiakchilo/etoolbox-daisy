import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserToolbar } from '../../../src/renderer/src/shell/browserToolbar';
import { BANNER_TRANSITION_DURATION_MS } from '../../../src/renderer/src/lib/alertBanner';
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
    expect(message.classList.contains('browser-toolbar-message--loading')).toBe(true);
    // The loading presentation is not dismissible and ends in a progress line.
    expect(message.hasAttribute('dismissible')).toBe(false);
    expect(message.querySelector('.browser-toolbar-message__progress')).not.toBeNull();
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
    expect(message.querySelector('.browser-toolbar-message__progress')).toBeNull();
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
    expect(message.querySelector('.browser-toolbar-message__progress')).toBeNull();
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
    address.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
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
    address.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
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
        message:
          "Can't connect to https://dead.example. Check that the server is running, then try again",
        errorCode: 'ERR_CONNECTION_REFUSED',
      },
    });

    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    address.value = 'https://dead.example';
    address.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

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
    expect(message.classList.contains('browser-toolbar-message--loading')).toBe(true);

    // did-stop-loading collapses it.
    stateListeners[0]?.(loadingState(false));
    vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
    expect(message.hasAttribute('open')).toBe(false);
    expect(message.textContent).toBe('');
    expect(message.classList.contains('browser-toolbar-message--loading')).toBe(false);
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
    expect(message.classList.contains('browser-toolbar-message--loading')).toBe(true);
    expect(message.querySelector('.browser-toolbar-message__progress')).not.toBeNull();

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
    expect(message.classList.contains('browser-toolbar-message--loading')).toBe(true);
    expect(message.querySelector('.browser-toolbar-message__progress')).not.toBeNull();
  });

  it('shows a fetch error immediately even while a loading debounce is armed', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    browser.navigate.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'network_error',
        message:
          "Can't connect to https://dead.example. Check that the server is running, then try again",
        errorCode: 'ERR_CONNECTION_REFUSED',
      },
    });

    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };
    address.value = 'https://dead.example';
    address.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
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
    expect(message.textContent).toContain(
      'This host has an untrusted certificate. Press OK to allow it',
    );
    expect(findPromptOk(toolbar).hasAttribute('disabled')).toBe(false);
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
  address.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
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
    expect(message.textContent).toContain(
      'This host is unknown. Press OK to add it to the managed hosts',
    );
    // The origin is visible in the address bar above the banner; the copy
    // must not repeat it (noise, and invites reading the banner instead of
    // the real navigated address).
    expect(message.textContent).not.toContain('https://unknown.example');
    // Exactly one accepting action: an `sp-action-button` (never an accent
    // `sp-button` - no blue fill). Cancel is the banner's dismiss cross.
    const okButtons = message.querySelectorAll('sp-action-button');
    expect(okButtons).toHaveLength(1);
    expect(okButtons[0]?.textContent).toBe('OK');
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

    // First attempt: type + change → banner.
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
    expect(message.textContent).toContain(
      'This host is unknown. Press OK to add it to the managed hosts',
    );
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
    expect(message.textContent).toContain(
      'This host is unknown. Press OK to add it to the managed hosts',
    );
  });

  it('keydown Enter does not double-fire when change also fires', async () => {
    const toolbar = build();
    const address = toolbar.element.querySelector('.address-bar') as HTMLElement & {
      value: string;
    };

    browser.navigate.mockResolvedValue({ ok: true });
    address.value = 'https://author.example/content/page.html';
    // Simulate the browser event order: keydown fires first, then change.
    address.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
    address.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    // Only one navigate call must have been made (keydown navigated, change
    // was suppressed by the guard).
    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
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
