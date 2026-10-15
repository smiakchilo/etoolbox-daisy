import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPane } from '../../../src/renderer/src/shell/browserPane';
import { createPanel } from '../../../src/renderer/src/shell/panel';
import { BANNER_TRANSITION_DURATION_MS } from '../../../src/renderer/src/lib/alertBanner';
import type { BrowserNavigationState, BrowserSwitchState } from '../../../src/shared';
import { newServerId } from '../../../src/shared';

/**
 * The browser pane's page panel grouping (browserPane.ts): the toolbar's
 * status/message row and the reserved native-view region hide as one while
 * the hosts panel covers the page, so the message row never claims to
 * describe a page that is no longer on screen. A splitter drag never hides a
 * panel - the native view stays fully visible - so only the hosts panel path
 * is exercised here.
 *
 * The toolbar's own message lifecycle is exercised through the pane for the
 * one signal that needs a running app in E2E otherwise: the unified
 * "Loading…" presentation appears while switching is active, and closes
 * when the transition completes. Dedicated loading/error/stop coverage
 * lives in `browserToolbar.test.ts`.
 */

interface FakeDaisyBrowser {
  setViewBounds: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  onStateChanged: ReturnType<typeof vi.fn>;
  onSwitchStateChanged: ReturnType<typeof vi.fn>;
  onCertificateBlocked: ReturnType<typeof vi.fn>;
}

let dom: JSDOM;
let browser: FakeDaisyBrowser;
let stateListeners: Array<(state: BrowserNavigationState) => void>;
let switchListeners: Array<(state: BrowserSwitchState) => void>;

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
const previousResizeObserver = Reflect.get(globalThis, 'ResizeObserver') as unknown;

