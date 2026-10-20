import { describe, expect, it } from 'vitest';
import {
  appSettingsSchema,
  defaultAppSettings,
  HOST_PROXY_NONE,
  newProjectId,
  newProxyId,
  newServerId,
  parseAppSettings,
  projectConfigSchema,
  proxyConfigSchema,
  serverConfigSchema,
} from '../../../../src/shared';
import { TEST_AGENT_ID } from '../../../support/agentDefinitions';

function server(id: string, origin: string) {
  return serverConfigSchema.parse({
    id: newServerId(() => id),
    label: `Server ${id}`,
    origin,
    color: { kind: 'swatch' as const, swatch: 'blue' as const },
    revision: 0,
  });
}

function proxy(id: string) {
  return proxyConfigSchema.parse({
    id: newProxyId(() => id),
    label: `Proxy ${id}`,
    url: 'https://proxy.example:8080',
  });
}

function project(id: string) {
  return projectConfigSchema.parse({
    id: newProjectId(() => id),
    label: `Project ${id}`,
  });
}

function validSettings() {
  const serverA = server('server-a', 'https://a.example');
  return {
    hosts: [serverA],
    projects: [],
    proxies: [],
    agents: { [TEST_AGENT_ID]: { active: true } },
    browser: { disableNativeWebAuthn: true },
    memos: { enabled: true },
    updates: { checkOnStartup: false },
  };
}

