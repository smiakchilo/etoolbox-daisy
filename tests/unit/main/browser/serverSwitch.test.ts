import { describe, expect, it } from 'vitest';
import {
  ServerSwitchController,
  extractChromiumErrorCode,
  type SwitchableSession,
  type SwitchableView,
} from '../../../../src/main/browser/serverSwitch';
import { newProxyId } from '../../../../src/shared';
import { type ServerConfig } from '../../../../src/shared';
import { proxyConfigSchema } from '../../../../src/shared';
import { makeAuthorServer } from '../../../support/configFixtures';

/**
 * The requirement (requirements-decisions.md section 4) is an *order*, not
 * merely a set of calls - so this test asserts on a recorded call sequence
 * from fake collaborators, exactly as the task instructions call for,
 * rather than asserting each call happened in isolation.
 */
const makeServer = (overrides: Partial<Record<string, unknown>> = {}): ServerConfig =>
  makeAuthorServer('server-1', overrides);

function makeRecordingHarness() {
  const calls: string[] = [];

  const view: SwitchableView = {
    stop() {
      calls.push('view.stop');
    },
    async loadURL(url: string) {
      calls.push(`view.loadURL:${url}`);
      await Promise.resolve();
    },
  };

  const viewSession: SwitchableSession = {
    async switchProxy(proxy, resolveCredentials) {
      calls.push(`viewSession.switchProxy:${proxy ? proxy.url : 'none'}`);
      // Exercise the resolver the way real code would, without asserting on it directly.
      resolveCredentials();
      await Promise.resolve();
    },
  };

  const closePopups = () => {
    calls.push('closePopups');
  };

  return { calls, view, viewSession, closePopups };
}

