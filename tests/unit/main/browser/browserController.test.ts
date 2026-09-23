import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, type BrowserWindow, type Session, type WebContents } from 'electron';
import { createBrowserController } from '../../../../src/main/browser/browserController';
import { describeNetworkError } from '../../../../src/main/browser/networkErrorCopy';
import type { AemBrowserView } from '../../../../src/main/browser/aemBrowserView';
import type { WindowOpenRouter } from '../../../../src/main/browser/windowOpenRouter';
import type { AemSession } from '../../../../src/main/aem';
import type { CertificateExceptionRecord } from '../../../../src/main/aem';
import { computeCertificateFingerprintHex } from '../../../../src/main/aem';
import type { SecretStore } from '../../../../src/main/secretStore';
import type { Logger } from '../../../../src/main/logger';
import { saveSettings, loadSettings } from '../../../../src/main/settingsStore';
import { newProxyId, newServerId } from '../../../../src/shared';
import { defaultAppSettings, type AppSettings } from '../../../../src/shared';
import { proxyConfigSchema, serverConfigSchema, type ServerConfig } from '../../../../src/shared';
import type { BrowserNavigationState } from '../../../../src/shared';
import {
  BROWSER_CERTIFICATE_BLOCKED_CHANNEL,
  BROWSER_SWITCH_STATE_CHANGED_CHANNEL,
} from '../../../../src/shared';
import { issueUntrustedLeafCert } from '../../../integration/support/testCa';

/**
 * `createBrowserController` unconditionally calls `app.on("certificate-error", ...)`
 * at construction and `app.removeListener` in `destroy()` - the only real
 * Electron *value* this module itself touches. Everything else it imports
 * from `electron` (`WebContentsView`/`screen` via `aemBrowserView.ts`) is only
 * referenced inside function bodies this suite never calls, since every test
 * injects a fake `AemBrowserView` through the `createAemView` seam instead of
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
const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'main-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'browserController-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function writeSettings(settingsDir: string, settings: AppSettings): Promise<void> {
  const result = await saveSettings(settingsDir, settings);
  if (!result.ok) throw new Error(`failed to write test settings: ${result.error.message}`);
}

function makeServer(overrides: Partial<Record<string, unknown>> = {}): ServerConfig {
  return serverConfigSchema.parse({
    id: newServerId(() => 'server-a'),
    label: 'Author',
    origin: 'https://author.example',
    color: { kind: 'swatch', swatch: 'blue' },
    revision: 0,
    ...overrides,
  });
}

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
  readonly view: AemBrowserView;
  readonly webContents: FakeWebContentsControls;
  readonly loadURL: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly closePopups: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  loadURLImpl: (url: string) => Promise<void>;
}

/**
 * Builds a fake `AemBrowserView` plus a `createAemView` factory that always
 * returns it, so `createBrowserController` never touches a real
 * `WebContentsView`/`screen`/`BrowserWindow`. `loadURLImpl` is mutable so a
 * single instance can be reused across a test body that needs `loadURL` to
 * succeed for one call and reject for another (e.g. Task 1's network_error
 * path only kicks in for the second `switchServer` call).
 */
interface FakeWebContentsControls {
  readonly webContents: WebContents;
  /** Drives a listener the production code registered, as Electron would. */
  emit(event: string, ...args: unknown[]): void;
  listenerCount(event: string): number;
}

/**
 * A minimal event-emitter-shaped `WebContents`. It exists because the
 * controller now attaches navigation-epoch tracking to the AEM view's
 * `webContents`, and an empty object literal cannot record listeners - but
 * more usefully, it lets a test *drive* a navigation and observe the epoch
 * move, which is the only way to check that the wiring is real rather than
 * merely present.
 */
function makeFakeWebContents(): FakeWebContentsControls {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const add = (event: string, listener: (...args: never[]) => void): void => {
    const existing = listeners.get(event) ?? new Set();
    existing.add(listener);
    listeners.set(event, existing);
  };
  const webContents = {
    on: (event: string, listener: (...args: never[]) => void) => {
      add(event, listener);
      return webContents;
    },
    once: (event: string, listener: (...args: never[]) => void) => {
      add(event, listener);
      return webContents;
    },
    off: (event: string, listener: (...args: never[]) => void) => {
      listeners.get(event)?.delete(listener);
      return webContents;
    },
    isDestroyed: () => false,
  } as unknown as WebContents;
  return {
    webContents,
    emit: (event, ...args) => {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        (listener as (...callArgs: unknown[]) => void)(...args);
      }
    },
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
  };
}