describe('appSettingsSchema', () => {
  it('accepts a well-formed document', () => {
    const input = validSettings();
    expect(appSettingsSchema.parse(input)).toEqual(input);
  });

  it('accepts a model/reasoning-effort string that is not on any hard-coded list', () => {
    const input = {
      ...validSettings(),
      agents: {
        [TEST_AGENT_ID]: {
          active: true,
          model: 'some-brand-new-model-2099',
          reasoningEffort: 'ultra-deep-think',
        },
      },
    };
    expect(appSettingsSchema.parse(input)).toEqual(input);
  });

  it('defaults a missing agent `active` to false instead of rejecting the document', () => {
    const input = {
      ...validSettings(),
      agents: { [TEST_AGENT_ID]: { model: 'gpt-5' } },
    };

    const parsed = appSettingsSchema.parse(input);

    expect(parsed.agents[TEST_AGENT_ID]?.active).toBe(false);
    expect(parsed.agents[TEST_AGENT_ID]?.model).toBe('gpt-5');
  });

  it('defaults a missing `browser` object to suppressing the native WebAuthn API', () => {
    const withoutBrowser: Record<string, unknown> = { ...validSettings() };
    delete withoutBrowser['browser'];
    const parsed = appSettingsSchema.parse(withoutBrowser);
    expect(parsed.browser).toEqual({ disableNativeWebAuthn: true });
  });

  it('defaults a missing `disableNativeWebAuthn` flag to true', () => {
    const parsed = appSettingsSchema.parse({ ...validSettings(), browser: {} });
    expect(parsed.browser.disableNativeWebAuthn).toBe(true);
  });

  it('defaults a missing `memos` object to self-learning switched on', () => {
    const withoutMemos: Record<string, unknown> = { ...validSettings() };
    delete withoutMemos['memos'];
    expect(appSettingsSchema.parse(withoutMemos).memos.enabled).toBe(true);
  });

  it('keeps self-learning switched off and rejects an unknown memos key', () => {
    expect(
      appSettingsSchema.parse({ ...validSettings(), memos: { enabled: false } }).memos.enabled,
    ).toBe(false);
    expect(() =>
      appSettingsSchema.parse({ ...validSettings(), memos: { enabled: true, extra: 1 } }),
    ).toThrow();
  });

  describe('server list integrity', () => {
    it('rejects duplicate server ids', () => {
      const serverA = server('server-a', 'https://a.example');
      const duplicate = serverConfigSchema.parse({ ...serverA, origin: 'https://b.example' });
      expect(() =>
        appSettingsSchema.parse({
          hosts: [serverA, duplicate],
          proxies: [],
          agents: { [TEST_AGENT_ID]: { active: true } },
        }),
      ).toThrow();
    });

    it('rejects duplicate server origins', () => {
      const serverA = server('server-a', 'https://a.example');
      const serverB = server('server-b', 'https://a.example');
      expect(() =>
        appSettingsSchema.parse({
          hosts: [serverA, serverB],
          proxies: [],
          agents: { [TEST_AGENT_ID]: { active: true } },
        }),
      ).toThrow();
    });

    it('accepts a host whose proxyId names a configured proxy', () => {
      const proxyEntry = proxy('proxy-1');
      const serverA = serverConfigSchema.parse({
        ...server('server-a', 'https://a.example'),
        proxyId: proxyEntry.id,
      });
      const input = {
        ...validSettings(),
        hosts: [serverA],
        proxies: [proxyEntry],
      };
      expect(appSettingsSchema.parse(input)).toEqual(input);
    });

    it('rejects a host whose proxyId does not name a configured proxy', () => {
      const serverA = serverConfigSchema.parse({
        ...server('server-a', 'https://a.example'),
        proxyId: newProxyId(() => 'proxy-ghost'),
      });
      expect(() =>
        appSettingsSchema.parse({
          ...validSettings(),
          hosts: [serverA],
          proxies: [],
        }),
      ).toThrow(/does not refer to a configured proxy/);
    });

    it('accepts the "No proxy" sentinel even with no proxy library configured', () => {
      const serverA = serverConfigSchema.parse({
        ...server('server-a', 'https://a.example'),
        proxyId: HOST_PROXY_NONE,
      });
      const input = { ...validSettings(), hosts: [serverA], proxies: [] };
      expect(appSettingsSchema.parse(input)).toEqual(input);
    });
  });

  describe('project references', () => {
    it('accepts a host whose projectId names a configured project', () => {
      const projectEntry = project('project-1');
      const serverA = serverConfigSchema.parse({
        ...server('server-a', 'https://a.example'),
        projectId: projectEntry.id,
      });
      const input = { ...validSettings(), hosts: [serverA], projects: [projectEntry] };
      expect(appSettingsSchema.parse(input)).toEqual(input);
    });

    it('rejects a host whose projectId does not name a configured project', () => {
      const serverA = serverConfigSchema.parse({
        ...server('server-a', 'https://a.example'),
        projectId: newProjectId(() => 'project-ghost'),
      });
      expect(() =>
        appSettingsSchema.parse({ ...validSettings(), hosts: [serverA], projects: [] }),
      ).toThrow(/does not refer to a configured project/);
    });

    it('rejects duplicate project ids', () => {
      const a = project('project-1');
      const b = project('project-1');
      expect(() => appSettingsSchema.parse({ ...validSettings(), projects: [a, b] })).toThrow(
        /duplicate project id/,
      );
    });
  });

  describe('browser default proxy', () => {
    it('accepts a browser default proxy that names a configured entry', () => {
      const proxyEntry = proxy('proxy-1');
      const input = {
        ...validSettings(),
        proxies: [proxyEntry],
        browser: { disableNativeWebAuthn: true, proxy: proxyEntry.id },
      };
      expect(appSettingsSchema.parse(input)).toEqual(input);
    });

    it('rejects a browser default proxy that does not name a configured entry', () => {
      expect(() =>
        appSettingsSchema.parse({
          ...validSettings(),
          proxies: [],
          browser: { disableNativeWebAuthn: true, proxy: newProxyId(() => 'proxy-ghost') },
        }),
      ).toThrow(/does not refer to a configured proxy/);
    });

    it('accepts a browser default proxy that is absent (direct)', () => {
      const parsed = appSettingsSchema.parse(validSettings());
      expect(parsed.browser.proxy).toBeUndefined();
    });
  });

  describe('strictness', () => {
    it('rejects an unknown top-level key', () => {
      expect(() => appSettingsSchema.parse({ ...validSettings(), extraneous: 'nope' })).toThrow();
    });

    it('rejects a proxy entry carrying a password field', () => {
      expect(() =>
        appSettingsSchema.parse({
          ...validSettings(),
          proxies: [
            {
              id: newProxyId(() => 'proxy-a'),
              label: 'Corporate',
              url: 'https://proxy.example:8080',
              credentials: {
                username: 'alice',
                secretRef: 'vault://proxy/alice',
                password: 'hunter2',
              },
            },
          ],
        }),
      ).toThrow();
    });

    it('rejects duplicate proxy ids', () => {
      const proxy = {
        id: newProxyId(() => 'proxy-a'),
        label: 'Corporate',
        url: 'https://proxy.example:8080',
      };
      expect(() =>
        appSettingsSchema.parse({ ...validSettings(), proxies: [proxy, proxy] }),
      ).toThrow();
    });

    it('accepts an agent token reference and rejects a plaintext token', () => {
      const accepted = {
        ...validSettings(),
        agents: {
          [TEST_AGENT_ID]: { active: true, token: { secretRef: 'agent-token:copilot' } },
        },
      };
      expect(appSettingsSchema.parse(accepted)).toEqual(accepted);

      expect(() =>
        appSettingsSchema.parse({
          ...validSettings(),
          agents: { [TEST_AGENT_ID]: { active: true, token: 'ghp_plaintext' } },
        }),
      ).toThrow();
    });

    it('rejects a token object carrying an extra key', () => {
      expect(() =>
        appSettingsSchema.parse({
          ...validSettings(),
          agents: {
            [TEST_AGENT_ID]: {
              active: true,
              token: { secretRef: 'agent-token:copilot', token: 'leak' },
            },
          },
        }),
      ).toThrow();
    });
  });
});

describe('defaultAppSettings', () => {
  it('produces a valid, empty document', () => {
    const settings = defaultAppSettings();
    expect(settings.hosts).toEqual([]);
    expect(settings.proxies).toEqual([]);
    expect(() => appSettingsSchema.parse(settings)).not.toThrow();
  });
});

describe('parseAppSettings', () => {
  it('returns ok for a well-formed document', () => {
    const result = parseAppSettings(validSettings());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hosts).toHaveLength(1);
    }
  });

  it('returns a structured error instead of throwing for a malformed document', () => {
    const result = parseAppSettings({ ...validSettings(), hosts: 'not an array' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error[0]?.path).toBe('hosts');
    }
  });

  it('returns an error rather than throwing for non-object input', () => {
    const result = parseAppSettings('not a settings document');
    expect(result.ok).toBe(false);
  });
});
