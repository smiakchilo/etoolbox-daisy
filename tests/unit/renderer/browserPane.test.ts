import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPane } from '../../../src/renderer/src/shell/browserPane';
import type { BrowserNavigationState, BrowserSwitchState } from '../../../src/shared';

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

describe('createBrowserPane page panel', () => {
  it('groups, and initially hides, the message row together with the native view region', () => {
    const pane = build();
    const pagePanel = pane.element.querySelector<HTMLElement>('.browser-page-panel');
    const message = pane.element.querySelector<HTMLElement>('.browser-toolbar-message');
    const viewHost = pane.element.querySelector<HTMLElement>('[data-testid="browser-view-host"]');

    expect(pagePanel).not.toBeNull();
    expect(pagePanel?.hidden).toBe(false);
    // The message row lives inside the page panel, next to the view region.
    expect(pagePanel?.contains(message)).toBe(true);
    expect(pagePanel?.contains(viewHost)).toBe(true);
    // ...but BELOW it in DOM order (statusbar-style): the flex column lays
    // the row out under the page, so it physically can't overlap the native
    // view during the load it describes.
    expect(pagePanel?.firstElementChild).toBe(viewHost);
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
  });

  it('hides the whole page panel while the hosts panel is open, and restores it on close', () => {
    const pane = build();
    const pagePanel = pane.element.querySelector<HTMLElement>('.browser-page-panel');
    const pickerButton = pane.element.querySelector<HTMLElement>('#hosts-button');

    expect(pagePanel?.hidden).toBe(false);
    pickerButton?.click();
    expect(pagePanel?.hidden).toBe(true);

    pane.element.querySelector<HTMLElement>('.hosts-panel__close')?.click();
    expect(pagePanel?.hidden).toBe(false);
  });

  it('swaps the hosts panel instantly via `hidden`', () => {
    const pane = build();
    const pagePanel = pane.element.querySelector<HTMLElement>('.browser-page-panel');

    pane.element.querySelector<HTMLElement>('#hosts-button')?.click();
    // The list needs the layout space immediately, so the panel must be
    // `display:none` (hidden).
    expect(pagePanel?.hidden).toBe(true);

    pane.element.querySelector<HTMLElement>('.hosts-panel__close')?.click();
    expect(pagePanel?.hidden).toBe(false);
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
    // The row closes instantly (no slide-out animation).
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
    });
    expect(message?.hasAttribute('open')).toBe(true);
    expect(message?.textContent).toBe('Loading\u2026');

    switchListeners[0]?.({ switching: false });
    stateListeners[0]?.({
      url: 'https://author.example/content/page.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
    });
    // Both conditions cleared: the banner closes instantly.
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
