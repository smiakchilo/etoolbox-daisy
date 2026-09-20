import { describe, expect, it } from 'vitest';
import {
  appSettingsSchema,
  defaultAppSettings,
  DEFAULT_AGENT_ID,
  newProxyId,
  newServerId,
  parseAppSettings,
  proxyConfigSchema,
  serverConfigSchema,
} from '../../../../src/shared';

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

function validSettings() {
  const serverA = server('server-a', 'https://a.example');
  return {
    hosts: [serverA],
    proxies: [],
    agents: { [DEFAULT_AGENT_ID]: { active: true } },
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
        [DEFAULT_AGENT_ID]: {
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
      agents: { [DEFAULT_AGENT_ID]: { model: 'gpt-5' } },
    };

    const parsed = appSettingsSchema.parse(input);

    expect(parsed.agents[DEFAULT_AGENT_ID]?.active).toBe(false);
    expect(parsed.agents[DEFAULT_AGENT_ID]?.model).toBe('gpt-5');
  });

  describe('server list integrity', () => {
    it('rejects duplicate server ids', () => {
      const serverA = server('server-a', 'https://a.example');
      const duplicate = serverConfigSchema.parse({ ...serverA, origin: 'https://b.example' });
      expect(() =>
        appSettingsSchema.parse({
          hosts: [serverA, duplicate],
          proxies: [],
          agents: { [DEFAULT_AGENT_ID]: { active: true } },
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
          agents: { [DEFAULT_AGENT_ID]: { active: true } },
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
