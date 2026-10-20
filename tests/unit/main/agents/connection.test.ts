import { describe, expect, it, vi } from 'vitest';
import {
  buildRuntimeProxyOverrides,
  resolveConnection,
} from '../../../../src/main/agents/connection';
import {
  type AgentId,
  type AppSettings,
  type ProxyConfig,
  type ProxyId,
} from '../../../../src/shared';

/**
 * The runtime's proxy is applied as `HTTPS_PROXY`/`HTTP_PROXY` on the child
 * process, so the value built here is the only thing that decides whether the
 * Copilot runtime tunnels its traffic - and whether its credentials survive
 * `URL`'s userinfo encoding. Both are pure decisions, tested against plain
 * data; the live proof that the child process actually honours the variables
 * (and a real proxy) is `tests/integration/proxy-runtime.test.ts`.
 */

const SECRET_REF = 'proxy-1/secret';
const AGENT = 'test-agent' as AgentId;
const OTHER = 'other-agent' as AgentId;

function proxyWith(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    id: 'proxy-1' as ProxyId,
    label: 'Corp proxy',
    url: 'http://proxy.example:8080',
    ...overrides,
  };
}

function settingsWith(proxyId: ProxyId | undefined): AppSettings {
  return {
    hosts: [],
    projects: [],
    proxies: [proxyWith()],
    agents: {
      [AGENT]: proxyId === undefined ? { active: true } : { active: true, proxy: proxyId },
    },
    browser: { disableNativeWebAuthn: true },
    memos: { enabled: true },
    updates: { checkOnStartup: false },
  };
}

describe('buildRuntimeProxyOverrides', () => {
  it('applies the proxy to both schemes, with no userinfo when none is stored', () => {
    expect(buildRuntimeProxyOverrides(proxyWith(), undefined)).toEqual({
      httpsProxy: 'http://proxy.example:8080',
      httpProxy: 'http://proxy.example:8080',
    });
  });

  it('embeds the resolved password in the URL', () => {
    const overrides = buildRuntimeProxyOverrides(
      proxyWith({ credentials: { username: 'svc', secretRef: SECRET_REF } }),
      'hunter2',
    );
    expect(overrides.httpsProxy).toBe('http://svc:hunter2@proxy.example:8080');
    expect(overrides.httpProxy).toBe('http://svc:hunter2@proxy.example:8080');
  });

  it('omits credentials when the password could not be resolved', () => {
    // A credentials block whose secret is missing from secure storage must not
    // produce a half-formed `user:@host` URL.
    const overrides = buildRuntimeProxyOverrides(
      proxyWith({ credentials: { username: 'svc', secretRef: SECRET_REF } }),
      undefined,
    );
    expect(overrides.httpsProxy).toBe('http://proxy.example:8080');
  });

  it('percent-encodes exactly the characters userinfo requires', () => {
    const overrides = buildRuntimeProxyOverrides(
      proxyWith({ credentials: { username: 'svc@corp', secretRef: SECRET_REF } }),
      'p@ss:word/with?chars',
    );
    expect(overrides.httpsProxy).toBe(
      'http://svc%40corp:p%40ss%3Aword%2Fwith%3Fchars@proxy.example:8080',
    );
  });

  it('does not double-encode a password that is already percent-escaped', () => {
    // Pre-encoding by hand would turn "p%40ss" into "p%2540ss", which the
    // proxy would then read as the literal text "p%40ss".
    const overrides = buildRuntimeProxyOverrides(
      proxyWith({ credentials: { username: 'svc', secretRef: SECRET_REF } }),
      'p%40ss',
    );
    expect(overrides.httpsProxy).toBe('http://svc:p%40ss@proxy.example:8080');
  });

  it('drops the empty trailing path `URL` appends', () => {
    expect(buildRuntimeProxyOverrides(proxyWith(), undefined).httpsProxy).not.toMatch(/\/$/);
  });

  it('keeps a proxy address that has a real path', () => {
    const overrides = buildRuntimeProxyOverrides(
      proxyWith({ url: 'http://proxy.example:8080/aem' }),
      undefined,
    );
    expect(overrides.httpsProxy).toBe('http://proxy.example:8080/aem');
  });
});

