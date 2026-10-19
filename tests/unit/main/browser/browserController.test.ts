import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, type BrowserWindow, type Session, type WebContents } from 'electron';
import { createBrowserController } from '../../../../src/main/browser/browserController';
import { describeNetworkError } from '../../../../src/main/browser/networkErrorCopy';
import type { HostView } from '../../../../src/main/browser/hostView';
import type { WindowOpenRouter } from '../../../../src/main/browser/windowOpenRouter';
import type { ViewSession } from '../../../../src/main/webview';
import type { CertificateExceptionRecord } from '../../../../src/main/webview';
import { computeCertificateFingerprintHex } from '../../../../src/main/webview';
import type { SecretStore } from '../../../../src/main/secretStore';
import type { Logger } from '../../../../src/main/logger';
import { saveSettings, loadSettings } from '../../../../src/main/settingsStore';
import { newProxyId, newServerId } from '../../../../src/shared';
import { defaultAppSettings, type AppSettings } from '../../../../src/shared';
import { proxyConfigSchema, type ServerConfig } from '../../../../src/shared';
import type { BrowserNavigationState, ViewBounds } from '../../../../src/shared';
import {
  APP_SHORTCUT_CHANNEL,
  BROWSER_AGENT_NAVIGATION_CHANNEL,
  BROWSER_CERTIFICATE_BLOCKED_CHANNEL,
  BROWSER_FIND_RESULT_CHANNEL,
  BROWSER_SWITCH_STATE_CHANGED_CHANNEL,
} from '../../../../src/shared';
import { issueUntrustedLeafCert } from '../../../integration/support/testCa';
import { makeAuthorServer } from '../../../support/configFixtures';
import { makeInput } from '../../../support/electronInput';
import { createFakeWebContents, type FakeWebContents } from '../../../support/fakeWebContents';
import { createScratchDirs } from '../../../support/scratchDirs';

/**
 * `createBrowserController` unconditionally calls `app.on("certificate-error", ...)`
 * at construction and `app.removeListener` in `destroy()` - the only real
 * Electron *value* this module itself touches. Everything else it imports
 * from `electron` (`WebContentsView`/`screen` via `hostView.ts`) is only
 * referenced inside function bodies this suite never calls, since every test
 * injects a fake `HostView` through the `createView` seam instead of
 * letting the real factory run. `electron`'s own package resolves to a bare
 * path string
 * outside a real Electron process (`node_modules/electron/index.js`), so
 * those unused bindings would just be `undefined` - stubbing all four here
 * anyway is cheap and keeps this test insulated from that resolution detail.
 */