describe('ServerSwitchController', () => {
  it('performs the switch in the exact required order: stop, close popups, switchProxy, then loadURL', async () => {
    const harness = makeRecordingHarness();
    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closePopups: harness.closePopups,
      viewSession: harness.viewSession,
      resolveProxyCredentials: () => () => undefined,
      resolveProxy: () => undefined,
    });

    const server = makeServer({ origin: 'https://second.example' });
    const outcome = await controller.switchTo(server);

    expect(outcome).toEqual({ ok: true });
    expect(harness.calls).toEqual([
      'view.stop',
      'closePopups',
      'viewSession.switchProxy:none',
      'view.loadURL:https://second.example',
    ]);
  });

  it('loads the given target URL instead of the origin root, so an address-bar deep link lands on the page the user asked for', async () => {
    const harness = makeRecordingHarness();
    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closePopups: harness.closePopups,
      viewSession: harness.viewSession,
      resolveProxyCredentials: () => () => undefined,
      resolveProxy: () => undefined,
    });

    const server = makeServer({ origin: 'https://second.example' });
    const outcome = await controller.switchTo(
      server,
      'https://second.example/editor.html/content/site.html',
    );

    expect(outcome).toEqual({ ok: true });
    expect(harness.calls).toEqual([
      'view.stop',
      'closePopups',
      'viewSession.switchProxy:none',
      'view.loadURL:https://second.example/editor.html/content/site.html',
    ]);
  });

  it('refuses a target URL whose origin is not the server being switched to, and does not stop the view or touch the proxy', async () => {
    const harness = makeRecordingHarness();
    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closePopups: harness.closePopups,
      viewSession: harness.viewSession,
      resolveProxyCredentials: () => () => undefined,
      resolveProxy: () => undefined,
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

  it('reports the proxy URL used for switchProxy when the target server resolves to one', async () => {
    const harness = makeRecordingHarness();
    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closePopups: harness.closePopups,
      viewSession: harness.viewSession,
      resolveProxyCredentials: () => () => undefined,
      resolveProxy: () =>
        proxyConfigSchema.parse({
          id: newProxyId(() => 'proxy-1'),
          label: 'Corporate',
          url: 'https://proxy.example',
        }),
    });

    const server = makeServer({ origin: 'https://proxied.example' });
    await controller.switchTo(server);

    expect(harness.calls).toEqual([
      'view.stop',
      'closePopups',
      'viewSession.switchProxy:https://proxy.example',
      'view.loadURL:https://proxied.example',
    ]);
  });

  it("exposes 'switching' as a checkable state during the transition and returns to 'idle' afterward", async () => {
    const harness = makeRecordingHarness();
    const states: string[] = [];
    let capturedMidSwitchState: string | undefined;

    const viewSession: SwitchableSession = {
      async switchProxy() {
        capturedMidSwitchState = controller.getState();
        await Promise.resolve();
      },
    };

    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closePopups: harness.closePopups,
      viewSession,
      resolveProxyCredentials: () => () => undefined,
      resolveProxy: () => undefined,
      onStateChange: (state) => states.push(state),
    });

    expect(controller.getState()).toBe('idle');
    await controller.switchTo(makeServer());

    expect(capturedMidSwitchState).toBe('switching');
    expect(controller.getState()).toBe('idle');
    expect(states).toEqual(['switching', 'idle']);
  });

  it('supersedes an in-flight switch instead of rejecting it: the newer target loads and the older one is abandoned', async () => {
    const harness = makeRecordingHarness();
    let releaseFirstSwitchProxy: (() => void) | undefined;
    let switchProxyCalls = 0;
    const viewSession: SwitchableSession = {
      switchProxy(_proxy, resolveCredentials) {
        switchProxyCalls += 1;
        resolveCredentials();
        if (switchProxyCalls === 1) {
          harness.calls.push('viewSession.switchProxy:first:start');
          return new Promise((resolve) => {
            releaseFirstSwitchProxy = () => {
              harness.calls.push('viewSession.switchProxy:first:end');
              resolve();
            };
          });
        }
        harness.calls.push(`viewSession.switchProxy:${String(switchProxyCalls)}`);
        return Promise.resolve();
      },
    };

    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closePopups: harness.closePopups,
      viewSession,
      resolveProxyCredentials: () => () => undefined,
      resolveProxy: () => undefined,
    });

    const firstSwitch = controller.switchTo(makeServer({ origin: 'https://first.example' }));
    // Let the first procedure reach its in-flight switchProxy await.
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState()).toBe('switching');

    // A second switch arrives while the first is still mid-switch. It must not
    // be rejected; it supersedes, and it is the one that loads.
    const secondSwitch = controller.switchTo(makeServer({ origin: 'https://second.example' }));
    // The second switch waits for the first to unwind, so release it.
    releaseFirstSwitchProxy?.();

    const [firstOutcome, secondOutcome] = await Promise.all([firstSwitch, secondSwitch]);
    expect(secondOutcome).toEqual({ ok: true });
    expect(firstOutcome).toEqual({ ok: false, reason: 'superseded' });

    // Only the newer target was ever loaded; the superseded switch bailed
    // before its own loadURL.
    expect(harness.calls.filter((call) => call.startsWith('view.loadURL'))).toEqual([
      'view.loadURL:https://second.example',
    ]);
    expect(controller.getState()).toBe('idle');
  });

  it('reports a superseded switch whose own load is stopped as superseded, not as a network error', async () => {
    const harness = makeRecordingHarness();
    let rejectFirstLoad: ((error: Error) => void) | undefined;
    const view: SwitchableView = {
      stop() {
        harness.calls.push('view.stop');
        // A superseding switch stops the pane, which aborts the in-flight
        // loadURL exactly as Electron would.
        rejectFirstLoad?.(new Error("ERR_ABORTED (-3) loading 'https://first.example'"));
      },
      loadURL(url: string) {
        harness.calls.push(`view.loadURL:${url}`);
        if (url === 'https://first.example') {
          return new Promise((_resolve, reject) => {
            rejectFirstLoad = reject;
          });
        }
        return Promise.resolve();
      },
    };

    const controller = new ServerSwitchController({
      getView: () => view,
      closePopups: harness.closePopups,
      viewSession: harness.viewSession,
      resolveProxyCredentials: () => () => undefined,
      resolveProxy: () => undefined,
    });

    const firstSwitch = controller.switchTo(makeServer({ origin: 'https://first.example' }));
    // Let the first procedure reach its in-flight loadURL.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondSwitch = controller.switchTo(makeServer({ origin: 'https://second.example' }));
    const [firstOutcome, secondOutcome] = await Promise.all([firstSwitch, secondSwitch]);

    // The stop() rejection is caused by the supersede, so the older call sees
    // `superseded` - not a `network_error` that would paint a spurious error.
    expect(firstOutcome).toEqual({ ok: false, reason: 'superseded' });
    expect(secondOutcome).toEqual({ ok: true });
  });

  it('reports no_active_view without touching the session when there is no view yet', async () => {
    const harness = makeRecordingHarness();
    const controller = new ServerSwitchController({
      getView: () => undefined,
      closePopups: harness.closePopups,
      viewSession: harness.viewSession,
      resolveProxyCredentials: () => () => undefined,
      resolveProxy: () => undefined,
    });

    const outcome = await controller.switchTo(makeServer());
    expect(outcome).toEqual({ ok: false, reason: 'no_active_view' });
    expect(harness.calls).toEqual([]);
  });

  it('returns to idle even when switchProxy rejects, so a failed switch does not leave tools permanently disabled', async () => {
    const harness = makeRecordingHarness();
    const viewSession: SwitchableSession = {
      switchProxy() {
        throw new Error('boom');
      },
    };

    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closePopups: harness.closePopups,
      viewSession,
      resolveProxyCredentials: () => () => undefined,
      resolveProxy: () => undefined,
    });

    await expect(controller.switchTo(makeServer())).rejects.toThrow('boom');
    expect(controller.getState()).toBe('idle');
  });

  it('reports a rejected loadURL (a down server / bad certificate / etc.) as a structured network_error outcome, not a thrown rejection', async () => {
    const harness = makeRecordingHarness();
    const rejectingView: SwitchableView = {
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
      closePopups: harness.closePopups,
      viewSession: harness.viewSession,
      resolveProxyCredentials: () => () => undefined,
      resolveProxy: () => undefined,
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
    const rejectingSession: SwitchableSession = {
      switchProxy() {
        throw new Error("ERR_PROXY_CONNECTION_FAILED (-130) setting proxy 'https://proxy.example'");
      },
    };

    const controller = new ServerSwitchController({
      getView: () => harness.view,
      closePopups: harness.closePopups,
      viewSession: rejectingSession,
      resolveProxyCredentials: () => () => undefined,
      resolveProxy: () => undefined,
    });

    const outcome = await controller.switchTo(makeServer());

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