describe('resolveConnection', () => {
  const TOKEN_REF = 'agent-token:test-agent';

  it('resolves to nothing when there is no settings document', async () => {
    const get = vi.fn();
    await expect(resolveConnection(AGENT, undefined, { get })).resolves.toEqual({});
    expect(get).not.toHaveBeenCalled();
  });

  it('resolves to nothing when the agent has no stored node', async () => {
    const get = vi.fn();
    const settings = { ...settingsWith(undefined), agents: {} } as AppSettings;
    await expect(resolveConnection(AGENT, settings, { get })).resolves.toEqual({});
    expect(get).not.toHaveBeenCalled();
  });

  it('resolves to no proxy and no token when neither is selected', async () => {
    const get = vi.fn();
    await expect(resolveConnection(AGENT, settingsWith(undefined), { get })).resolves.toEqual({});
    expect(get).not.toHaveBeenCalled();
  });

  it('does not read secure storage for a proxy without credentials', async () => {
    const get = vi.fn();
    await expect(
      resolveConnection(AGENT, settingsWith('proxy-1' as ProxyId), { get }),
    ).resolves.toEqual({
      proxy: { httpsProxy: 'http://proxy.example:8080', httpProxy: 'http://proxy.example:8080' },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('reads the proxy password from secure storage by secret reference', async () => {
    const get = vi.fn().mockResolvedValue('hunter2');
    const settings = {
      ...settingsWith('proxy-1' as ProxyId),
      proxies: [proxyWith({ credentials: { username: 'svc', secretRef: SECRET_REF } })],
    } as AppSettings;

    const connection = await resolveConnection(AGENT, settings, { get });
    expect(connection.proxy?.httpsProxy).toBe(
      buildRuntimeProxyOverrides(settings.proxies[0] as ProxyConfig, 'hunter2').httpsProxy,
    );
    expect(get).toHaveBeenCalledWith(SECRET_REF);
  });

  it('reads the token plaintext from secure storage by secret reference', async () => {
    const get = vi.fn().mockResolvedValue('ghp_stored');
    const settings = {
      ...settingsWith(undefined),
      agents: { [AGENT]: { active: true, token: { secretRef: TOKEN_REF } } },
    } as AppSettings;

    await expect(resolveConnection(AGENT, settings, { get })).resolves.toEqual({
      accessToken: 'ghp_stored',
    });
    expect(get).toHaveBeenCalledWith(TOKEN_REF);
  });

  it('follows the requested agent, not merely the first stored node', async () => {
    const get = vi.fn().mockResolvedValue('ghp_other');
    const settings = {
      ...settingsWith(undefined),
      proxies: [proxyWith({ id: 'proxy-2' as ProxyId, url: 'http://other.example:3128' })],
      agents: {
        [AGENT]: { active: false, token: { secretRef: TOKEN_REF } },
        [OTHER]: {
          active: true,
          proxy: 'proxy-2' as ProxyId,
          token: { secretRef: 'agent-token:other-agent' },
        },
      },
    } as AppSettings;

    await expect(resolveConnection(OTHER, settings, { get })).resolves.toEqual({
      proxy: { httpsProxy: 'http://other.example:3128', httpProxy: 'http://other.example:3128' },
      accessToken: 'ghp_other',
    });
    expect(get).toHaveBeenCalledWith('agent-token:other-agent');
    expect(get).not.toHaveBeenCalledWith(TOKEN_REF);
  });

  it('treats a dangling proxy reference as a direct connection', async () => {
    // The schema rejects a dangling id, but a settings file is hand-editable -
    // refusing to start the runtime over it would be worse than ignoring it.
    const get = vi.fn();
    await expect(
      resolveConnection(AGENT, settingsWith('missing' as ProxyId), { get }),
    ).resolves.toEqual({});
    expect(get).not.toHaveBeenCalled();
  });

  it('propagates a secret-store failure rather than starting without the token', async () => {
    // A rejection aborts the runtime install before the working runtime is
    // touched, so it must not be swallowed into "no token" here.
    const get = vi.fn().mockRejectedValue(new Error('secure storage unavailable'));
    const settings = {
      ...settingsWith(undefined),
      agents: { [AGENT]: { active: true, token: { secretRef: TOKEN_REF } } },
    } as AppSettings;

    await expect(resolveConnection(AGENT, settings, { get })).rejects.toThrow(
      'secure storage unavailable',
    );
  });
});