// `vi.hoisted` so the `vi.mock` factory (which is hoisted above the imports) can
// close over a named spy. A named `vi.fn` also avoids the `unbound-method`
// lint error that `shell.openExternal` referenced as a value would raise.
const { openExternalMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('electron', () => ({
  app: { on: vi.fn(), removeListener: vi.fn() },
  screen: { on: vi.fn(), removeListener: vi.fn() },
  shell: { openExternal: openExternalMock },
  WebContentsView: class {},
  BrowserWindow: class {},
}));

/** Scratch directories live under the project's own `test-results/`, never an OS temp dir. */
const scratch = createScratchDirs('main-unit-scratch', 'browserController-');
const createScratchRoot = scratch.create;

afterEach(() => {
  scratch.cleanup();
  vi.restoreAllMocks();
});

async function writeSettings(settingsDir: string, settings: AppSettings): Promise<void> {
  const result = await saveSettings(settingsDir, settings);
  if (!result.ok) throw new Error(`failed to write test settings: ${result.error.message}`);
}

const makeServer = (overrides: Partial<Record<string, unknown>> = {}): ServerConfig =>
  makeAuthorServer('server-a', overrides);

function settingsWithOneServer(server: ServerConfig): AppSettings {
  return {
    ...defaultAppSettings(),
    hosts: [server],
  };
}

/** A minimal in-memory `SecretStore` fake - browserController only ever calls `get` on it. */
function makeFakeSecretStore(passwords: Record<string, string> = {}): SecretStore {
  const store = new Map(Object.entries(passwords));
  return {
    set: vi.fn((secretRef: string, plainText: string) => {
      store.set(secretRef, plainText);
      return Promise.resolve();
    }),
    get: vi.fn((secretRef: string) => Promise.resolve(store.get(secretRef))),
    has: vi.fn((secretRef: string) => Promise.resolve(store.has(secretRef))),
    delete: vi.fn((secretRef: string) => {
      store.delete(secretRef);
      return Promise.resolve();
    }),
  };
}

function makeFakeLogger(): {
  logger: Logger;
  spies: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
} {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const logger: Logger = {
    info,
    warn,
    error,
    getHealth: vi.fn(() => ({
      writeFailureCount: 0,
      lastFailureCode: null,
      rotationCount: 0,
    })),
  };
  return { logger, spies: { info, warn, error } };
}

interface FakeAemViewControls {
  readonly view: HostView;
  readonly webContents: FakeWebContents;
  readonly loadURL: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly setBounds: ReturnType<typeof vi.fn>;
  readonly closePopups: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  loadURLImpl: (url: string) => Promise<void>;
  /** Sets the live document URL the fake reports, without a load. */
  setNavigationUrl: (url: string) => void;
}

/**
 * Builds a fake `HostView` plus a `createView` factory that always
 * returns it, so `createBrowserController` never touches a real
 * `WebContentsView`/`screen`/`BrowserWindow`. `loadURLImpl` is mutable so a
 * single instance can be reused across a test body that needs `loadURL` to
 * succeed for one call and reject for another (e.g. Task 1's network_error
 * path only kicks in for the second `switchServer` call).
 */
// The event-emitter-shaped `WebContents` fake is shared - see
// `tests/support/fakeWebContents.ts` (`createFakeWebContents`).

function makeFakeAemView(): FakeAemViewControls {
  // The live document URL the fake reports. `loadURL` records the URL it was
  // asked to load, so a test that needs "the pane is now on X" (e.g.
  // `openForAgent`'s post-settle check) gets it for free; tests may also set it
  // directly through `setNavigationUrl`.
  let navigationUrl = '';
  const loadURL = vi.fn(async (url: string) => {
    await controls.loadURLImpl(url);
  });
  const stop = vi.fn();
  const destroy = vi.fn();
  const closePopups = vi.fn();
  const setBounds = vi.fn();
  const windowOpenRouter: WindowOpenRouter = { attachTo: vi.fn(), closeAll: closePopups };
  const webContentsControls = createFakeWebContents();
  const view: HostView = {
    webContents: webContentsControls.webContents,
    windowOpenRouter,
    setBounds,
    getNavigationState: vi.fn((): BrowserNavigationState => ({
      url: navigationUrl,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      hasDocument: navigationUrl.length > 0,
    })),
    goBack: vi.fn(() => Promise.resolve({ ok: true as const })),
    goForward: vi.fn(() => Promise.resolve({ ok: true as const })),
    reload: vi.fn(() => Promise.resolve({ ok: true as const })),
    stop,
    loadURL,
    destroy,
  };
  const controls: FakeAemViewControls = {
    view,
    webContents: webContentsControls,
    loadURL,
    stop,
    setBounds,
    closePopups,
    destroy,
    loadURLImpl: (url) => {
      navigationUrl = url;
      return Promise.resolve();
    },
    setNavigationUrl: (url) => {
      navigationUrl = url;
    },
  };
  return controls;
}

interface FakeViewSessionControls {
  readonly viewSession: ViewSession;
  readonly switchProxy: ReturnType<typeof vi.fn>;
  readonly applyProxy: ReturnType<typeof vi.fn>;
  readonly approveCertificateException: ReturnType<typeof vi.fn>;
  switchProxyImpl: () => Promise<void>;
}

function makeFakeViewSession(): FakeViewSessionControls {
  const switchProxy = vi.fn(async () => {
    await controls.switchProxyImpl();
  });
  const applyProxy = vi.fn(() => Promise.resolve());
  const approveCertificateException = vi.fn(() => Promise.resolve());
  const viewSession: ViewSession = {
    session: {} as Session,
    switchProxy,
    applyProxy,
    approveCertificateException,
    listCertificateExceptions: vi.fn((): readonly CertificateExceptionRecord[] => []),
  };
  const controls: FakeViewSessionControls = {
    viewSession,
    switchProxy,
    applyProxy,
    approveCertificateException,
    switchProxyImpl: () => Promise.resolve(),
  };
  return controls;
}

/** A fake `WebContents` exposing only `send`, via `Reflect.set` on an empty-object cast rather than an `as unknown as` cast (project rule). */
function makeFakeRendererWebContents(): {
  readonly webContents: WebContents;
  readonly fake: FakeWebContents;
  readonly send: ReturnType<typeof vi.fn>;
  readonly emit: (event: string, ...args: unknown[]) => void;
} {
  const send = vi.fn();
  const fake = createFakeWebContents();
  fake.define('send', send);
  fake.define('focus', vi.fn());
  return {
    webContents: fake.webContents,
    fake,
    send,
    emit: (event: string, ...args: unknown[]) => fake.emit(event, ...args),
  };
}

/** Wires up a controller against a fresh scratch settings dir, with every collaborator fake by default. */
function makeControllerHarness(
  options: {
    secretStore?: SecretStore;
    /**
     * Runs after the fakes exist and before the controller is constructed, so a
     * test can graft spied methods (e.g. `setZoomMode`) that the constructor
     * calls.
     */
    configureFakes?: (fakes: {
      readonly hostView: FakeWebContents;
      readonly renderer: FakeWebContents;
    }) => void;
  } = {},
) {
  const settingsDir = createScratchRoot();
  const hostViewControls = makeFakeAemView();
  const viewSessionControls = makeFakeViewSession();
  const { logger, spies: loggerSpies } = makeFakeLogger();
  const secretStore = options.secretStore ?? makeFakeSecretStore();
  const {
    webContents: rendererWebContents,
    fake: rendererFake,
    send: rendererSend,
    emit: rendererEmit,
  } = makeFakeRendererWebContents();

  options.configureFakes?.({ hostView: hostViewControls.webContents, renderer: rendererFake });

  const controller = createBrowserController({
    settingsDir,
    secretStore,
    logger,
    viewSession: viewSessionControls.viewSession,
    window: {} as BrowserWindow,
    webviewPreloadPath: 'preload.js',
    rendererWebContents,
    createView: () => hostViewControls.view,
  });

  return {
    settingsDir,
    controller,
    hostViewControls,
    viewSessionControls,
    logger,
    loggerSpies,
    secretStore,
    rendererFake,
    rendererSend,
    rendererEmit,
  };
}

describe('browserController.openExternal', () => {
  beforeEach(() => {
    openExternalMock.mockClear();
    openExternalMock.mockResolvedValue(undefined);
  });

  it('hands a valid http(s) URL to the OS default browser', async () => {
    const harness = makeControllerHarness();

    const result = await harness.controller.openExternal({ url: 'https://external.example/x' });

    expect(result).toEqual({ ok: true });
    expect(openExternalMock).toHaveBeenCalledWith('https://external.example/x');
  });

  it('refuses a non-http(s) URL without ever calling the OS', async () => {
    const harness = makeControllerHarness();

    const result = await harness.controller.openExternal({ url: 'file:///etc/passwd' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.error.code).toBe('invalid_address');
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('reports open_external_failed when the OS call rejects', async () => {
    const harness = makeControllerHarness();
    openExternalMock.mockRejectedValueOnce(new Error('no handler registered'));

    const result = await harness.controller.openExternal({ url: 'https://external.example/x' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.error.code).toBe('open_external_failed');
  });
});

describe('browserController.navigate', () => {
  it('resolves a valid, configured address to its server and switches to it', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));

    const result = await harness.controller.navigate('https://author.example');

    expect(result).toEqual({ ok: true });
    // `URL` normalization gives a bare origin an explicit empty path, so the
    // loaded address is the origin plus a trailing slash. That is the same
    // resource; the assertion is exact rather than loose so that a future
    // change which appended anything else to a typed bare origin would fail.
    expect(harness.hostViewControls.loadURL).toHaveBeenCalledWith(`${server.origin}/`);
  });

  it('navigates to the full path of a pasted deep link rather than the server root', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));

    const result = await harness.controller.navigate(
      `${server.origin}/editor.html/content/site/en.html`,
    );

    expect(result).toEqual({ ok: true });
    expect(harness.hostViewControls.loadURL).toHaveBeenCalledWith(
      `${server.origin}/editor.html/content/site/en.html`,
    );
  });

  it('fails with invalid_address for text that is not a valid address', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, defaultAppSettings());

    const result = await harness.controller.navigate('not a url');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.error.code).toBe('invalid_address');
  });

  it('fails with unknown_origin and carries the origin, never auto-creating a server (requirements-decisions.md section 3)', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, defaultAppSettings());

    const result = await harness.controller.navigate('https://unconfigured.example');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.error.code).toBe('unknown_origin');
    expect(result.error.origin).toBe('https://unconfigured.example');
    // The point of the requirement: nothing was switched to and no server
    // was persisted.
    expect(harness.hostViewControls.loadURL).not.toHaveBeenCalled();
    const reloaded = await loadSettings(harness.settingsDir);
    expect(reloaded.ok && reloaded.value.settings.hosts).toEqual([]);
  });

  it('fails with storage_error when the settings file cannot be read, rather than throwing', async () => {
    const harness = makeControllerHarness();
    // Never written: `loadSettings` on a directory with no settings.json at
    // all still succeeds with defaults (see settingsStore.ts), so a genuine
    // failure has to be a corrupt file, not an absent one.
    mkdirSync(harness.settingsDir, { recursive: true });
    writeFileSync(path.join(harness.settingsDir, 'settings.json'), '{ not valid json', 'utf8');

    const result = await harness.controller.navigate('https://author.example');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.error.code).toBe('storage_error');
  });
});

