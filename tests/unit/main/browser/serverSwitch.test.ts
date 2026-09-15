import { describe, expect, it } from 'vitest';
import {
  ServerSwitchController,
  extractChromiumErrorCode,
  type AemSwitchSession,
  type SwitchableAemView,
} from '../../../../src/main/browser/serverSwitch';
import { newServerId } from '../../../../src/shared/contracts/ids';
import {
  serverConfigSchema,
  type ServerConfig,
} from '../../../../src/shared/contracts/serverConfig';

/**
 * The requirement (requirements-decisions.md section 4) is an *order*, not
 * merely a set of calls - so this test asserts on a recorded call sequence
 * from fake collaborators, exactly as the task instructions call for,
 * rather than asserting each call happened in isolation.
 */
function makeServer(overrides: Partial<Record<string, unknown>> = {}): ServerConfig {
  return serverConfigSchema.parse({
    id: newServerId(() => 'server-1'),
    label: 'Author',
    origin: 'https://author.example',
    color: { kind: 'swatch', swatch: 'blue' },
    revision: 0,
    ...overrides,
  });
}

function makeRecordingHarness() {
  const calls: string[] = [];

  const view: SwitchableAemView = {
    stop() {
      calls.push('view.stop');
    },
    async loadURL(url: string) {
      calls.push(`view.loadURL:${url}`);
      await Promise.resolve();
    },
  };

  const aemSession: AemSwitchSession = {
    async switchProxy(proxy, resolveCredentials) {
      calls.push(`aemSession.switchProxy:${proxy ? proxy.url : 'none'}`);
      // Exercise the resolver the way real code would, without asserting on it directly.
      resolveCredentials();
      await Promise.resolve();
    },
  };

  const closeAuxiliaryWindows = () => {
    calls.push('closeAuxiliaryWindows');
  };

  return { calls, view, aemSession, closeAuxiliaryWindows };
}