beforeEach(() => {
  dom = new JSDOM();
  stateListeners = [];
  switchListeners = [];
  browser = {
    setViewBounds: vi.fn(),
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
    onCertificateBlocked: vi.fn(() => () => undefined),
  };
  Reflect.set(dom.window, 'daisy', { browser });
  Reflect.set(dom.window, 'requestAnimationFrame', () => 1);
  Reflect.set(dom.window, 'cancelAnimationFrame', () => undefined);
  Reflect.set(
    globalThis,
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
});

afterEach(() => {
  vi.useRealTimers();
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
  Reflect.set(globalThis, 'ResizeObserver', previousResizeObserver);
});

function build(): ReturnType<typeof createBrowserPane> {
  return createBrowserPane();
}

/** Emits a minimal navigation-state push to every listener (like one IPC event). */
function emitNavigationState(): void {
  const minimal: BrowserNavigationState = {
    url: 'https://author.example/content/page.html',
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    hasDocument: true,
  };
  for (const listener of stateListeners) listener(minimal);
}

describe('createBrowserPane page panel', () => {
  it('stacks the message row below the view slot, outside the region a panel replaces', () => {
    const pane = build();
    const pagePanel = pane.element.querySelector<HTMLElement>('.browser-page-panel');
    const viewSlot = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-slot"]');
    const message = pane.element.querySelector<HTMLElement>('.browser-toolbar-message');
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');

    expect(pagePanel).not.toBeNull();
    expect(pagePanel?.hidden).toBe(false);
    // The view slot holds the native view (and, hidden, the hosts panel); the
    // message row is a sibling below it - outside the slot a panel replaces,
    // so a panel can never cover it.
    expect(viewSlot).not.toBeNull();
    expect(pagePanel?.contains(message)).toBe(true);
    expect(viewSlot?.contains(viewHost)).toBe(true);
    expect(viewSlot?.contains(message)).toBe(false);
    expect(pagePanel?.firstElementChild).toBe(viewSlot);
    expect(pagePanel?.lastElementChild).toBe(message);
    // Apart from a loading state, there is nothing to say yet. The row is an
    // `sp-alert-banner` whose show/hide mechanism is its own `open` attribute
    // (`:host{display:none}` / `:host([open]){display:flex}` in the
    // component's stylesheet), so "hidden" means "no such attribute".
    expect(message?.hasAttribute('open')).toBe(false);
    // The "Settings" affordance was removed from the row; Settings is now a
    // panel opened through the chat toolbar, and an error row must not
    // double as a navigation aid (see browserToolbar.ts).
    expect(pane.element.querySelector('.browser-toolbar-message__settings')).toBeNull();
    // One row per surface: the browser's navigation row and the pane-owned
    // surface-status row (for the panels the pane hosts) are separate rows, so
    // a message on one never stacks with a message on the other. The surface
    // row sits directly under the slot it describes; the browser row stays
    // last, so the existing geometry is unchanged when the surface row is
    // idle (it collapses to zero height).
    expect(pane.element.querySelectorAll('.banner-row').length).toBe(2);
    const surface = pane.element.querySelector<HTMLElement>('.surface-status-banner');
    expect(surface).not.toBeNull();
    expect(pagePanel?.contains(surface)).toBe(true);
    expect(pagePanel?.children[1]).toBe(surface);
    expect(pagePanel?.lastElementChild).toBe(message);
  });

  it('shows the home screen until a document loads, and the native view after', () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
    const home = pane.element.querySelector<HTMLElement>('.browser-home');

    // Fresh pane: nothing is loaded, so the home screen occupies the region and
    // the native view is collapsed (not merely hidden - it composites above the
    // DOM, so it must be sized to zero).
    expect(viewHost?.hidden).toBe(true);
    expect(home?.hidden).toBe(false);

    emitNavigationState();
    expect(home?.hidden).toBe(true);
    expect(viewHost?.hidden).toBe(false);
  });

  it('hides only the native view while the hosts panel is open, keeping the message row', () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
    const message = pane.element.querySelector<HTMLElement>('.browser-toolbar-message');
    const pickerButton = pane.element.querySelector<HTMLElement>('#hosts-button');
    const close = pane.element.querySelector<HTMLElement>('.hosts-panel__close');

    // A page is loaded, so the native view is the visible layer.
    emitNavigationState();
    expect(viewHost?.hidden).toBe(false);

    pickerButton?.click();
    expect(viewHost?.hidden).toBe(true);
    // The row is outside the panel's slot: the panel replaces the view, not
    // the row.
    expect(message?.hidden).toBe(false);

    // Panels are always dismissible now: the home screen covers the region when
    // no page is under the panel.
    expect(close?.hasAttribute('disabled')).toBe(false);

    close?.click();
    expect(viewHost?.hidden).toBe(false);
  });

  it('keeps the pane-owned surface-status row out of the panel, so it survives dismissal', () => {
    vi.useFakeTimers();
    try {
      const pane = build();
      const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
      const surface = pane.element.querySelector<HTMLElement>('.surface-status-banner');

      pane.surfaceStatus.showStatus('Settings saved');
      expect(surface?.hasAttribute('open')).toBe(true);

      pane.element.querySelector<HTMLElement>('#hosts-button')?.click();
      expect(viewHost?.hidden).toBe(true);
      expect(surface?.hasAttribute('open')).toBe(true);

      emitNavigationState();
      pane.element.querySelector<HTMLElement>('.hosts-panel__close')?.click();
      expect(viewHost?.hidden).toBe(false);
      // The row is a child of the page panel, never of the dismissed panel, so
      // its message is still on screen after the panel closes.
      expect(pane.element.contains(surface)).toBe(true);
      expect(surface?.hasAttribute('open')).toBe(true);
      expect(surface?.textContent).toBe('Settings saved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('swaps the hosts panel instantly via `hidden`', () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');

    pane.element.querySelector<HTMLElement>('#hosts-button')?.click();
    // The list needs the layout space immediately, so the view must be
    // `display:none` (hidden).
    expect(viewHost?.hidden).toBe(true);

    emitNavigationState();
    pane.element.querySelector<HTMLElement>('.hosts-panel__close')?.click();
    expect(viewHost?.hidden).toBe(false);
  });
});