describe('browserController.stop', () => {
  it('delegates to the AEM view and returns ok', () => {
    const harness = makeControllerHarness();

    const result = harness.controller.stop();

    expect(result).toEqual({ ok: true });
    expect(harness.hostViewControls.stop).toHaveBeenCalledTimes(1);
  });
});

describe('browserController.reload / goBack / goForward', () => {
  /**
   * The bug this pins: before `ChromeNavigationOutcome` existed, `reload()`
   * (and `goBack`/`goForward`) always returned `ok()` immediately, so a
   * `did-fail-load` observed later by `hostView.ts` was never reported
   * to the renderer at all - a dismissed error banner from an earlier failed
   * navigation never reappeared on a same-cause reload. These three now
   * await the AEM view's real outcome and map a failure to the identical
   * `network_error` shape `switchServer` already produces.
   */
  it('reload maps a failed AEM-view outcome to a structured network_error result', async () => {
    const harness = makeControllerHarness();
    harness.hostViewControls.view.reload = vi.fn(() =>
      Promise.resolve({
        ok: false,
        errorCode: 'ERR_CONNECTION_REFUSED',
        failedUrl: 'http://localhost:4502/',
      }),
    );

    const result = await harness.controller.reload();

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'network_error',
        message: describeNetworkError('ERR_CONNECTION_REFUSED', 'http://localhost:4502/'),
        errorCode: 'ERR_CONNECTION_REFUSED',
      },
    });
  });

  it('goBack maps a failed AEM-view outcome to a structured network_error result', async () => {
    const harness = makeControllerHarness();
    harness.hostViewControls.view.goBack = vi.fn(() =>
      Promise.resolve({
        ok: false,
        errorCode: 'ERR_NAME_NOT_RESOLVED',
        failedUrl: 'https://previous.example/',
      }),
    );

    const result = await harness.controller.goBack();

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'network_error',
        message: describeNetworkError('ERR_NAME_NOT_RESOLVED', 'https://previous.example/'),
        errorCode: 'ERR_NAME_NOT_RESOLVED',
      },
    });
  });

  it('goForward reports ok when the AEM view resolves the navigation without a real failure', async () => {
    const harness = makeControllerHarness();
    harness.hostViewControls.view.goForward = vi.fn(() => Promise.resolve({ ok: true as const }));

    const result = await harness.controller.goForward();

    expect(result).toEqual({ ok: true });
  });

  it('re-derives the active server from the committed URL after a successful history navigation', async () => {
    const server = makeServer({ origin: 'https://a.example' });
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    // The history restore committed a page on the configured host, but the
    // failed switch that preceded it had cleared the active server.
    harness.hostViewControls.view.getNavigationState = vi.fn(() => ({
      url: 'https://a.example/content/page.html',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    }));
    harness.hostViewControls.view.goBack = vi.fn(() => Promise.resolve({ ok: true as const }));

    const result = await harness.controller.goBack();

    expect(result).toEqual({ ok: true });
    expect(harness.controller.activeServer()).toEqual({
      serverId: server.id,
      origin: 'https://a.example',
      revision: server.revision,
    });
  });

  it('clears the active server after a history navigation to a non-host origin', async () => {
    const server = makeServer({ origin: 'https://a.example' });
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    harness.hostViewControls.view.getNavigationState = vi.fn(() => ({
      url: 'https://ims.example/oauth',
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      hasDocument: true,
    }));
    harness.hostViewControls.view.goBack = vi.fn(() => Promise.resolve({ ok: true as const }));

    await harness.controller.goBack();

    expect(harness.controller.activeServer()).toBeUndefined();
  });
});

describe('browserController active server follows the pane', () => {
  const server = makeServer({ origin: 'https://a.example' });

  it('adopts a configured host the pane committed on its own (an SSO login returning to it)', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    expect(harness.controller.activeServer()).toBeUndefined();

    harness.hostViewControls.setNavigationUrl('https://a.example/content/page.html');
    harness.hostViewControls.webContents.emit(
      'did-navigate',
      {},
      'https://a.example/content/page.html',
    );

    await vi.waitFor(() => {
      expect(harness.controller.activeServer()).toEqual({
        serverId: server.id,
        origin: 'https://a.example',
        revision: server.revision,
      });
    });
  });

  it('clears the active server when the pane commits on a non-host origin', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    await harness.controller.switchServer(server.id);
    expect(harness.controller.activeServer()).toBeDefined();

    harness.hostViewControls.setNavigationUrl('https://ims.example/oauth');
    harness.hostViewControls.webContents.emit('did-navigate', {}, 'https://ims.example/oauth');

    await vi.waitFor(() => {
      expect(harness.controller.activeServer()).toBeUndefined();
    });
  });

  it('does not adopt the error page a failed main-frame load left behind', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    const { webContents } = harness.hostViewControls;

    webContents.emit('did-start-navigation', {
      url: 'https://a.example/',
      isMainFrame: true,
      isSameDocument: false,
    });
    webContents.emit(
      'did-fail-load',
      {},
      -102,
      'ERR_CONNECTION_REFUSED',
      'https://a.example/',
      true,
    );
    harness.hostViewControls.setNavigationUrl('https://a.example/');
    webContents.emit('did-navigate', {}, 'https://a.example/');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.controller.activeServer()).toBeUndefined();
  });

  it('reads the server back from the pane when a switch load is cancelled by a redirect', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    harness.hostViewControls.loadURLImpl = () => {
      harness.hostViewControls.setNavigationUrl('https://a.example/content/page.html');
      return Promise.reject(new Error("ERR_ABORTED (-3) loading 'https://a.example/'"));
    };

    const result = await harness.controller.switchServer(server.id);

    expect(result.ok).toBe(false);
    expect(harness.controller.activeServer()).toEqual({
      serverId: server.id,
      origin: 'https://a.example',
      revision: server.revision,
    });
  });

  it('still reports no active server when a switch load really failed', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    harness.hostViewControls.loadURLImpl = () => {
      harness.hostViewControls.setNavigationUrl('https://a.example/');
      return Promise.reject(
        new Error("ERR_CONNECTION_REFUSED (-102) loading 'https://a.example/'"),
      );
    };

    await harness.controller.switchServer(server.id);

    expect(harness.controller.activeServer()).toBeUndefined();
  });
});

