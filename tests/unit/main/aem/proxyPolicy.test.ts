import { describe, expect, it } from 'vitest';
import {
  applyProxySwitch,
  applySessionProxy,
  buildProxyConfig,
  buildProxyRules,
  extractProxyTarget,
  type ProxySwitchSession,
} from '../../../../src/main/aem';
import { newProxyId, proxyConfigSchema, type ProxyConfig } from '../../../../src/shared';

function proxy(url: string): ProxyConfig {
  return proxyConfigSchema.parse({ id: newProxyId(() => 'proxy-1'), label: 'Proxy', url });
}

describe('buildProxyRules', () => {
  it("uses the proxy's origin with no scheme-specific prefix", () => {
    expect(buildProxyRules(proxy('http://proxy.example.test:8080'))).toBe(
      'http://proxy.example.test:8080',
    );
  });
});

describe('buildProxyConfig', () => {
  it('returns explicit direct mode when no proxy is configured', () => {
    expect(buildProxyConfig(undefined)).toEqual({ mode: 'direct' });
  });

  it('returns fixed_servers with no bypass rules by default', () => {
    const config = buildProxyConfig(proxy('http://proxy.example.test:8080'));

    expect(config).toEqual({ mode: 'fixed_servers', proxyRules: 'http://proxy.example.test:8080' });
  });

  it('does not include proxyBypassRules at all when bypassLoopbackForTesting is not set (exactOptionalPropertyTypes safety)', () => {
    const config = buildProxyConfig(proxy('http://proxy.example.test:8080'));

    expect(Object.prototype.hasOwnProperty.call(config, 'proxyBypassRules')).toBe(false);
  });

  it('includes the loopback bypass rule only when explicitly opted in', () => {
    const config = buildProxyConfig(proxy('http://proxy.example.test:8080'), {
      bypassLoopbackForTesting: true,
    });

    expect(config).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.example.test:8080',
      proxyBypassRules: '<-loopback>',
    });
  });

  it('does not apply the loopback bypass in direct mode even if requested', () => {
    const config = buildProxyConfig(undefined, { bypassLoopbackForTesting: true });

    expect(config).toEqual({ mode: 'direct' });
  });
});

describe('extractProxyTarget', () => {
  it('extracts an explicit port', () => {
    expect(extractProxyTarget(proxy('http://proxy.example.test:8080'))).toEqual({
      host: 'proxy.example.test',
      port: 8080,
    });
  });

  it('defaults to port 80 for http with no explicit port', () => {
    expect(extractProxyTarget(proxy('http://proxy.example.test'))).toEqual({
      host: 'proxy.example.test',
      port: 80,
    });
  });

  it('defaults to port 443 for https with no explicit port', () => {
    expect(extractProxyTarget(proxy('https://proxy.example.test'))).toEqual({
      host: 'proxy.example.test',
      port: 443,
    });
  });
});

describe('applyProxySwitch', () => {
  function createSessionSpy(): ProxySwitchSession & {
    calls: string[];
    setProxyArgs: unknown[];
  } {
    const calls: string[] = [];
    const setProxyArgs: unknown[] = [];
    return {
      calls,
      setProxyArgs,
      setProxy(config) {
        setProxyArgs.push(config);
        calls.push('setProxy');
        return Promise.resolve();
      },
      closeAllConnections() {
        calls.push('closeAllConnections');
        return Promise.resolve();
      },
    };
  }

  it('awaits setProxy before closeAllConnections, in that order', async () => {
    const session = createSessionSpy();

    await applyProxySwitch(session, proxy('http://proxy.example.test:8080'));

    expect(session.calls).toEqual(['setProxy', 'closeAllConnections']);
  });

  it('passes the built proxy config through to setProxy', async () => {
    const session = createSessionSpy();

    await applyProxySwitch(session, proxy('http://proxy.example.test:8080'), {
      bypassLoopbackForTesting: true,
    });

    expect(session.setProxyArgs).toEqual([
      {
        mode: 'fixed_servers',
        proxyRules: 'http://proxy.example.test:8080',
        proxyBypassRules: '<-loopback>',
      },
    ]);
  });

  it('switches to direct mode when proxy is undefined', async () => {
    const session = createSessionSpy();

    await applyProxySwitch(session, undefined);

    expect(session.setProxyArgs).toEqual([{ mode: 'direct' }]);
    expect(session.calls).toEqual(['setProxy', 'closeAllConnections']);
  });

  it('does not resolve until both setProxy and closeAllConnections have resolved', async () => {
    let setProxyResolved = false;
    let closeResolved = false;
    const session: ProxySwitchSession = {
      setProxy: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            setProxyResolved = true;
            resolve();
          }, 5),
        ),
      closeAllConnections: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            closeResolved = true;
            resolve();
          }, 5),
        ),
    };

    await applyProxySwitch(session, proxy('http://proxy.example.test:8080'));

    expect(setProxyResolved).toBe(true);
    expect(closeResolved).toBe(true);
  });
});

describe('applySessionProxy', () => {
  function createSessionSpy(): Pick<ProxySwitchSession, 'setProxy'> & {
    calls: string[];
    setProxyArgs: unknown[];
  } {
    const calls: string[] = [];
    const setProxyArgs: unknown[] = [];
    return {
      calls,
      setProxyArgs,
      setProxy(config) {
        setProxyArgs.push(config);
        calls.push('setProxy');
        return Promise.resolve();
      },
    };
  }

  it('applies the proxy without closing connections, so an in-flight navigation is not aborted', async () => {
    const session = createSessionSpy();

    await applySessionProxy(session, proxy('http://proxy.example.test:8080'));

    expect(session.calls).toEqual(['setProxy']);
    expect(session.setProxyArgs).toEqual([
      { mode: 'fixed_servers', proxyRules: 'http://proxy.example.test:8080' },
    ]);
  });

  it('switches to direct mode when the resolved proxy is undefined', async () => {
    const session = createSessionSpy();

    await applySessionProxy(session, undefined);

    expect(session.setProxyArgs).toEqual([{ mode: 'direct' }]);
  });
});