describe('createBrowserPane message lifecycle', () => {
  it('shows the loading banner while switching is active and closes it when switching ends', () => {
    vi.useFakeTimers();
    const pane = build();
    const message = pane.element.querySelector<HTMLElement>('.browser-toolbar-message');

    switchListeners[0]?.({ switching: true });
    // The loading presentation is debounced by 200ms; the banner is still
    // closed inside the window.
    expect(message?.hasAttribute('open')).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(message?.hasAttribute('open')).toBe(true);
    expect(message?.textContent).toBe('Loading\u2026');

    switchListeners[0]?.({ switching: false });
    // The row collapses over the shared transition, then is torn down.
    expect(message?.hasAttribute('open')).toBe(true);
    vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
    expect(message?.hasAttribute('open')).toBe(false);
    expect(message?.textContent).toBe('');
  });

  it('keeps the loading banner open across a switch+isLoading overlap, then closes when both clear', () => {
    vi.useFakeTimers();
    const pane = build();
    const message = pane.element.querySelector<HTMLElement>('.browser-toolbar-message');

    switchListeners[0]?.({ switching: true });
    vi.advanceTimersByTime(1000);
    expect(message?.textContent).toBe('Loading\u2026');

    stateListeners[0]?.({
      url: 'https://author.example/content/page.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: true,
      hasDocument: true,
    });
    expect(message?.hasAttribute('open')).toBe(true);
    expect(message?.textContent).toBe('Loading\u2026');

    switchListeners[0]?.({ switching: false });
    stateListeners[0]?.({
      url: 'https://author.example/content/page.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    });
    // Both conditions cleared: the banner collapses, then is torn down.
    vi.advanceTimersByTime(BANNER_TRANSITION_DURATION_MS);
    expect(message?.hasAttribute('open')).toBe(false);
    expect(message?.textContent).toBe('');
  });

  it('gives the loading banner no close control (only error/prompt rows are dismissible)', () => {
    vi.useFakeTimers();
    const pane = build();
    const message = pane.element.querySelector<HTMLElement>('.browser-toolbar-message');

    // The freshly built banner is dismissible by default (the idle
    // presentation doesn't use it, so it stays latent until the first
    // error/prompt). Switching on the loading presentation removes it.
    switchListeners[0]?.({ switching: true });
    vi.advanceTimersByTime(1000);
    expect(message?.hasAttribute('open')).toBe(true);
    expect(message?.hasAttribute('dismissible')).toBe(false);
  });

  it('re-opens the loading banner on dismissal when switching is still active', () => {
    vi.useFakeTimers();
    const pane = build();
    const message = pane.element.querySelector<HTMLElement>('.browser-toolbar-message');

    switchListeners[0]?.({ switching: true });
    vi.advanceTimersByTime(1000);
    expect(message?.hasAttribute('open')).toBe(true);
    expect(message?.textContent).toBe('Loading\u2026');

    // A synthetic close while loading still active: preventDefault means
    // this module keeps control and the already-visible loading presentation
    // stays (it is re-applied, immediately). This is an accepted minor edge
    // - in production the loading banner carries no close control, so only
    // programmatic events reach here.
    message?.dispatchEvent(new dom.window.Event('close', { bubbles: true, composed: true }));
    expect(message?.hasAttribute('open')).toBe(true);
    expect(message?.textContent).toBe('Loading\u2026');
  });
});

describe('createBrowserPane closeability', () => {
  it('lets the cross dismiss a panel before any page has loaded, revealing the home screen', () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
    const home = pane.element.querySelector<HTMLElement>('.browser-home');
    const picker = pane.element.querySelector<HTMLElement>('.hosts-panel');
    const close = pane.element.querySelector<HTMLElement>('.hosts-panel__close');
    const pickerButton = pane.element.querySelector<HTMLElement>('#hosts-button');

    pickerButton?.click();
    expect(viewHost?.hidden).toBe(true);
    // Nothing has loaded, yet the panel is dismissible: closing reveals the
    // home screen, not a bare region.
    expect(close?.hasAttribute('disabled')).toBe(false);

    close?.click();
    expect(picker?.hidden).toBe(true);
    expect(home?.hidden).toBe(false);
    expect(viewHost?.hidden).toBe(true);
  });

  it('lets Escape dismiss a panel, revealing the home screen when no page is loaded', () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
    const home = pane.element.querySelector<HTMLElement>('.browser-home');

    pane.element.querySelector<HTMLElement>('#hosts-button')?.click();

    document.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(home?.hidden).toBe(false);
    expect(viewHost?.hidden).toBe(true);
  });

  it('lets the hosts-button toggle dismiss the panel', () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
    const home = pane.element.querySelector<HTMLElement>('.browser-home');
    const pickerButton = pane.element.querySelector<HTMLElement>('#hosts-button');

    pickerButton?.click();
    pickerButton?.click();
    expect(home?.hidden).toBe(false);
    expect(viewHost?.hidden).toBe(true);
  });

  it('lets a host selection close the panel and navigate', () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
    const home = pane.element.querySelector<HTMLElement>('.browser-home');
    const pickerButton = pane.element.querySelector<HTMLElement>('#hosts-button');

    pane.update({
      addressValue: 'https://author.example',
      hostOptions: [
        {
          id: newServerId(() => 'srv-1'),
          label: 'Author',
          origin: 'https://author.example',
          colorCss: '#0f0',
        },
      ],
    });

    pickerButton?.click();
    // Selecting a host closes the panel AND navigates; until the navigation
    // commits there is still no document, so the home screen shows meanwhile.
    pane.element
      .querySelector<HTMLElement>('.hosts-item[data-origin="https://author.example"]')
      ?.click();

    expect(browser.navigate).toHaveBeenCalledWith('https://author.example');
    expect(home?.hidden).toBe(false);
    expect(viewHost?.hidden).toBe(true);
  });

  it('carries the open page to the host picked in the panel', () => {
    const pane = build();
    pane.update({
      addressValue: 'http://localhost:4502/content/acme/us/en/home.html',
      hostOptions: [
        {
          id: newServerId(() => 'srv-local'),
          label: 'Local',
          origin: 'http://localhost:4502',
          colorCss: '#00f',
        },
        {
          id: newServerId(() => 'srv-cloud'),
          label: 'Acme Cloud',
          origin: 'https://acme.adobe.com',
          colorCss: '#0f0',
        },
      ],
    });
    stateListeners[0]?.({
      url: 'http://localhost:4502/content/acme/us/en/home.html',
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    });

    pane.element.querySelector<HTMLElement>('#hosts-button')?.click();
    pane.element
      .querySelector<HTMLElement>('.hosts-item[data-origin="https://acme.adobe.com"]')
      ?.click();

    expect(browser.navigate).toHaveBeenCalledWith(
      'https://acme.adobe.com/content/acme/us/en/home.html',
    );
  });
});