describe('browserController.switchServer', () => {
  it('fails with server_not_found for an id with no matching configured server', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, defaultAppSettings());

    const result = await harness.controller.switchServer(newServerId(() => 'missing'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.error.code).toBe('server_not_found');
  });

  it('supersedes an in-flight switch when a second switch is requested, and lands on the newer server', async () => {
    const serverA = makeServer({ id: newServerId(() => 'server-a'), origin: 'https://a.example' });
    const serverB = makeServer({ id: newServerId(() => 'server-b'), origin: 'https://b.example' });
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, {
      ...defaultAppSettings(),
      hosts: [serverA, serverB],
    });

    let loadURLCalls = 0;
    let rejectFirstLoad: ((error: Error) => void) | undefined;
    harness.hostViewControls.loadURLImpl = () => {
      loadURLCalls += 1;
      if (loadURLCalls === 1) {
        // The first switch's load never settles on its own; only the
        // superseding switch's `view.stop()` rejects it, exactly as Electron
        // aborts an in-flight `loadURL` when the pane is stopped.
        return new Promise<void>((_resolve, reject) => {
          rejectFirstLoad = reject;
        });
      }
      return Promise.resolve();
    };
    harness.hostViewControls.stop.mockImplementation(() => {
      rejectFirstLoad?.(new Error("ERR_ABORTED (-3) loading 'https://a.example'"));
    });

    const firstSwitch = harness.controller.switchServer(serverA.id);
    // `switchServer` awaits a real settings-file read before `switchTo` ever
    // flips state to "switching" - polling for the resulting
    // `browser:switch-state-changed` push (rather than a fixed number of
    // microtask ticks) is what makes this deterministic regardless of disk
    // I/O timing.
    await vi.waitFor(() => {
      expect(harness.rendererSend).toHaveBeenCalledWith(BROWSER_SWITCH_STATE_CHANGED_CHANNEL, {
        switching: true,
      });
    });

    const secondSwitch = harness.controller.switchServer(serverB.id);
    // The superseding switch stops the pane, which aborts the first (gated)
    // load; the first call then unwinds and the newer switch proceeds.
    const [firstResult, secondResult] = await Promise.all([firstSwitch, secondSwitch]);

    // The superseded switch is a benign no-op: the newer navigation owns the
    // outcome, so no spurious failure reaches the renderer.
    expect(firstResult).toEqual({ ok: true });
    expect(secondResult).toEqual({ ok: true });
    expect(harness.loggerSpies.info).toHaveBeenCalledWith('BROWSER_SWITCH_SUPERSEDED');
    // The active server is the newer one.
    expect(harness.controller.activeServer()).toEqual({
      serverId: serverB.id,
      origin: 'https://b.example',
      revision: serverB.revision,
    });
    expect(harness.hostViewControls.loadURL).toHaveBeenCalledWith(serverB.origin);
  });

  // NOTE: no test for the "no_active_view" outcome exists in this file,
  // deliberately. `createBrowserController` unconditionally assigns
  // `const hostView = buildView(...)` and passes `getView: () => hostView`
  // to `ServerSwitchController` - `hostView` is a plain, non-optional
  // `HostView` (the `createView` seam's return type has no
  // `| undefined`), so that closure can never return `undefined` through
  // this module's public API, no matter what `switchServer`/`navigate` are
  // called with. The "no_active_view" branch is real - `switchServer` maps
  // it to `{ code: "no_active_view", ... }` - but it is only reachable at
  // the `ServerSwitchController` level, where it already has a direct test
  // (`serverSwitch.test.ts`, `"reports no_active_view without touching the
  // session when there is no view yet"`). Forcing it open here would require
  // either loosening `createView`'s return type to accept `undefined` (a
  // production-code change out of this task's scope) or an `as unknown as`
  // cast this project's rules ban - so this is reported as a finding rather
  // than faked with a placeholder assertion.

  it('surfaces a rejected loadURL as a structured network_error result, not a thrown error (Task 1)', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    harness.hostViewControls.loadURLImpl = () => {
      throw new Error("ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://localhost:53158/nav'");
    };

    const result = await harness.controller.switchServer(server.id);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'network_error',
        // Humanised copy: the raw Chromium string never reaches the renderer.
        message: describeNetworkError('ERR_CERT_AUTHORITY_INVALID', server.origin),
        errorCode: 'ERR_CERT_AUTHORITY_INVALID',
      },
    });
    // "always returns to idle" - a second switch right after must not be
    // rejected as still-in-progress (it succeeds once `loadURL` is no
    // longer failing, proving the state machine is not stuck).
    harness.hostViewControls.loadURLImpl = () => Promise.resolve();
    const secondResult = await harness.controller.switchServer(server.id);
    expect(secondResult.ok).toBe(true);
  });

  it('surfaces a rejected switchProxy as a structured network_error result (Task 1)', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    harness.viewSessionControls.switchProxyImpl = () => {
      throw new Error("ERR_PROXY_CONNECTION_FAILED (-130) setting proxy 'https://proxy.example'");
    };

    const result = await harness.controller.switchServer(server.id);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'network_error',
        message: describeNetworkError('ERR_PROXY_CONNECTION_FAILED', server.origin),
        errorCode: 'ERR_PROXY_CONNECTION_FAILED',
      },
    });
    expect(harness.hostViewControls.loadURL).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected programmer error (no Chromium ERR_* code) rather than misreporting it as a network_error', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    harness.hostViewControls.loadURLImpl = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'foo')");
    };

    await expect(harness.controller.switchServer(server.id)).rejects.toThrow(
      'Cannot read properties of undefined',
    );
  });
});

