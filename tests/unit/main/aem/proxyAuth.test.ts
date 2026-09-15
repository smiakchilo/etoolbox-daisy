import { describe, expect, it } from 'vitest';
import {
  createProxyLoginListener,
  decideProxyAuth,
  type ProxyLoginChallenge,
} from '../../../../src/main/aem/proxyAuth';
import {
  aemProxyConfigSchema,
  type AemProxyConfig,
} from '../../../../src/shared/contracts/serverConfig';

function proxy(url: string): AemProxyConfig {
  return aemProxyConfigSchema.parse({ url });
}

function challenge(overrides: Partial<ProxyLoginChallenge> = {}): ProxyLoginChallenge {
  return { isProxy: true, host: 'proxy.example.test', port: 8080, ...overrides };
}

describe('decideProxyAuth', () => {
  const selectedProxy = proxy('http://proxy.example.test:8080');

  it('supplies credentials when isProxy is true and host/port match the selected proxy', () => {
    expect(decideProxyAuth(challenge(), selectedProxy)).toEqual({ supply: true });
  });

  it('matches host case-insensitively', () => {
    expect(decideProxyAuth(challenge({ host: 'PROXY.EXAMPLE.TEST' }), selectedProxy)).toEqual({
      supply: true,
    });
  });

  it('refuses when isProxy is false, even if host/port match exactly (an AEM/IdP 401, never given proxy credentials)', () => {
    const decision = decideProxyAuth(challenge({ isProxy: false }), selectedProxy);

    expect(decision).toEqual({ supply: false, reason: 'not_a_proxy_challenge' });
  });

  it('refuses when no proxy is configured at all', () => {
    const decision = decideProxyAuth(challenge(), undefined);

    expect(decision).toEqual({ supply: false, reason: 'no_proxy_configured' });
  });

  it('refuses when the host differs from the selected proxy', () => {
    const decision = decideProxyAuth(
      challenge({ host: 'not-the-proxy.example.test' }),
      selectedProxy,
    );

    expect(decision).toEqual({ supply: false, reason: 'host_or_port_mismatch' });
  });

  it('refuses when the port differs from the selected proxy, even though the host matches exactly', () => {
    const decision = decideProxyAuth(challenge({ port: 9090 }), selectedProxy);

    expect(decision).toEqual({ supply: false, reason: 'host_or_port_mismatch' });
  });

  it('refuses an AEM challenge that happens to share a host with the proxy but differs by port (the explicit hardening case)', () => {
    // AEM and the proxy both on proxy.example.test, but AEM listens on 4502
    // while the proxy listens on 8080 - isProxy is claimed true here to
    // isolate the host/port check, but the point requirements-decisions.md
    // section 4 makes is that this must fail even if some other layer
    // reported isProxy incorrectly.
    const aemOnProxyHost = challenge({ isProxy: true, host: 'proxy.example.test', port: 4502 });

    expect(decideProxyAuth(aemOnProxyHost, selectedProxy)).toEqual({
      supply: false,
      reason: 'host_or_port_mismatch',
    });
  });

  it('refuses a same-host-different-port challenge even when isProxy is false (the realistic AEM-on-proxy-host case)', () => {
    const aemOnProxyHost = challenge({ isProxy: false, host: 'proxy.example.test', port: 4502 });

    expect(decideProxyAuth(aemOnProxyHost, selectedProxy)).toEqual({
      supply: false,
      reason: 'not_a_proxy_challenge',
    });
  });
});

describe('createProxyLoginListener', () => {
  const selectedProxy = proxy('http://proxy.example.test:8080');

  function callbackCapture(): {
    calls: Array<[string | undefined, string | undefined]>;
    callback: (username?: string, password?: string) => void;
  } {
    const calls: Array<[string | undefined, string | undefined]> = [];
    return { calls, callback: (username, password) => calls.push([username, password]) };
  }

  it('supplies credentials and calls preventDefault for a genuine proxy challenge', () => {
    const listener = createProxyLoginListener({
      selectedProxy,
      resolveCredentials: () => ({ username: 'alice', password: 's3cret' }),
    });
    const { calls, callback } = callbackCapture();
    let prevented = false;

    listener({ preventDefault: () => (prevented = true) }, null, undefined, challenge(), callback);

    expect(prevented).toBe(true);
    expect(calls).toEqual([['alice', 's3cret']]);
  });

  it('leaves the default cancellation in place for a non-proxy (AEM/IdP) challenge, without consuming the one-time callback', () => {
    let credentialsResolved = false;
    const listener = createProxyLoginListener({
      selectedProxy,
      resolveCredentials: () => {
        credentialsResolved = true;
        return { username: 'alice', password: 's3cret' };
      },
    });
    const { calls, callback } = callbackCapture();
    let prevented = false;

    listener(
      { preventDefault: () => (prevented = true) },
      null,
      undefined,
      challenge({ isProxy: false, host: 'localhost', port: 4502 }),
      callback,
    );

    expect(prevented).toBe(false);
    expect(calls).toEqual([]);
    expect(credentialsResolved).toBe(false);
  });

  it('leaves the default cancellation in place when no credentials are available for an otherwise-matching proxy challenge', () => {
    const listener = createProxyLoginListener({
      selectedProxy,
      resolveCredentials: () => undefined,
    });
    const { calls, callback } = callbackCapture();
    let prevented = false;

    listener({ preventDefault: () => (prevented = true) }, null, undefined, challenge(), callback);

    expect(prevented).toBe(false);
    expect(calls).toEqual([]);
  });

  it('resolves credentials fresh on each challenge rather than caching the first result', () => {
    let call = 0;
    const listener = createProxyLoginListener({
      selectedProxy,
      resolveCredentials: () => {
        call += 1;
        return { username: 'alice', password: `secret-${String(call)}` };
      },
    });
    const { calls, callback } = callbackCapture();

    listener({ preventDefault: () => undefined }, null, undefined, challenge(), callback);
    listener({ preventDefault: () => undefined }, null, undefined, challenge(), callback);

    expect(calls).toEqual([
      ['alice', 'secret-1'],
      ['alice', 'secret-2'],
    ]);
  });
});