describe('ServerSwitchController', () => {
  it('performs the switch in the exact required order: stop, close aux windows, switchProxy, then loadURL', async () => {
    const harness = makeRecordingHarness();
    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closeAuxiliaryWindows: harness.closeAuxiliaryWindows,
      aemSession: harness.aemSession,
      resolveProxyCredentials: () => () => undefined,
    });

    const server = makeServer({ origin: 'https://second.example' });
    const outcome = await controller.switchTo(server);

    expect(outcome).toEqual({ ok: true });
    expect(harness.calls).toEqual([
      'view.stop',
      'closeAuxiliaryWindows',
      'aemSession.switchProxy:none',
      'view.loadURL:https://second.example',
    ]);
  });

  it('loads the given target URL instead of the origin root, so an address-bar deep link lands on the page the user asked for', async () => {
    const harness = makeRecordingHarness();
    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closeAuxiliaryWindows: harness.closeAuxiliaryWindows,
      aemSession: harness.aemSession,
      resolveProxyCredentials: () => () => undefined,
    });

    const server = makeServer({ origin: 'https://second.example' });
    const outcome = await controller.switchTo(
      server,
      'https://second.example/editor.html/content/site.html',
    );

    expect(outcome).toEqual({ ok: true });
    expect(harness.calls).toEqual([
      'view.stop',
      'closeAuxiliaryWindows',
      'aemSession.switchProxy:none',
      'view.loadURL:https://second.example/editor.html/content/site.html',
    ]);
  });

  it('refuses a target URL whose origin is not the server being switched to, and does not stop the view or touch the proxy', async () => {
    const harness = makeRecordingHarness();
    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closeAuxiliaryWindows: harness.closeAuxiliaryWindows,
      aemSession: harness.aemSession,
      resolveProxyCredentials: () => () => undefined,
    });

    const server = makeServer({ origin: 'https://second.example' });
    await expect(controller.switchTo(server, 'https://evil.example/x')).rejects.toThrow(
      'refusing to load',
    );
    // The refusal must happen before any side effect: a rejected target must
    // not leave the previous server's view stopped or its proxy replaced.
    expect(harness.calls).toEqual([]);
    expect(controller.getState()).toBe('idle');
  });

  it('reports the proxy URL used for switchProxy when the target server has one configured', async () => {
    const harness = makeRecordingHarness();
    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closeAuxiliaryWindows: harness.closeAuxiliaryWindows,
      aemSession: harness.aemSession,
      resolveProxyCredentials: () => () => undefined,
    });

    const server = makeServer({
      origin: 'https://proxied.example',
      proxy: { url: 'https://proxy.example' },
    });
    await controller.switchTo(server);

    expect(harness.calls).toEqual([
      'view.stop',
      'closeAuxiliaryWindows',
      'aemSession.switchProxy:https://proxy.example',
      'view.loadURL:https://proxied.example',
    ]);
  });

  it("exposes 'switching' as a checkable state during the transition and returns to 'idle' afterward", async () => {
    const harness = makeRecordingHarness();
    const states: string[] = [];
    let capturedMidSwitchState: string | undefined;

    const aemSession: AemSwitchSession = {
      async switchProxy() {
        capturedMidSwitchState = controller.getState();
        await Promise.resolve();
      },
    };

    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closeAuxiliaryWindows: harness.closeAuxiliaryWindows,
      aemSession,
      resolveProxyCredentials: () => () => undefined,
      onStateChange: (state) => states.push(state),
    });

    expect(controller.getState()).toBe('idle');
    await controller.switchTo(makeServer());

    expect(capturedMidSwitchState).toBe('switching');
    expect(controller.getState()).toBe('idle');
    expect(states).toEqual(['switching', 'idle']);
  });

  it('rejects a second switch while one is already in progress, rather than interleaving them', async () => {
    const harness = makeRecordingHarness();
    let resolveSwitchProxy: (() => void) | undefined;
    const aemSession: AemSwitchSession = {
      switchProxy() {
        harness.calls.push('aemSession.switchProxy:start');
        return new Promise((resolve) => {
          resolveSwitchProxy = () => {
            harness.calls.push('aemSession.switchProxy:end');
            resolve();
          };
        });
      },
    };

    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closeAuxiliaryWindows: harness.closeAuxiliaryWindows,
      aemSession,
      resolveProxyCredentials: () => () => undefined,
    });

    const firstSwitch = controller.switchTo(makeServer({ origin: 'https://first.example' }));
    // Give the microtask queue a chance to reach the in-flight `switchProxy` await.
    await Promise.resolve();
    await Promise.resolve();

    const secondOutcome = await controller.switchTo(
      makeServer({ origin: 'https://second.example' }),
    );
    expect(secondOutcome).toEqual({ ok: false, reason: 'already_switching' });

    resolveSwitchProxy?.();
    const firstOutcome = await firstSwitch;
    expect(firstOutcome).toEqual({ ok: true });

    // The second switch must never have touched stop/close/loadURL at all.
    expect(harness.calls).toEqual([
      'view.stop',
      'closeAuxiliaryWindows',
      'aemSession.switchProxy:start',
      'aemSession.switchProxy:end',
      'view.loadURL:https://first.example',
    ]);
  });

  it('reports no_active_view without touching the session when there is no view yet', async () => {
    const harness = makeRecordingHarness();
    const controller = new ServerSwitchController({
      getView: () => undefined,
      closeAuxiliaryWindows: harness.closeAuxiliaryWindows,
      aemSession: harness.aemSession,
      resolveProxyCredentials: () => () => undefined,
    });

    const outcome = await controller.switchTo(makeServer());
    expect(outcome).toEqual({ ok: false, reason: 'no_active_view' });
    expect(harness.calls).toEqual([]);
  });

  it('returns to idle even when switchProxy rejects, so a failed switch does not leave tools permanently disabled', async () => {
    const harness = makeRecordingHarness();
    const aemSession: AemSwitchSession = {
      switchProxy() {
        throw new Error('boom');
      },
    };

    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closeAuxiliaryWindows: harness.closeAuxiliaryWindows,
      aemSession,
      resolveProxyCredentials: () => () => undefined,
    });

    await expect(controller.switchTo(makeServer())).rejects.toThrow('boom');
    expect(controller.getState()).toBe('idle');
  });

  it('reports a rejected loadURL (a down server / bad certificate / etc.) as a structured network_error outcome, not a thrown rejection', async () => {
    const harness = makeRecordingHarness();
    const rejectingView: SwitchableAemView = {
      stop: () => {
        harness.calls.push('view.stop');
      },
      loadURL(url: string) {
        harness.calls.push(`view.loadURL:${url}`);
        // The exact shape Electron's real `webContents.loadURL` rejection
        // takes, observed in a real run (task instructions). Deliberately
        // not `async` - this always throws synchronously, so its inferred
        // `never` return type is assignable to the required
        // `Promise<void>` without a pointless `await`.
        throw new Error("ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://localhost:53158/nav'");
      },
    };

    const controller = new ServerSwitchController({
      getView: () => rejectingView,
      closeAuxiliaryWindows: harness.closeAuxiliaryWindows,
      aemSession: harness.aemSession,
      resolveProxyCredentials: () => () => undefined,
    });

    const outcome = await controller.switchTo(makeServer());

    expect(outcome).toEqual({
      ok: false,
      reason: 'network_error',
      errorCode: 'ERR_CERT_AUTHORITY_INVALID',
      message: "ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://localhost:53158/nav'",
    });
    // The switch does not leave tools disabled forever just because the
    // load itself failed - the same "always returns to idle" guarantee as
    // the pre-existing rejection case above.
    expect(controller.getState()).toBe('idle');
  });

  it('reports a rejected switchProxy (a bad proxy address, unreachable proxy, etc.) as a structured network_error outcome', async () => {
    const harness = makeRecordingHarness();
    const rejectingSession: AemSwitchSession = {
      switchProxy() {
        throw new Error("ERR_PROXY_CONNECTION_FAILED (-130) setting proxy 'https://proxy.example'");
      },
    };

    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closeAuxiliaryWindows: harness.closeAuxiliaryWindows,
      aemSession: rejectingSession,
      resolveProxyCredentials: () => () => undefined,
    });

    const outcome = await controller.switchTo(
      makeServer({ proxy: { url: 'https://proxy.example' } }),
    );

    expect(outcome).toEqual({
      ok: false,
      reason: 'network_error',
      errorCode: 'ERR_PROXY_CONNECTION_FAILED',
      message: "ERR_PROXY_CONNECTION_FAILED (-130) setting proxy 'https://proxy.example'",
    });
    expect(controller.getState()).toBe('idle');
    // The load must never have been attempted on top of a proxy that never
    // finished switching.
    expect(harness.calls.some((call) => call.startsWith('view.loadURL:'))).toBe(false);
  });
});

describe('extractChromiumErrorCode', () => {
  it('extracts the ERR_* code from a real loadURL rejection message', () => {
    const error = new Error(
      "ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://localhost:53158/nav'",
    );
    expect(extractChromiumErrorCode(error)).toBe('ERR_CERT_AUTHORITY_INVALID');
  });

  it('returns undefined for an Error whose message never mentions a Chromium error code - an unexpected programmer error, not a network failure', () => {
    expect(extractChromiumErrorCode(new Error('boom'))).toBeUndefined();
    expect(extractChromiumErrorCode(new TypeError('Cannot read properties of undefined'))).toBe(
      undefined,
    );
  });

  it('returns undefined for a non-Error throw', () => {
    expect(extractChromiumErrorCode('just a string')).toBeUndefined();
    expect(extractChromiumErrorCode(undefined)).toBeUndefined();
  });
});