describe('browserController certificate exceptions persist through the settings store', () => {
  it('approveCertificateException persists the exception on the server entry and applies it to the live session', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    const exception = {
      origin: server.origin,
      certificateSha256Fingerprint: 'a'.repeat(64),
      errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
    };

    const result = await harness.controller.approveCertificateException({
      serverId: server.id,
      exception,
    });

    expect(result).toEqual({ ok: true });
    expect(harness.viewSessionControls.approveCertificateException).toHaveBeenCalledWith(exception);
    const reloaded = await loadSettings(harness.settingsDir);
    if (!reloaded.ok) throw new Error('expected settings to reload');
    expect(reloaded.value.settings.hosts[0]?.tlsException).toEqual(exception);
  });

  it('approveCertificateException auto-retries the exact blocked URL when the approved origin matches it', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    const leaf = await issueUntrustedLeafCert('retry.example.test');
    const blockedUrl = `${server.origin}/editor.html/content/site/en.html`;
    const errorClass = 'net::ERR_CERT_AUTHORITY_INVALID';
    const exception = {
      origin: server.origin,
      certificateSha256Fingerprint: computeCertificateFingerprintHex(leaf.cert),
      errorClass,
    };

    driveCertificateError(harness, blockedUrl, errorClass, leaf.cert);
    expect(harness.rendererSend).toHaveBeenCalledWith(
      BROWSER_CERTIFICATE_BLOCKED_CHANNEL,
      exception,
    );

    const result = await harness.controller.approveCertificateException({
      serverId: server.id,
      exception,
    });

    expect(result).toEqual({ ok: true });
    // The blocked deep link, not the server root, was re-requested.
    expect(harness.hostViewControls.loadURL).toHaveBeenCalledWith(blockedUrl);
  });

  it('does not re-navigate after approval when the blocked origin differs from the approved exception', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    const leaf = await issueUntrustedLeafCert('other-origin.example.test');
    const foreignOrigin = 'https://other-origin.example.test';
    const errorClass = 'net::ERR_CERT_AUTHORITY_INVALID';
    const exception = {
      origin: foreignOrigin,
      certificateSha256Fingerprint: computeCertificateFingerprintHex(leaf.cert),
      errorClass,
    };

    driveCertificateError(harness, `${foreignOrigin}/page`, errorClass, leaf.cert);

    const result = await harness.controller.approveCertificateException({
      // Attach to the only configured server, per the renderer's contract.
      serverId: server.id,
      exception,
    });

    expect(result).toEqual({ ok: true });
    expect(harness.hostViewControls.loadURL).not.toHaveBeenCalled();
  });

  it('does not re-navigate after approval once a newer navigation has cleared the retry target', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    const leaf = await issueUntrustedLeafCert('stale-retry.example.test');
    const errorClass = 'net::ERR_CERT_AUTHORITY_INVALID';
    const exception = {
      origin: server.origin,
      certificateSha256Fingerprint: computeCertificateFingerprintHex(leaf.cert),
      errorClass,
    };

    driveCertificateError(harness, `${server.origin}/blocked`, errorClass, leaf.cert);
    await harness.controller.navigate(server.origin);

    const result = await harness.controller.approveCertificateException({
      serverId: server.id,
      exception,
    });

    expect(result).toEqual({ ok: true });
    // Only the manual navigate's load happened; the stale blocked URL was
    // not re-requested.
    expect(harness.hostViewControls.loadURL).toHaveBeenCalledTimes(1);
    expect(harness.hostViewControls.loadURL).toHaveBeenCalledWith(`${server.origin}/`);
  });
});

/**
 * Drives the real `certificate-error` listener the controller registered on
 * `app` at construction, the same way Electron would after a blocked
 * navigation. The listener is purely observational (rejects by default), so
 * the harness only has to invoke it with an event/`webContents` pair that
 * passes the AEM-session comparison.
 */
function driveCertificateError(
  harness: ReturnType<typeof makeControllerHarness>,
  url: string,
  errorClass: string,
  certificatePem: string,
): void {
  const registration = vi
    .mocked(app)
    .on.mock.calls.find((call) => (call[0] as string) === 'certificate-error');
  const listener = registration?.[1] as
    | ((
        event: { preventDefault(): void },
        webContents: { session: unknown },
        u: string,
        error: string,
        certificate: { data: string },
        callback: (isTrusted: boolean) => void,
      ) => void)
    | undefined;
  if (listener === undefined) {
    throw new Error('controller did not register a certificate-error listener');
  }
  listener(
    { preventDefault: () => undefined },
    { session: harness.viewSessionControls.viewSession.session },
    url,
    errorClass,
    { data: certificatePem },
    () => undefined,
  );
}

describe('browserController navigation epoch', () => {
  it('starts at a stable value and exposes it for request stamping', () => {
    const harness = makeControllerHarness();
    expect(harness.controller.navigationEpoch.current()).toBe(0);
  });

  it('invalidates in-flight requests when the view begins loading a different document', () => {
    // Driven through the real listener the controller registered, not through
    // the tracker directly - a tracker that works but was never attached would
    // otherwise still pass.
    const harness = makeControllerHarness();
    const before = harness.controller.navigationEpoch.current();

    harness.hostViewControls.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });

    expect(harness.controller.navigationEpoch.current()).toBeGreaterThan(before);
  });

  it('does not invalidate on same-document navigation, which AEM authoring performs constantly', () => {
    const harness = makeControllerHarness();
    const before = harness.controller.navigationEpoch.current();

    harness.hostViewControls.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true,
    });

    expect(harness.controller.navigationEpoch.current()).toBe(before);
  });

  it('invalidates when switching servers, so a reply from the outgoing server is never honoured', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    const before = harness.controller.navigationEpoch.current();

    await harness.controller.switchServer(server.id);

    expect(harness.controller.navigationEpoch.current()).toBeGreaterThan(before);
  });

  it('invalidates even when the switch fails, because the view is no longer trustworthy either way', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    harness.hostViewControls.loadURLImpl = () =>
      Promise.reject(new Error('net::ERR_CONNECTION_REFUSED'));
    const before = harness.controller.navigationEpoch.current();

    const result = await harness.controller.switchServer(server.id);

    expect(result.ok).toBe(false);
    expect(harness.controller.navigationEpoch.current()).toBeGreaterThan(before);
  });

  it('does not invalidate when the requested server does not exist and nothing was attempted', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, defaultAppSettings());
    const before = harness.controller.navigationEpoch.current();

    const result = await harness.controller.switchServer(makeServer().id);

    expect(result.ok).toBe(false);
    expect(harness.controller.navigationEpoch.current()).toBe(before);
  });

  it('invalidates on destroy and then stops listening to the view', () => {
    const harness = makeControllerHarness();
    harness.controller.destroy();
    const afterDestroy = harness.controller.navigationEpoch.current();
    expect(afterDestroy).toBeGreaterThan(0);

    harness.hostViewControls.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });

    expect(harness.controller.navigationEpoch.current()).toBe(afterDestroy);
  });
});

