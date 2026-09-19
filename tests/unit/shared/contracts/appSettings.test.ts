import { describe, expect, it } from 'vitest';
import {
  APP_SETTINGS_SCHEMA_VERSION,
  appSettingsSchema,
  defaultAppSettings,
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
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    hosts: [serverA],
    activeHostId: serverA.id,
    proxies: [],
    defaultModel: null,
    defaultReasoningEffort: null,
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
      defaultModel: 'some-brand-new-model-2099',
      defaultReasoningEffort: 'ultra-deep-think',
    };
    expect(appSettingsSchema.parse(input)).toEqual(input);
  });

  describe('schema version', () => {
    it('rejects a document missing schemaVersion', () => {
      const withoutSchemaVersion: Record<string, unknown> = { ...validSettings() };
      delete withoutSchemaVersion.schemaVersion;
      expect(() => appSettingsSchema.parse(withoutSchemaVersion)).toThrow();
    });

    it('rejects an older schema version', () => {
      expect(() => appSettingsSchema.parse({ ...validSettings(), schemaVersion: 0 })).toThrow();
    });

    it('rejects a newer, unknown schema version', () => {
      expect(() =>
        appSettingsSchema.parse({
          ...validSettings(),
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION + 1,
        }),
      ).toThrow();
    });
  });

  describe('server list integrity', () => {
    it('rejects duplicate server ids', () => {
      const serverA = server('server-a', 'https://a.example');
      const duplicate = serverConfigSchema.parse({ ...serverA, origin: 'https://b.example' });
      expect(() =>
        appSettingsSchema.parse({
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
          hosts: [serverA, duplicate],
          activeHostId: serverA.id,
          proxies: [],
          defaultModel: null,
          defaultReasoningEffort: null,
        }),
      ).toThrow();
    });

    it('rejects duplicate server origins', () => {
      const serverA = server('server-a', 'https://a.example');
      const serverB = server('server-b', 'https://a.example');
      expect(() =>
        appSettingsSchema.parse({
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
          hosts: [serverA, serverB],
          activeHostId: serverA.id,
          proxies: [],
          defaultModel: null,
          defaultReasoningEffort: null,
        }),
      ).toThrow();
    });

    it('rejects a dangling activeHostId', () => {
      const serverA = server('server-a', 'https://a.example');
      const danglingId = newServerId(() => 'server-ghost');
      expect(() =>
        appSettingsSchema.parse({
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
          hosts: [serverA],
          activeHostId: danglingId,
          proxies: [],
          defaultModel: null,
          defaultReasoningEffort: null,
        }),
      ).toThrow();
    });

    it('accepts a null activeHostId with no servers configured', () => {
      const input = {
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
        hosts: [],
        activeHostId: null,
        proxies: [],
        defaultModel: null,
        defaultReasoningEffort: null,
      };
      expect(appSettingsSchema.parse(input)).toEqual(input);
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
    expect(settings.schemaVersion).toBe(APP_SETTINGS_SCHEMA_VERSION);
    expect(settings.hosts).toEqual([]);
    expect(settings.proxies).toEqual([]);
    expect(settings.activeHostId).toBeNull();
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
    const result = parseAppSettings({ ...validSettings(), schemaVersion: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error[0]?.path).toBe('schemaVersion');
    }
  });

  it('returns an error rather than throwing for non-object input', () => {
    const result = parseAppSettings('not a settings document');
    expect(result.ok).toBe(false);
  });
});