function makeFakeAemView(): FakeAemViewControls {
  const loadURL = vi.fn(async (url: string) => {
    await controls.loadURLImpl(url);
  });
  const stop = vi.fn();
  const destroy = vi.fn();
  const closePopups = vi.fn();
  const windowOpenRouter: WindowOpenRouter = { attachTo: vi.fn(), closeAll: closePopups };
  const navigationState: BrowserNavigationState = {
    url: '',
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  };
  const webContentsControls = makeFakeWebContents();
  const view: AemBrowserView = {
    webContents: webContentsControls.webContents,
    windowOpenRouter,
    setBounds: vi.fn(),
    getNavigationState: vi.fn(() => navigationState),
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
    closePopups,
    destroy,
    loadURLImpl: () => Promise.resolve(),
  };
  return controls;
}

interface FakeAemSessionControls {
  readonly aemSession: AemSession;
  readonly switchProxy: ReturnType<typeof vi.fn>;
  readonly applyProxy: ReturnType<typeof vi.fn>;
  readonly approveCertificateException: ReturnType<typeof vi.fn>;
  switchProxyImpl: () => Promise<void>;
}

function makeFakeAemSession(): FakeAemSessionControls {
  const switchProxy = vi.fn(async () => {
    await controls.switchProxyImpl();
  });
  const applyProxy = vi.fn(() => Promise.resolve());
  const approveCertificateException = vi.fn(() => Promise.resolve());
  const aemSession: AemSession = {
    session: {} as Session,
    switchProxy,
    applyProxy,
    approveCertificateException,
    listCertificateExceptions: vi.fn((): readonly CertificateExceptionRecord[] => []),
  };
  const controls: FakeAemSessionControls = {
    aemSession,
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
  readonly send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const webContents = {} as WebContents;
  Reflect.set(webContents, 'send', send);
  return { webContents, send };
}

/** Wires up a controller against a fresh scratch settings dir, with every collaborator fake by default. */
function makeControllerHarness(options: { secretStore?: SecretStore } = {}) {
  const settingsDir = createScratchRoot();
  const aemViewControls = makeFakeAemView();
  const aemSessionControls = makeFakeAemSession();
  const { logger, spies: loggerSpies } = makeFakeLogger();
  const secretStore = options.secretStore ?? makeFakeSecretStore();
  const { webContents: rendererWebContents, send: rendererSend } = makeFakeRendererWebContents();

  const controller = createBrowserController({
    settingsDir,
    secretStore,
    logger,
    aemSession: aemSessionControls.aemSession,
    window: {} as BrowserWindow,
    aemPreloadPath: 'preload.js',
    rendererWebContents,
    createAemView: () => aemViewControls.view,
  });

  return {
    settingsDir,
    controller,
    aemViewControls,
    aemSessionControls,
    logger,
    loggerSpies,
    secretStore,
    rendererSend,
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
    expect(harness.aemViewControls.loadURL).toHaveBeenCalledWith(`${server.origin}/`);
  });

  it('navigates to the full path of a pasted deep link rather than the server root', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));

    const result = await harness.controller.navigate(
      `${server.origin}/editor.html/content/site/en.html`,
    );

    expect(result).toEqual({ ok: true });
    expect(harness.aemViewControls.loadURL).toHaveBeenCalledWith(
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
    expect(harness.aemViewControls.loadURL).not.toHaveBeenCalled();
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
    expect(harness.aemViewControls.stop).toHaveBeenCalledTimes(1);
  });
});

