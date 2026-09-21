import { describe, expect, it, vi } from 'vitest';
import {
  buildRuntimeProxyOverrides,
  resolveAgentGithubToken,
  resolveAgentProxyOverrides,
} from '../../../src/main/agentRuntimeProxy';
import {
  DEFAULT_AGENT_ID,
  type AgentId,
  type AppSettings,
  type ProxyConfig,
  type ProxyId,
} from '../../../src/shared';

/**
 * The runtime's proxy is applied as `HTTPS_PROXY`/`HTTP_PROXY` on the child
 * process, so the value built here is the only thing that decides whether the
 * Copilot runtime tunnels its traffic - and whether its credentials survive
 * `URL`'s userinfo encoding. Both are pure decisions, tested against plain
 * data; the live proof that the child process actually honours the variables
 * (and a real proxy) is `tests/integration/proxy-runtime.test.ts`.
 */

const SECRET_REF = 'proxy-1/secret';

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
    proxies: [proxyWith()],
    agents: {
      [DEFAULT_AGENT_ID]:
        proxyId === undefined ? { active: true } : { active: true, proxy: proxyId },
    },
    browser: { disableNativeWebAuthn: true },
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

describe('resolveAgentProxyOverrides', () => {
  it('resolves to no proxy when there is no settings document', async () => {
    const get = vi.fn();
    await expect(resolveAgentProxyOverrides(undefined, { get })).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('resolves to no proxy when the active agent has none selected', async () => {
    const get = vi.fn();
    await expect(
      resolveAgentProxyOverrides(settingsWith(undefined), { get }),
    ).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('does not read secure storage for a proxy without credentials', async () => {
    const get = vi.fn();
    await expect(
      resolveAgentProxyOverrides(settingsWith('proxy-1' as ProxyId), { get }),
    ).resolves.toEqual({
      httpsProxy: 'http://proxy.example:8080',
      httpProxy: 'http://proxy.example:8080',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('reads the entry password from secure storage by secret reference', async () => {
    const get = vi.fn().mockResolvedValue('hunter2');
    const settings = {
      ...settingsWith('proxy-1' as ProxyId),
      proxies: [proxyWith({ credentials: { username: 'svc', secretRef: SECRET_REF } })],
    } as AppSettings;

    await expect(resolveAgentProxyOverrides(settings, { get })).resolves.toEqual({
      httpsProxy: 'http://svc:hunter2@proxy.example:8080',
      httpProxy: 'http://svc:hunter2@proxy.example:8080',
    });
    expect(get).toHaveBeenCalledWith(SECRET_REF);
  });

  it('follows the active agent, not merely the first stored node', async () => {
    const get = vi.fn();
    const settings = {
      ...settingsWith(undefined),
      proxies: [proxyWith({ id: 'proxy-2' as ProxyId, url: 'http://other.example:3128' })],
      agents: {
        [DEFAULT_AGENT_ID]: { active: false },
        ['opencode' as AgentId]: { active: true, proxy: 'proxy-2' as ProxyId },
      },
    } as AppSettings;

    await expect(resolveAgentProxyOverrides(settings, { get })).resolves.toEqual({
      httpsProxy: 'http://other.example:3128',
      httpProxy: 'http://other.example:3128',
    });
  });

  it('treats a dangling proxy reference as a direct connection', async () => {
    // The schema rejects a dangling id, but a settings file is hand-editable -
    // refusing to start the runtime over it would be worse than ignoring it.
    const get = vi.fn();
    await expect(
      resolveAgentProxyOverrides(settingsWith('missing' as ProxyId), { get }),
    ).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('resolveAgentGithubToken', () => {
  const AGENT_TOKEN_REF = 'agent-token:copilot';

  it('resolves to no token when there is no settings document', async () => {
    const get = vi.fn();
    await expect(resolveAgentGithubToken(undefined, { get })).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('resolves to no token when the active agent has none stored', async () => {
    const get = vi.fn();
    await expect(
      resolveAgentGithubToken(settingsWith(undefined), { get }),
    ).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('reads the token plaintext from secure storage by secret reference', async () => {
    const get = vi.fn().mockResolvedValue('ghp_stored');
    const settings = {
      ...settingsWith(undefined),
      agents: {
        [DEFAULT_AGENT_ID]: { active: true, token: { secretRef: AGENT_TOKEN_REF } },
      },
    } as AppSettings;

    await expect(resolveAgentGithubToken(settings, { get })).resolves.toBe('ghp_stored');
    expect(get).toHaveBeenCalledWith(AGENT_TOKEN_REF);
  });

  it('follows the active agent, not merely the first stored node', async () => {
    const get = vi.fn().mockResolvedValue('ghp_other');
    const settings = {
      ...settingsWith(undefined),
      agents: {
        [DEFAULT_AGENT_ID]: { active: false, token: { secretRef: 'agent-token:copilot' } },
        ['opencode' as AgentId]: { active: true, token: { secretRef: 'agent-token:opencode' } },
      },
    } as AppSettings;

    await expect(resolveAgentGithubToken(settings, { get })).resolves.toBe('ghp_other');
    expect(get).toHaveBeenCalledWith('agent-token:opencode');
  });

  it('propagates a secret-store failure rather than starting without the token', async () => {
    // A rejection aborts the runtime install before the working runtime is
    // touched (see `copilotRuntimeManager.ts`), so it must not be swallowed
    // into `undefined` here.
    const get = vi.fn().mockRejectedValue(new Error('secure storage unavailable'));
    const settings = {
      ...settingsWith(undefined),
      agents: {
        [DEFAULT_AGENT_ID]: { active: true, token: { secretRef: AGENT_TOKEN_REF } },
      },
    } as AppSettings;

    await expect(resolveAgentGithubToken(settings, { get })).rejects.toThrow(
      'secure storage unavailable',
    );
  });
});
