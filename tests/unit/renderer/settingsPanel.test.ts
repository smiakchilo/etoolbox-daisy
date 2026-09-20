import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AGENT_ID,
  parseAppSettingsSnapshot,
  type BrowserNavigationState,
} from '../../../src/shared';
import { createBrowserPane } from '../../../src/renderer/src/shell/browserPane';
import { createSettingsPanel } from '../../../src/renderer/src/shell/settingsPanel';

/**
 * The Settings panel's dismissal contract (settingsPanel.ts + mainShell.ts),
 * reproduced as the browser pane would wire it: the panel's own close button
 * must reach the pane's panel host, which is what restores the suspended
 * native view and clears the active-panel reference. Regression test: the
 * panel used to swallow its dismissal (`onDismiss` no-op), so closing it
 * left the pane with a stale active panel and a permanently suspended view;
 * the next Settings click short-circuited in `openPanel` and nothing
 * happened (see browserPane.ts `if (activePanel === panel) return`).
 *
 * The hosts panel never hit this because its `onDismiss` forwards to the pane's
 * `close()` (hostsPanel.ts); Settings simply forgot the forwarding.
 */

const snapshotStub = parseAppSettingsSnapshot({
  hosts: [],
  proxies: [],
  agents: { [DEFAULT_AGENT_ID]: { active: true } },
  browser: { disableNativeWebAuthn: true },
});

const modelStateStub = {
  models: [],
  selectedModel: null,
  selectedReasoningEffort: null,
  changesLocked: false,
  catalogUnavailable: false,
};

let dom: JSDOM;
let stateListeners: Array<(state: BrowserNavigationState) => void>;

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
const previousResizeObserver = Reflect.get(globalThis, 'ResizeObserver') as unknown;

beforeEach(() => {
  dom = new JSDOM();
  stateListeners = [];
  Reflect.set(dom.window, 'daisy', {
    browser: {
      setViewBounds: vi.fn(),
      goBack: vi.fn(() => Promise.resolve({ ok: true })),
      goForward: vi.fn(() => Promise.resolve({ ok: true })),
      reload: vi.fn(() => Promise.resolve({ ok: true })),
      stop: vi.fn(() => Promise.resolve({ ok: true })),
      navigate: vi.fn(() => Promise.resolve({ ok: true })),
      onCertificateBlocked: vi.fn(() => () => undefined),
      onStateChanged: vi.fn((listener: (state: BrowserNavigationState) => void) => {
        stateListeners.push(listener);
        return () => {
          stateListeners = stateListeners.filter((candidate) => candidate !== listener);
        };
      }),
      onSwitchStateChanged: vi.fn(() => () => undefined),
    },
    settings: {
      getSnapshot: vi.fn(() => Promise.resolve({ ok: true, snapshot: snapshotStub })),
      getModelSelection: vi.fn(() => Promise.resolve({ ok: true, state: modelStateStub })),
    },
    agent: {
      getAuthStatus: vi.fn(() => Promise.resolve({ apiVersion: 1, isAuthenticated: false })),
    },
  });
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
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
  Reflect.set(globalThis, 'ResizeObserver', previousResizeObserver);
});

/** Mirrors the mainShell wiring: the panel is dismissed into the pane's host. */
function build() {
  const pane = createBrowserPane();
  const settings = createSettingsPanel({
    onSnapshotApplied: vi.fn(),
    onDismiss: () => pane.panelHost.close(),
  });
  pane.appendPanel(settings);
  return { pane, settings };
}

/** Emits a minimal navigation-state push (the pane latches its closeability on it). */
function emitNavigationState(): void {
  const minimal: BrowserNavigationState = {
    url: 'https://author.example/content/page.html',
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  };
  for (const listener of stateListeners) listener(minimal);
}

describe('createSettingsPanel dismissal', () => {
  it('forwards the close button to the pane host, restoring the view so Settings can open again', () => {
    const { pane, settings } = build();
    const pagePanel = pane.element.querySelector<HTMLElement>('.browser-page-panel');
    const panelSurface = pane.element.querySelector<HTMLElement>('.settings-panel');

    pane.panelHost.open(settings);
    expect(pagePanel?.hidden).toBe(true);
    expect(panelSurface?.hidden).toBe(false);

    // The panel is only user-dismissible once a page sits under it (the pane
    // gates closeability on navigation-state pushes), so unlock it first.
    emitNavigationState();
    pane.element.querySelector<HTMLElement>('.settings-panel__close')?.click();
    // The host heard the dismissal: the page view (native view region plus
    // message row) is restored and the panel is hidden.
    expect(pagePanel?.hidden).toBe(false);
    expect(panelSurface?.hidden).toBe(true);

    // Re-opening works: the pane no longer believes the closed panel is its
    // active one, so the open call proceeds instead of short-circuiting.
    pane.panelHost.open(settings);
    expect(pagePanel?.hidden).toBe(true);
    expect(panelSurface?.hidden).toBe(false);
  });

  it('fires onDismiss exactly once when the panel is dismissed', () => {
    const pane = createBrowserPane();
    const onDismiss = vi.fn();
    const settings = createSettingsPanel({
      onSnapshotApplied: vi.fn(),
      onDismiss,
    });
    pane.appendPanel(settings);

    pane.panelHost.open(settings);
    emitNavigationState();
    pane.element.querySelector<HTMLElement>('.settings-panel__close')?.click();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps Settings locked until a page has loaded', () => {
    const { pane, settings } = build();
    const pagePanel = pane.element.querySelector<HTMLElement>('.browser-page-panel');
    const close = pane.element.querySelector<HTMLElement>('.settings-panel__close');

    pane.panelHost.open(settings);
    expect(close?.hasAttribute('disabled')).toBe(true);

    close?.click();
    expect(pagePanel?.hidden).toBe(true);

    emitNavigationState();
    expect(close?.hasAttribute('disabled')).toBe(false);

    close?.click();
    expect(pagePanel?.hidden).toBe(false);
  });
});