describe('createBrowserPane navigation failure recovery', () => {
  it('exposes navigate(url), routed through the toolbar like a typed address', () => {
    const pane = build();

    pane.navigate('https://author.example/content/page.html');

    expect(browser.navigate).toHaveBeenCalledWith('https://author.example/content/page.html');
  });

  it('reveals the home screen (not a bare region) when a failed load has no page to restore', async () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
    const home = pane.element.querySelector<HTMLElement>('.browser-home');
    const picker = pane.element.querySelector<HTMLElement>('.hosts-panel');
    const message = pane.element.querySelector<HTMLElement>('.browser-toolbar-message');
    browser.navigate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'network_error', message: 'Timed out', errorCode: 'ERR_TIMED_OUT' },
    });

    pane.navigate('https://dead.example/');

    await vi.waitFor(() => {
      expect(message?.hasAttribute('open')).toBe(true);
    });
    // The error row is visible below the page-view region; that region shows the
    // home screen rather than a blank native view, and no panel is forced open.
    expect(message?.textContent).toContain('Timed out');
    expect(home?.hidden).toBe(false);
    expect(viewHost?.hidden).toBe(true);
    expect(picker?.hidden).toBe(true);
  });

  it('closes an open panel when an external navigation starts, and shows the error row when the load fails', async () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
    const message = pane.element.querySelector<HTMLElement>('.browser-toolbar-message');
    const picker = pane.element.querySelector<HTMLElement>('.hosts-panel');
    const other = createPanel({
      title: 'Other',
      closeAriaLabel: 'Close other',
      content: document.createElement('div'),
      onDismiss: () => pane.panelHost.close(),
    });
    pane.appendPanel(other);
    browser.navigate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'network_error', message: 'Timed out', errorCode: 'ERR_TIMED_OUT' },
    });

    pane.panelHost.open(other);
    pane.navigate('https://dead.example/');

    // An externally-caused navigation reveals the page: the covering panel is
    // dismissed as the navigation starts, so the destination is never hidden
    // behind it.
    expect(other.isOpen).toBe(false);
    expect(pane.panelHost.isActive(other)).toBe(false);

    await vi.waitFor(() => {
      expect(message?.hasAttribute('open')).toBe(true);
    });
    expect(picker?.hidden).toBe(true);
    // ...and the error row is visible below the (now empty) page-view region.
    expect(message?.textContent).toContain('Timed out');
    expect(viewHost?.hidden).toBe(true);
  });

  it('leaves an open panel alone when the AEM page navigates itself', () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
    const other = createPanel({
      title: 'Other',
      closeAriaLabel: 'Close other',
      content: document.createElement('div'),
      onDismiss: () => pane.panelHost.close(),
    });
    pane.appendPanel(other);
    pane.panelHost.open(other);

    // An in-page navigation surfaces only as a `browser:state-changed` push; it
    // must not dismiss the panel the user opened - only an external navigation
    // (a link, a typed address, Back/Forward, Refresh) does.
    emitNavigationState();

    expect(other.isOpen).toBe(true);
    expect(pane.panelHost.isActive(other)).toBe(true);
    expect(viewHost?.hidden).toBe(true);
  });
});