describe('browserController per-origin proxy reconciliation', () => {
  const corporate = proxyConfigSchema.parse({
    id: newProxyId(() => 'proxy-corp'),
    label: 'Corporate',
    url: 'https://proxy.example:8080',
  });
  const fallback = proxyConfigSchema.parse({
    id: newProxyId(() => 'proxy-default'),
    label: 'Default',
    url: 'https://default-proxy.example:3128',
  });
  const serverA = makeServer({
    id: newServerId(() => 'server-a'),
    origin: 'https://a.example',
    proxyId: corporate.id,
  });
  const serverB = makeServer({
    id: newServerId(() => 'server-b'),
    origin: 'https://b.example',
    proxyId: 'none',
  });
  const settingsWithProxies: AppSettings = {
    ...defaultAppSettings(),
    hosts: [serverA, serverB],
    proxies: [corporate, fallback],
    browser: { disableNativeWebAuthn: true, proxy: fallback.id },
  };

  function driveMainFrameNavigation(
    harness: ReturnType<typeof makeControllerHarness>,
    url: string,
  ): void {
    harness.hostViewControls.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url,
    });
  }

  it('applies the browser default proxy for an origin that is not a configured host', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithProxies);

    driveMainFrameNavigation(harness, 'https://ims.example/oauth');

    await vi.waitFor(() => {
      expect(harness.viewSessionControls.applyProxy).toHaveBeenCalledWith(
        fallback,
        expect.any(Function),
      );
    });
  });

  it('honours a host\'s explicit entry and its explicit "No proxy"', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithProxies);

    driveMainFrameNavigation(harness, 'https://a.example/editor.html');
    await vi.waitFor(() => {
      expect(harness.viewSessionControls.applyProxy).toHaveBeenCalledWith(
        corporate,
        expect.any(Function),
      );
    });

    driveMainFrameNavigation(harness, 'https://b.example/editor.html');
    await vi.waitFor(() => {
      expect(harness.viewSessionControls.applyProxy).toHaveBeenCalledWith(
        undefined,
        expect.any(Function),
      );
    });
  });

  it('does not re-apply when the origin resolves to the proxy already in effect', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithProxies);

    driveMainFrameNavigation(harness, 'https://ims.example/one');
    await vi.waitFor(() => {
      expect(harness.viewSessionControls.applyProxy).toHaveBeenCalledTimes(1);
    });

    driveMainFrameNavigation(harness, 'https://other-ims.example/two');

    await Promise.resolve();
    await Promise.resolve();
    expect(harness.viewSessionControls.applyProxy).toHaveBeenCalledTimes(1);
  });

  it('follows a cross-origin redirect through will-redirect', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithProxies);

    harness.hostViewControls.webContents.emit('will-redirect', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://ims.example/after-redirect',
    });

    await vi.waitFor(() => {
      expect(harness.viewSessionControls.applyProxy).toHaveBeenCalledWith(
        fallback,
        expect.any(Function),
      );
    });
  });

  it('sets the applied proxy on a successful switch, so a navigation to the same host is a no-op', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithProxies);

    await harness.controller.switchServer(serverA.id);
    expect(harness.viewSessionControls.switchProxy).toHaveBeenCalledWith(
      corporate,
      expect.any(Function),
    );

    driveMainFrameNavigation(harness, 'https://a.example/other');

    await Promise.resolve();
    await Promise.resolve();
    expect(harness.viewSessionControls.applyProxy).not.toHaveBeenCalled();
  });
});

describe('browserController.activeServer', () => {
  it('reports undefined before any server has been switched to, rather than a fabricated placeholder', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, defaultAppSettings());

    expect(harness.controller.activeServer()).toBeUndefined();
  });

  it("reports the server's id, origin, and revision once a switch succeeds", async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));

    const result = await harness.controller.switchServer(server.id);

    expect(result).toEqual({ ok: true });
    expect(harness.controller.activeServer()).toEqual({
      serverId: server.id,
      origin: server.origin,
      revision: server.revision,
    });
  });

  it('clears to undefined when a switch fails, rather than continuing to report the previous server', async () => {
    const serverA = makeServer({ id: newServerId(() => 'server-a'), origin: 'https://a.example' });
    const serverB = makeServer({ id: newServerId(() => 'server-b'), origin: 'https://b.example' });
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, {
      ...defaultAppSettings(),
      hosts: [serverA, serverB],
    });
    await harness.controller.switchServer(serverA.id);
    expect(harness.controller.activeServer()?.serverId).toBe(serverA.id);
    harness.hostViewControls.loadURLImpl = () =>
      Promise.reject(new Error('net::ERR_CONNECTION_REFUSED'));

    const result = await harness.controller.switchServer(serverB.id);

    expect(result.ok).toBe(false);
    expect(harness.controller.activeServer()).toBeUndefined();
  });

  it('does not change on a switch to a nonexistent server id', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    await harness.controller.switchServer(server.id);

    const result = await harness.controller.switchServer(newServerId(() => 'missing'));

    expect(result.ok).toBe(false);
    expect(harness.controller.activeServer()?.serverId).toBe(server.id);
  });

  it('refreshes the reported revision after a certificate-exception change to the active server', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    await harness.controller.switchServer(server.id);
    const before = harness.controller.activeServer();

    const result = await harness.controller.approveCertificateException({
      serverId: server.id,
      exception: {
        origin: server.origin,
        certificateSha256Fingerprint: 'a'.repeat(64),
        errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
      },
    });

    expect(result).toEqual({ ok: true });
    const after = harness.controller.activeServer();
    expect(after?.serverId).toBe(server.id);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? -1);
  });

  it('does not report a certificate-exception change to a different, inactive server', async () => {
    const serverA = makeServer({ id: newServerId(() => 'server-a'), origin: 'https://a.example' });
    const serverB = makeServer({ id: newServerId(() => 'server-b'), origin: 'https://b.example' });
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, {
      ...defaultAppSettings(),
      hosts: [serverA, serverB],
    });
    await harness.controller.switchServer(serverA.id);
    const before = harness.controller.activeServer();

    await harness.controller.approveCertificateException({
      serverId: serverB.id,
      exception: {
        origin: serverB.origin,
        certificateSha256Fingerprint: 'b'.repeat(64),
        errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
      },
    });

    expect(harness.controller.activeServer()).toEqual(before);
  });
});

