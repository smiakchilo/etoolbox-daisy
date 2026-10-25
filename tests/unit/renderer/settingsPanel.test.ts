import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAppSettingsSnapshot, type BrowserNavigationState } from '../../../src/shared';
import { createBrowserPane } from '../../../src/renderer/src/shell/browserPane';
import { createSettingsPanel } from '../../../src/renderer/src/shell/settingsPanel';
import { TEST_AGENT_ID } from '../../support/agentDefinitions';
import { InertResizeObserver, installJsdomGlobals } from '../../support/jsdomGlobals';

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
  agents: { [TEST_AGENT_ID]: { active: true } },
  browser: { disableNativeWebAuthn: true },
});

const modelStateStub = {
  models: [],
  selectedModel: null,
  selectedReasoningEffort: null,
  catalogUnavailable: false,
};

let dom: JSDOM;
let restoreGlobals: () => void;
let stateListeners: Array<(state: BrowserNavigationState) => void>;

beforeEach(() => {
  ({ dom, restore: restoreGlobals } = installJsdomGlobals({
    extraGlobals: { ResizeObserver: InertResizeObserver },
  }));
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
      onAgentNavigation: vi.fn(() => () => undefined),
      onFindResult: vi.fn(() => () => undefined),
    },
    settings: {
      getSnapshot: vi.fn(() => Promise.resolve({ ok: true, snapshot: snapshotStub })),
      getModelSelection: vi.fn(() => Promise.resolve({ ok: true, state: modelStateStub })),
    },
    agent: {
      getAuthStatus: vi.fn(() => Promise.resolve({ apiVersion: 1, isAuthenticated: false })),
      onAuthProgress: vi.fn(() => () => undefined),
    },
    updates: {
      getStatus: vi.fn(() => Promise.resolve({ ok: true, status: { kind: 'idle' } })),
      onStatusChanged: vi.fn(() => () => undefined),
    },
  });
  Reflect.set(dom.window, 'requestAnimationFrame', () => 1);
  Reflect.set(dom.window, 'cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  restoreGlobals();
});

/** Mirrors the mainShell wiring: the panel is dismissed into the pane's host. */
function build() {
  const pane = createBrowserPane();
  const settings = createSettingsPanel({
    status: pane.surfaceStatus,
    onSnapshotApplied: vi.fn(),
    onDismiss: () => pane.panelHost.close(),
  });
  pane.appendPanel(settings);
  return { pane, settings };
}

/** Emits a minimal navigation-state push. */
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

describe('createSettingsPanel dismissal', () => {
  it('forwards the close button to the pane host, restoring the view so Settings can open again', () => {
    const { pane, settings } = build();
    const viewHost = pane.element.querySelector<HTMLElement>('.browser-view-host');
    const panelSurface = pane.element.querySelector<HTMLElement>('.settings-panel');

    pane.panelHost.open(settings);
    expect(viewHost?.hidden).toBe(true);
    expect(panelSurface?.hidden).toBe(false);

    // The panel is always user-dismissible now: closing it reveals the page if
    // one is loaded, or the home screen if not - never a bare region.
    emitNavigationState();
    pane.element.querySelector<HTMLElement>('.settings-panel__close')?.click();
    // The host heard the dismissal: the page view is restored and the panel is
    // hidden.
    expect(viewHost?.hidden).toBe(false);
    expect(panelSurface?.hidden).toBe(true);

    // Re-opening works: the pane no longer believes the closed panel is its
    // active one, so the open call proceeds instead of short-circuiting.
    pane.panelHost.open(settings);
    expect(viewHost?.hidden).toBe(true);
    expect(panelSurface?.hidden).toBe(false);
  });

  it('fires onDismiss exactly once when the panel is dismissed', () => {
    const pane = createBrowserPane();
    const onDismiss = vi.fn();
    const settings = createSettingsPanel({
      status: pane.surfaceStatus,
      onSnapshotApplied: vi.fn(),
      onDismiss,
    });
    pane.appendPanel(settings);

    pane.panelHost.open(settings);
    emitNavigationState();
    pane.element.querySelector<HTMLElement>('.settings-panel__close')?.click();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('lets Settings be dismissed before any page has loaded, revealing the home screen', () => {
    const { pane, settings } = build();
    const viewHost = pane.element.querySelector<HTMLElement>('.browser-view-host');
    const home = pane.element.querySelector<HTMLElement>('.browser-home');
    const close = pane.element.querySelector<HTMLElement>('.settings-panel__close');

    pane.panelHost.open(settings);
    // No page is loaded, yet the cross is enabled: dismissing reveals the home
    // screen.
    expect(close?.hasAttribute('disabled')).toBe(false);

    close?.click();
    expect(home?.hidden).toBe(false);
    expect(viewHost?.hidden).toBe(true);
  });

  it('selects a requested tab, so the agent banner can land on Agents', () => {
    const { settings } = build();
    const tabs = settings.element.querySelector<HTMLElement>('.settings-panel__tabs');

    expect(tabs?.getAttribute('selected')).toBe('hosts');
    settings.selectTab('agents');
    expect(tabs?.getAttribute('selected')).toBe('agents');
  });

  it('orders the strip so Proxies comes before Browser', () => {
    const { settings } = build();
    const values = [
      ...settings.element.querySelectorAll<HTMLElement>('.settings-panel__tabs sp-tab'),
    ].map((tab) => tab.getAttribute('value'));

    // Proxies defines the library entries the Browser tab's "(Default)" proxy
    // points at, so the definition reads before the setting that consumes it.
    expect(values.indexOf('proxies')).toBe(values.indexOf('browser') - 1);
    // The panels follow the same order as their tabs.
    const panelValues = [
      ...settings.element.querySelectorAll<HTMLElement>('.settings-panel__tab-panel'),
    ].map((panel) => panel.getAttribute('value'));
    expect(panelValues).toEqual(values);
  });

  it('puts the Updates tab last', () => {
    const { settings } = build();
    const values = [
      ...settings.element.querySelectorAll<HTMLElement>('.settings-panel__tabs sp-tab'),
    ].map((tab) => tab.getAttribute('value'));
    expect(values.at(-1)).toBe('updates');
  });

  it('shares the pane-owned surface-status row and owns no banner of its own', () => {
    const { pane, settings } = build();
    // The pane owns exactly one surface-status row (the panel is handed it),
    // and the panel surface carries no banner - so a message is never hidden
    // with the panel when it is dismissed.
    expect(pane.element.querySelectorAll('.surface-status-banner').length).toBe(1);
    expect(settings.element.querySelectorAll('.banner-row').length).toBe(0);
  });
});