describe('browserController.reload / goBack / goForward', () => {
  /**
   * The bug this pins: before `ChromeNavigationOutcome` existed, `reload()`
   * (and `goBack`/`goForward`) always returned `ok()` immediately, so a
   * `did-fail-load` observed later by `aemBrowserView.ts` was never reported
   * to the renderer at all - a dismissed error banner from an earlier failed
   * navigation never reappeared on a same-cause reload. These three now
   * await the AEM view's real outcome and map a failure to the identical
   * `network_error` shape `switchServer` already produces.
   */
  it('reload maps a failed AEM-view outcome to a structured network_error result', async () => {
    const harness = makeControllerHarness();
    harness.aemViewControls.view.reload = vi.fn(() =>
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
    harness.aemViewControls.view.goBack = vi.fn(() =>
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
    harness.aemViewControls.view.goForward = vi.fn(() => Promise.resolve({ ok: true as const }));

    const result = await harness.controller.goForward();

    expect(result).toEqual({ ok: true });
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

  it('fails with switch_in_progress when a second switch is requested while one is still in flight', async () => {
    const serverA = makeServer({ id: newServerId(() => 'server-a'), origin: 'https://a.example' });
    const serverB = makeServer({ id: newServerId(() => 'server-b'), origin: 'https://b.example' });
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, {
      ...defaultAppSettings(),
      hosts: [serverA, serverB],
    });

    let releaseFirstLoad!: () => void;
    const firstLoadGate = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    harness.aemViewControls.loadURLImpl = async () => {
      await firstLoadGate;
    };

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

    const secondResult = await harness.controller.switchServer(serverB.id);
    releaseFirstLoad();
    const firstResult = await firstSwitch;

    expect(secondResult).toEqual({
      ok: false,
      error: { code: 'switch_in_progress', message: 'a server switch is already in progress' },
    });
    expect(firstResult).toEqual({ ok: true });
  });

  // NOTE: no test for the "no_active_view" outcome exists in this file,
  // deliberately. `createBrowserController` unconditionally assigns
  // `const aemView = buildAemView(...)` and passes `getView: () => aemView`
  // to `ServerSwitchController` - `aemView` is a plain, non-optional
  // `AemBrowserView` (the `createAemView` seam's return type has no
  // `| undefined`), so that closure can never return `undefined` through
  // this module's public API, no matter what `switchServer`/`navigate` are
  // called with. The "no_active_view" branch is real - `switchServer` maps
  // it to `{ code: "no_active_view", ... }` - but it is only reachable at
  // the `ServerSwitchController` level, where it already has a direct test
  // (`serverSwitch.test.ts`, `"reports no_active_view without touching the
  // session when there is no view yet"`). Forcing it open here would require
  // either loosening `createAemView`'s return type to accept `undefined` (a
  // production-code change out of this task's scope) or an `as unknown as`
  // cast this project's rules ban - so this is reported as a finding rather
  // than faked with a placeholder assertion.

  it('surfaces a rejected loadURL as a structured network_error result, not a thrown error (Task 1)', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    harness.aemViewControls.loadURLImpl = () => {
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
    harness.aemViewControls.loadURLImpl = () => Promise.resolve();
    const secondResult = await harness.controller.switchServer(server.id);
    expect(secondResult.ok).toBe(true);
  });

  it('surfaces a rejected switchProxy as a structured network_error result (Task 1)', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    harness.aemSessionControls.switchProxyImpl = () => {
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
    expect(harness.aemViewControls.loadURL).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected programmer error (no Chromium ERR_* code) rather than misreporting it as a network_error', async () => {
    const server = makeServer();
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithOneServer(server));
    harness.aemViewControls.loadURLImpl = () => {
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
    expect(harness.aemSessionControls.approveCertificateException).toHaveBeenCalledWith(exception);
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
    expect(harness.aemViewControls.loadURL).toHaveBeenCalledWith(blockedUrl);
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
    expect(harness.aemViewControls.loadURL).not.toHaveBeenCalled();
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
    expect(harness.aemViewControls.loadURL).toHaveBeenCalledTimes(1);
    expect(harness.aemViewControls.loadURL).toHaveBeenCalledWith(`${server.origin}/`);
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
    { session: harness.aemSessionControls.aemSession.session },
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

    harness.aemViewControls.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });

    expect(harness.controller.navigationEpoch.current()).toBeGreaterThan(before);
  });

  it('does not invalidate on same-document navigation, which AEM authoring performs constantly', () => {
    const harness = makeControllerHarness();
    const before = harness.controller.navigationEpoch.current();

    harness.aemViewControls.webContents.emit('did-start-navigation', {
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
    harness.aemViewControls.loadURLImpl = () =>
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

    harness.aemViewControls.webContents.emit('did-start-navigation', {
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
    harness.aemViewControls.webContents.emit('did-start-navigation', {
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
      expect(harness.aemSessionControls.applyProxy).toHaveBeenCalledWith(
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
      expect(harness.aemSessionControls.applyProxy).toHaveBeenCalledWith(
        corporate,
        expect.any(Function),
      );
    });

    driveMainFrameNavigation(harness, 'https://b.example/editor.html');
    await vi.waitFor(() => {
      expect(harness.aemSessionControls.applyProxy).toHaveBeenCalledWith(
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
      expect(harness.aemSessionControls.applyProxy).toHaveBeenCalledTimes(1);
    });

    driveMainFrameNavigation(harness, 'https://other-ims.example/two');

    await Promise.resolve();
    await Promise.resolve();
    expect(harness.aemSessionControls.applyProxy).toHaveBeenCalledTimes(1);
  });

  it('follows a cross-origin redirect through will-redirect', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithProxies);

    harness.aemViewControls.webContents.emit('will-redirect', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://ims.example/after-redirect',
    });

    await vi.waitFor(() => {
      expect(harness.aemSessionControls.applyProxy).toHaveBeenCalledWith(
        fallback,
        expect.any(Function),
      );
    });
  });

  it('sets the applied proxy on a successful switch, so a navigation to the same host is a no-op', async () => {
    const harness = makeControllerHarness();
    await writeSettings(harness.settingsDir, settingsWithProxies);

    await harness.controller.switchServer(serverA.id);
    expect(harness.aemSessionControls.switchProxy).toHaveBeenCalledWith(
      corporate,
      expect.any(Function),
    );

    driveMainFrameNavigation(harness, 'https://a.example/other');

    await Promise.resolve();
    await Promise.resolve();
    expect(harness.aemSessionControls.applyProxy).not.toHaveBeenCalled();
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
    harness.aemViewControls.loadURLImpl = () =>
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

    harness.aemViewControls.webContents.emit('did-start-navigation', {
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

    harness.aemViewControls.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://ims.example/oauth',
    });

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