describe('createBrowserPane home screen', () => {
  it('routes the home actions to the hosts picker, History, and the shell settings callback', () => {
    const onOpenHistory = vi.fn();
    const onOpenSettings = vi.fn();
    const pane = createBrowserPane({ onOpenHistory, onOpenSettings });
    const [hostsAction, historyAction, settingsAction] = Array.from(
      pane.element.querySelectorAll<HTMLElement>('.browser-home__action'),
    );

    historyAction?.click();
    expect(onOpenHistory).toHaveBeenCalledTimes(1);

    settingsAction?.click();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    hostsAction?.click();
    expect(pane.element.querySelector<HTMLElement>('.hosts-panel')?.hidden).toBe(false);
  });

  it('reveals the home screen on Home even with a page loaded, and leaves it on navigation', () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
    const home = pane.element.querySelector<HTMLElement>('.browser-home');
    const homeButton = pane.element.querySelector<HTMLElement>('[title="Home"]');

    emitNavigationState();
    expect(viewHost?.hidden).toBe(false);

    homeButton?.click();
    expect(home?.hidden).toBe(false);
    expect(viewHost?.hidden).toBe(true);

    // A user-initiated navigation leaves the home screen again.
    pane.navigate('https://author.example/content/other.html');
    expect(home?.hidden).toBe(true);
    expect(viewHost?.hidden).toBe(false);
  });

  it('is a veil, not a page: Home blanks the address/Back, and the close control returns to the page', () => {
    const pane = build();
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');
    const home = pane.element.querySelector<HTMLElement>('.browser-home');
    const close = pane.element.querySelector<HTMLElement>('.browser-home__close');
    const back = pane.element.querySelector<HTMLElement>('[aria-label="Back"]');
    const address = pane.element.querySelector('#browser-address-bar') as unknown as {
      value: string;
    };

    emitNavigationState();
    // The live page's URL is on the address bar, and the close control is not
    // offered while the page is what is on screen.
    expect(address.value).toBe('https://author.example/content/page.html');
    expect(close?.hidden).toBe(true);

    pane.element.querySelector<HTMLElement>('[title="Home"]')?.click();
    expect(home?.hidden).toBe(false);
    expect(viewHost?.hidden).toBe(true);
    // The welcome screen is not a page: no address to show, and Back must not
    // silently act on the hidden page's history. The close control appears
    // because there is a page to return to.
    expect(address.value).toBe('');
    expect(back?.hasAttribute('disabled')).toBe(true);
    expect(close?.hidden).toBe(false);

    close?.click();
    // Dismissing the veil is not a navigation: the page it covered is revealed
    // unchanged, its URL restored, and no history move was issued.
    expect(home?.hidden).toBe(true);
    expect(viewHost?.hidden).toBe(false);
    expect(address.value).toBe('https://author.example/content/page.html');
    expect(close?.hidden).toBe(true);
    expect(browser.goBack).not.toHaveBeenCalled();
  });

  it('hides the close control when the home screen is the genuine empty state', () => {
    const pane = build();
    const close = pane.element.querySelector<HTMLElement>('.browser-home__close');
    expect(close?.hidden).toBe(true);
  });

  it('closes an open panel when Home is pressed', () => {
    const pane = build();
    const home = pane.element.querySelector<HTMLElement>('.browser-home');
    const panel = pane.element.querySelector<HTMLElement>('.hosts-panel');

    pane.element.querySelector<HTMLElement>('#hosts-button')?.click();
    expect(panel?.hidden).toBe(false);

    pane.element.querySelector<HTMLElement>('[title="Home"]')?.click();
    expect(panel?.hidden).toBe(true);
    expect(home?.hidden).toBe(false);
  });

  it('disables "Choose a host" while no hosts are configured', () => {
    const pane = build();
    const hostsAction = pane.element.querySelector<HTMLElement>('.browser-home__action');

    pane.update({ addressValue: '', hostOptions: [] });
    expect(hostsAction?.hasAttribute('disabled')).toBe(true);

    pane.update({
      addressValue: '',
      hostOptions: [
        {
          id: newServerId(() => 'srv-1'),
          label: 'Author',
          origin: 'https://author.example',
          colorCss: '#0f0',
        },
      ],
    });
    expect(hostsAction?.hasAttribute('disabled')).toBe(false);
  });

  it('renders the user-invocable tool catalogue it is handed', () => {
    const pane = build();
    pane.home.setSkills([
      { name: 'search', description: 'Find content' },
      { name: 'semantic-search', description: 'Find by meaning' },
    ]);
    expect(
      Array.from(pane.element.querySelectorAll('.browser-home__skill-name')).map(
        (node) => node.textContent,
      ),
    ).toEqual(['/search', '/semantic-search']);
  });
});

describe('createBrowserPane agent-pane toggle', () => {
  function toggleOf(pane: ReturnType<typeof createBrowserPane>): HTMLElement {
    const button = pane.element.querySelector<HTMLElement>(
      '[title="Close chat"], [title="Open chat"]',
    );
    if (!button) throw new Error('agent-pane toggle button not found');
    return button;
  }

  it('forwards a toggle click to the shell callback', () => {
    const onToggleAgentPane = vi.fn();
    const pane = createBrowserPane({ onToggleAgentPane });

    toggleOf(pane).click();

    expect(onToggleAgentPane).toHaveBeenCalledTimes(1);
  });

  it('reflects the pane state onto the toolbar button', () => {
    const pane = createBrowserPane();
    expect(toggleOf(pane).getAttribute('title')).toBe('Close chat');

    pane.setAgentPaneOpen(false);
    expect(toggleOf(pane).getAttribute('title')).toBe('Open chat');

    pane.setAgentPaneOpen(true);
    expect(toggleOf(pane).getAttribute('title')).toBe('Close chat');
  });
});
