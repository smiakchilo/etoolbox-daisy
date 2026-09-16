import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserToolbar } from '../../../src/renderer/src/shell/browserToolbar';
import type { BrowserNavigationState, BrowserSwitchState } from '../../../src/shared';

/**
 * The toolbar's external-navigation loading state machine (browserToolbar.ts).
 * The toolbar is the only thing that knows a navigation was initiated outside
 * the webview (address bar, picker, Back/Forward/Refresh), so it owns whether
 * the "Loading…" banner + Refresh/Stop swap appear for a given `isLoading`
 * push. Rules under test:
 *
 * - Only chrome-armed loads (`pendingExternalNav > 0`) or active switches
 *   show the banner; a plain in-webview `isLoading:true` push does not.
 * - The banner clears when the armed load ends (`isLoading:false`), which
 *   also disarms the counter so a later in-webview navigation can't
 *   resurrect it.
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
  onStateChanged: ReturnType<typeof vi.fn>;
  onSwitchStateChanged: ReturnType<typeof vi.fn>;
}

let dom: JSDOM;
let browser: FakeDaisyBrowser;
let stateListeners: Array<(state: BrowserNavigationState) => void>;
let switchListeners: Array<(state: BrowserSwitchState) => void>;

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;

beforeEach(() => {
  dom = new JSDOM();
  stateListeners = [];
  switchListeners = [];
  browser = {
    goBack: vi.fn(() => Promise.resolve({ ok: true })),
    goForward: vi.fn(() => Promise.resolve({ ok: true })),
    reload: vi.fn(() => Promise.resolve({ ok: true })),
    stop: vi.fn(() => Promise.resolve({ ok: true })),
    navigate: vi.fn(() => Promise.resolve({ ok: true })),
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
  };
  Reflect.set(dom.window, 'daisy', { browser });
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

function build(): ReturnType<typeof createBrowserToolbar> {
  return createBrowserToolbar({ onServerPickerClick: () => {} });
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
  it('shows "Loading…" + Stop only after a chrome-arm, and restores on did-stop-loading', () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    // Arm: click Refresh (rebinds from the initial cosmetic icon to the wired
    // handler), then the load starts.
    findNavButton(toolbar).click();
    stateListeners[0]?.(loadingState(true));

    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent).toBe('Loading\u2026');
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');
    expect(browser.reload).toHaveBeenCalledTimes(1);

    stateListeners[0]?.(loadingState(false));
    expect(message.hasAttribute('open')).toBe(false);
    expect(message.textContent).toBe('');
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');
  });

  it('leaves the banner closed for an in-webview navigation (no chrome arm)', () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    stateListeners[0]?.(loadingState(true));
    stateListeners[0]?.(loadingState(false));

    expect(browser.reload).not.toHaveBeenCalled();
    expect(message.hasAttribute('open')).toBe(false);
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');
  });

  it('arms the loading presentation from Back/Forward too', () => {
    const toolbar = build();
    const message = findMessage(toolbar);
    // Back is the Refresh/Stop button's sibling with aria-label "Back".
    const back = toolbar.element.querySelector('[aria-label="Back"]') as HTMLElement;
    if (!back) throw new Error('back button not found');

    back.click();
    expect(browser.goBack).toHaveBeenCalledTimes(1);
    stateListeners[0]?.(loadingState(true));
    expect(message.hasAttribute('open')).toBe(true);
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');

    stateListeners[0]?.(loadingState(false));
    expect(message.hasAttribute('open')).toBe(false);
  });

  it('disarms after did-stop-loading so a later in-webview load stays silent', () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    findNavButton(toolbar).click();
    stateListeners[0]?.(loadingState(true));
    stateListeners[0]?.(loadingState(false));
    expect(message.hasAttribute('open')).toBe(false);

    // A later in-webview navigation (no arm) must not resurrect the banner.
    stateListeners[0]?.(loadingState(true));
    expect(message.hasAttribute('open')).toBe(false);
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');
  });

  it('suppresses the ERR_ABORTED from a user-initiated Stop (no error banner)', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    // An address submit arms an external navigation (source: the address bar,
    // routed through `browser:navigate`). The load briefly starts.
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

    expect(message.hasAttribute('open')).toBe(true);
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');

    await vi.waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledTimes(1);
    });
    // `browser:navigate` is the one toolbar IPC that reports load failure
    // (`reload`/`goBack`/`goForward` return ok immediately), and an abort
    // from a user Stop is a cancellation - the error banner must stay
    // suppressed and the arm cleared (back to idle/Refresh).
    expect(message.hasAttribute('open')).toBe(false);
    expect(message.textContent).toBe('');
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');
  });

  it('suppresses the real Stop cancellation (ERR_FAILED from Electron 44) without an error banner', async () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    // An address submit arms an external navigation whose in-flight promise
    // we resolve later (the load is slow).
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

    expect(message.hasAttribute('open')).toBe(true);
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Stop');

    // The user clicks Stop: verified against Electron 44.3.0, a Stop during a
    // pending loadURL makes that promise reject with ERR_FAILED, not
    // ERR_ABORTED (probe in the Step 05 verification records). Suppression
    // keys on the user action captured when Stop was clicked.
    findNavButton(toolbar).click();
    await vi.waitFor(() => {
      expect(browser.stop).toHaveBeenCalledTimes(1);
    });

    resolveNavigation?.({
      ok: false,
      error: {
        code: 'network_error',
        message: "ERR_FAILED (-2) loading 'https://author.example/content/page.html'",
        errorCode: 'ERR_FAILED',
      },
    });

    await vi.waitFor(() => {
      expect(message.hasAttribute('open')).toBe(false);
    });
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
    expect(findNavButton(toolbar).getAttribute('aria-label')).toBe('Refresh');

    message.dispatchEvent(new dom.window.Event('close', { bubbles: true, composed: true }));
    expect(message.hasAttribute('open')).toBe(false);
    expect(message.textContent).toBe('');
  });

  it('keeps the banner open across a switch+load overlap, then closes when both clear', () => {
    const toolbar = build();
    const message = findMessage(toolbar);

    // A picker selection both arms an external navigation (pendingExternalNav)
    // and begins a server switch.
    toolbar.navigateTo('https://author.example/');
    switchListeners[0]?.({ switching: true });
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent).toBe('Loading\u2026');

    // The load starts; then the switch controller reports done while the page
    // is still loading — the banner must not close early (armed load still
    // in progress).
    stateListeners[0]?.(loadingState(true));
    switchListeners[0]?.({ switching: false });
    expect(message.hasAttribute('open')).toBe(true);
    expect(message.textContent).toBe('Loading\u2026');

    // did-stop-loading disarms and closes.
    stateListeners[0]?.(loadingState(false));
    expect(message.hasAttribute('open')).toBe(false);
    expect(message.textContent).toBe('');
  });
});
