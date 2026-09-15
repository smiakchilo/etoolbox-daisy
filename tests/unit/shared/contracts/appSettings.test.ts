import { describe, expect, it } from 'vitest';
import { newServerId } from '../../../../src/shared/contracts/ids';
import { serverConfigSchema } from '../../../../src/shared/contracts/serverConfig';
import {
  APP_SETTINGS_SCHEMA_VERSION,
  appSettingsSchema,
  defaultAppSettings,
  parseAppSettings,
} from '../../../../src/shared/contracts/appSettings';

function server(id: string, origin: string) {
  return serverConfigSchema.parse({
    id: newServerId(() => id),
    label: `Server ${id}`,
    origin,
    color: { kind: 'swatch' as const, swatch: 'blue' as const },
    revision: 0,
  });
}

function validSettings() {
  const serverA = server('server-a', 'https://a.example');
  return {
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    servers: [serverA],
    activeServerId: serverA.id,
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
      expect(() => appSettingsSchema.parse({ ...validSettings(), schemaVersion: 2 })).toThrow();
    });
  });

  describe('server list integrity', () => {
    it('rejects duplicate server ids', () => {
      const serverA = server('server-a', 'https://a.example');
      const duplicate = serverConfigSchema.parse({ ...serverA, origin: 'https://b.example' });
      expect(() =>
        appSettingsSchema.parse({
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
          servers: [serverA, duplicate],
          activeServerId: serverA.id,
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
          servers: [serverA, serverB],
          activeServerId: serverA.id,
          defaultModel: null,
          defaultReasoningEffort: null,
        }),
      ).toThrow();
    });

    it('rejects a dangling activeServerId', () => {
      const serverA = server('server-a', 'https://a.example');
      const danglingId = newServerId(() => 'server-ghost');
      expect(() =>
        appSettingsSchema.parse({
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
          servers: [serverA],
          activeServerId: danglingId,
          defaultModel: null,
          defaultReasoningEffort: null,
        }),
      ).toThrow();
    });

    it('accepts a null activeServerId with no servers configured', () => {
      const input = {
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
        servers: [],
        activeServerId: null,
        defaultModel: null,
        defaultReasoningEffort: null,
      };
      expect(appSettingsSchema.parse(input)).toEqual(input);
    });
  });

  describe('strictness', () => {
    it('rejects an unknown top-level key', () => {
      expect(() => appSettingsSchema.parse({ ...validSettings(), extraneous: 'nope' })).toThrow();
    });

    it('rejects a Copilot proxy carrying a password field', () => {
      expect(() =>
        appSettingsSchema.parse({
          ...validSettings(),
          copilotProxy: {
            url: 'https://proxy.example:8080',
            credentials: {
              username: 'alice',
              secretRef: 'vault://copilot/alice',
              password: 'hunter2',
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
    expect(settings.schemaVersion).toBe(APP_SETTINGS_SCHEMA_VERSION);
    expect(settings.servers).toEqual([]);
    expect(settings.activeServerId).toBeNull();
    expect(() => appSettingsSchema.parse(settings)).not.toThrow();
  });
});

describe('parseAppSettings', () => {
  it('returns ok for a well-formed document', () => {
    const result = parseAppSettings(validSettings());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servers).toHaveLength(1);
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