describe('browserController same-origin navigation and invalidation logging', () => {
  it('does NOT invalidate on a same-origin navigation, and logs it as BROWSER_NAVIGATION', async () => {
    const server = makeServer(); // origin https://author.example
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    await harness.controller.switchServer(server.id);
    const before = harness.controller.navigationEpoch.current();

    harness.hostViewControls.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://author.example/content/other.html',
    });

    expect(harness.controller.navigationEpoch.current()).toBe(before);
    expect(harness.loggerSpies.info).toHaveBeenCalledWith('BROWSER_NAVIGATION', expect.anything());
  });

  it('still invalidates on a cross-origin navigation while a server is active', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    await harness.controller.switchServer(server.id);
    const before = harness.controller.navigationEpoch.current();

    harness.hostViewControls.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://ims.example/oauth',
    });

    expect(harness.controller.navigationEpoch.current()).toBeGreaterThan(before);
  });

  it('does NOT invalidate an app navigation (chat link) that stays on the active origin', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    await harness.controller.switchServer(server.id);
    const before = harness.controller.navigationEpoch.current();
    harness.loggerSpies.info.mockClear();

    // The exact path a transcript link takes: `navigate` resolves the URL
    // against the configured hosts and calls `switchServer(id, url)`. Same
    // origin, so the AEM context is unchanged and the turn must survive.
    const result = await harness.controller.navigate(
      'https://author.example/crx/de/index.jsp#/content/other',
    );

    expect(result.ok).toBe(true);
    expect(harness.controller.navigationEpoch.current()).toBe(before);
    const codes = harness.loggerSpies.info.mock.calls.map((call) => call[0] as string);
    expect(codes).not.toContain('BROWSER_SWITCH_STARTED');
    expect(codes).toContain('BROWSER_SWITCH_COMPLETED');
  });

  it('still invalidates a switch to a different origin while a server is active', async () => {
    const serverA = makeServer();
    const serverB = makeServer({
      id: newServerId(() => 'server-b'),
      origin: 'https://other.example',
    });
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, {
      ...defaultAppSettings(),
      hosts: [serverA, serverB],
    });
    await harness.controller.switchServer(serverA.id);
    const before = harness.controller.navigationEpoch.current();

    await harness.controller.switchServer(serverB.id);

    expect(harness.controller.navigationEpoch.current()).toBeGreaterThan(before);
  });

  it('logs the start and completion of a server switch', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));

    await harness.controller.switchServer(server.id);

    const codes = harness.loggerSpies.info.mock.calls.map((call) => call[0] as string);
    expect(codes).toContain('BROWSER_SWITCH_STARTED');
    expect(codes).toContain('BROWSER_SWITCH_COMPLETED');
  });

  it('logs the invalidation cause when the view is destroyed', () => {
    const harness = makeControllerHarness();
    harness.controller.destroy();
    expect(harness.loggerSpies.info).toHaveBeenCalledWith('BROWSER_VIEW_DESTROYED');
  });
});

describe('browserController.openForAgent', () => {
  it('opens a same-host page and reports it as not switched', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    await harness.controller.switchServer(server.id);

    const result = await harness.controller.openForAgent({
      serverId: server.id,
      path: '/content/wknd.html',
    });

    expect(result).toEqual({
      kind: 'opened',
      url: 'https://author.example/content/wknd.html',
      switched: false,
    });
    expect(harness.hostViewControls.loadURL).toHaveBeenLastCalledWith(
      'https://author.example/content/wknd.html',
    );
  });

  it('tells the renderer to reveal the destination when an agent navigation begins', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    await harness.controller.switchServer(server.id);
    harness.rendererSend.mockClear();

    await harness.controller.openForAgent({
      serverId: server.id,
      path: '/content/wknd.html',
    });

    expect(harness.rendererSend).toHaveBeenCalledWith(BROWSER_AGENT_NAVIGATION_CHANNEL);
  });

  it('reveals nothing when the agent navigation never starts', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    harness.rendererSend.mockClear();

    // An invalid path and an unknown server are rejected before any navigation,
    // so nothing is revealed and no page is left half-shown.
    await harness.controller.openForAgent({ serverId: server.id, path: 'https://evil.example/x' });
    await harness.controller.openForAgent({
      serverId: newServerId(() => 'missing'),
      path: '/content/x.html',
    });

    expect(harness.rendererSend).not.toHaveBeenCalledWith(BROWSER_AGENT_NAVIGATION_CHANNEL);
  });

  it('attributes a cross-host agent switch to the agent', async () => {
    const serverA = makeServer();
    const serverB = makeServer({
      id: newServerId(() => 'server-b'),
      origin: 'https://other.example',
    });
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, {
      ...defaultAppSettings(),
      hosts: [serverA, serverB],
    });
    await harness.controller.switchServer(serverA.id);

    const changes: Array<{ reason: string; initiator: string }> = [];
    harness.controller.navigationEpoch.subscribe((change) => {
      changes.push({ reason: change.reason, initiator: change.initiator });
    });

    const result = await harness.controller.openForAgent({
      serverId: serverB.id,
      path: '/content/other.html',
    });

    expect(result).toEqual({
      kind: 'opened',
      url: 'https://other.example/content/other.html',
      switched: true,
    });
    expect(changes).toContainEqual({ reason: 'server_switch', initiator: 'agent' });
    // The `did-start-navigation`-style bump the tracker would emit is driven
    // separately in `navigationEpoch.test.ts`; here the manual bump is enough.
  });

  it('refuses an invalid path without loading anything', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));

    const result = await harness.controller.openForAgent({
      serverId: server.id,
      path: 'https://evil.example/x',
    });

    expect(result).toEqual({ kind: 'invalid_path' });
    expect(harness.hostViewControls.loadURL).not.toHaveBeenCalled();
  });

  it('reports an unknown server', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(makeServer()));

    const result = await harness.controller.openForAgent({
      serverId: newServerId(() => 'missing'),
      path: '/content/x.html',
    });

    expect(result).toEqual({ kind: 'server_not_found' });
  });

  it('cancels, and bumps as a user navigation, when the pane did not land on the target host', async () => {
    const serverA = makeServer();
    const serverB = makeServer({
      id: newServerId(() => 'server-b'),
      origin: 'https://other.example',
    });
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, {
      ...defaultAppSettings(),
      hosts: [serverA, serverB],
    });
    await harness.controller.switchServer(serverA.id);
    // The load never commits the new document (a page-initiated navigation
    // raced it), so the pane is still on server A after the switch.
    harness.hostViewControls.loadURLImpl = () => Promise.resolve();

    const changes: Array<{ initiator: string }> = [];
    harness.controller.navigationEpoch.subscribe((change) => {
      changes.push({ initiator: change.initiator });
    });

    const result = await harness.controller.openForAgent({
      serverId: serverB.id,
      path: '/content/other.html',
    });

    expect(result).toEqual({ kind: 'cancelled' });
    expect(changes).toContainEqual({ initiator: 'user' });
  });
});

describe('browserController application shortcuts', () => {
  it('pushes the semantic action for a keystroke on the shell', () => {
    const harness = makeControllerHarness();
    harness.rendererSend.mockClear();

    harness.rendererEmit(
      'before-input-event',
      { preventDefault: vi.fn() },
      makeInput('KeyH', { control: true }),
    );

    expect(harness.rendererSend).toHaveBeenCalledWith(APP_SHORTCUT_CHANNEL, 'chat.history');
  });

  it('pushes a browser-navigation action from the AEM view, but never a chat action', () => {
    const harness = makeControllerHarness();
    harness.rendererSend.mockClear();

    harness.hostViewControls.webContents.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      makeInput('ArrowLeft', { alt: true }),
    );
    expect(harness.rendererSend).toHaveBeenCalledWith(APP_SHORTCUT_CHANNEL, 'browser.back');

    harness.rendererSend.mockClear();
    harness.hostViewControls.webContents.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      makeInput('KeyH', { control: true }),
    );
    expect(harness.rendererSend).not.toHaveBeenCalled();
  });

  it('consumes a claimed key so the page never also sees it', () => {
    const harness = makeControllerHarness();
    const preventDefault = vi.fn();

    harness.hostViewControls.webContents.emit(
      'before-input-event',
      { preventDefault },
      makeInput('F5'),
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('applies a zoom key to the source view without pushing an action', () => {
    const harness = makeControllerHarness();
    const setZoomLevel = vi.fn();
    harness.hostViewControls.webContents.define(
      'getZoomLevel',
      vi.fn(() => 0),
    );
    harness.hostViewControls.webContents.define('setZoomLevel', setZoomLevel);
    harness.rendererSend.mockClear();

    harness.hostViewControls.webContents.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      makeInput('NumpadAdd', { control: true }),
    );

    expect(setZoomLevel).toHaveBeenCalledWith(1);
    expect(harness.rendererSend).not.toHaveBeenCalled();
  });
});

describe('browserController zoom', () => {
  it('puts each view in a zoom mode that actually zooms the page (manual and disabled do not)', () => {
    const aemSetZoomMode = vi.fn();
    const shellSetZoomMode = vi.fn();

    makeControllerHarness({
      configureFakes: (fakes) => {
        fakes.hostView.define('setZoomMode', aemSetZoomMode);
        fakes.renderer.define('setZoomMode', shellSetZoomMode);
      },
    });

    expect(aemSetZoomMode).toHaveBeenCalledWith('isolated');
    expect(shellSetZoomMode).toHaveBeenCalledWith('isolated');
  });

  it('converts the reserved-region rectangle from CSS pixels to DIP by the shell zoom factor', () => {
    const harness = makeControllerHarness({
      configureFakes: (fakes) =>
        fakes.renderer.define(
          'getZoomFactor',
          vi.fn(() => 2),
        ),
    });
    const bounds: ViewBounds = { x: 5, y: 10, width: 100, height: 200 };

    harness.controller.setViewBounds(bounds);

    expect(harness.hostViewControls.setBounds).toHaveBeenCalledWith({
      x: 10,
      y: 20,
      width: 200,
      height: 400,
    });
  });

  it('passes the rectangle through unchanged at 100%', () => {
    const harness = makeControllerHarness();
    const bounds: ViewBounds = { x: 5, y: 10, width: 100, height: 200 };

    harness.controller.setViewBounds(bounds);

    expect(harness.hostViewControls.setBounds).toHaveBeenCalledWith(bounds);
  });
});

describe('browserController find-in-page', () => {
  it('routes a browser-target request to the AEM view and advances the session', () => {
    const harness = makeControllerHarness();
    const findInPage = vi.fn(() => 7);
    harness.hostViewControls.webContents.define('findInPage', findInPage);

    const result = harness.controller.find({ target: 'browser', text: 'needle', forward: true });

    expect(result).toEqual({ ok: true });
    // Electron 44 only emits `found-in-page` for `findNext: true`, so main always
    // sends it; the changed/unchanged text is what starts vs. steps the session.
    expect(findInPage).toHaveBeenCalledWith('needle', { forward: true, findNext: true });
  });

  it('routes a chat-target request to the shell document', () => {
    const harness = makeControllerHarness();
    const findInPage = vi.fn(() => 1);
    harness.rendererFake.define('findInPage', findInPage);

    harness.controller.find({ target: 'chat', text: 'needle', forward: false });

    expect(findInPage).toHaveBeenCalledWith('needle', { forward: false, findNext: true });
  });

  it('pushes the match count for the request it issued, and drops a stale result', () => {
    const harness = makeControllerHarness();
    harness.hostViewControls.webContents.define(
      'findInPage',
      vi.fn(() => 7),
    );
    harness.rendererSend.mockClear();

    harness.controller.find({ target: 'browser', text: 'needle', forward: true });
    harness.hostViewControls.webContents.emit(
      'found-in-page',
      {},
      { requestId: 7, matches: 4, activeMatchOrdinal: 2 },
    );

    expect(harness.rendererSend).toHaveBeenCalledWith(BROWSER_FIND_RESULT_CHANNEL, {
      target: 'browser',
      matches: 4,
      activeMatchOrdinal: 2,
    });

    harness.rendererSend.mockClear();
    harness.hostViewControls.webContents.emit(
      'found-in-page',
      {},
      { requestId: 999, matches: 4, activeMatchOrdinal: 2 },
    );
    expect(harness.rendererSend).not.toHaveBeenCalled();
  });

  it('marks a shell-document result as the chat target', () => {
    const harness = makeControllerHarness();
    harness.rendererFake.define(
      'findInPage',
      vi.fn(() => 3),
    );
    harness.rendererSend.mockClear();

    harness.controller.find({ target: 'chat', text: 'x', forward: true });
    harness.rendererEmit('found-in-page', {}, { requestId: 3, matches: 1, activeMatchOrdinal: 1 });

    expect(harness.rendererSend).toHaveBeenCalledWith(BROWSER_FIND_RESULT_CHANNEL, {
      target: 'chat',
      matches: 1,
      activeMatchOrdinal: 1,
    });
  });

  it("stopFind clears the target document's selection", () => {
    const harness = makeControllerHarness();
    const stopFindInPage = vi.fn();
    harness.hostViewControls.webContents.define('stopFindInPage', stopFindInPage);

    const result = harness.controller.stopFind({ target: 'browser' });

    expect(result).toEqual({ ok: true });
    expect(stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });
});
