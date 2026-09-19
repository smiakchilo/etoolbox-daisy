import { describe, expect, it } from 'vitest';
import {
  APP_SETTINGS_SCHEMA_VERSION,
  appSettingsSchema,
  appSettingsSnapshotSchema,
  newProxyId,
  newServerId,
  proxyConfigSchema,
  serverConfigSchema,
  serverSnapshotSchema,
  toAppSettingsSnapshot,
} from '../../../../src/shared';

const CANARY_SECRET_REF = 'CANARY-SECRETREF-8f14e45fceea167a';

function server(id: string, origin: string, overrides: Record<string, unknown> = {}) {
  return serverConfigSchema.parse({
    id: newServerId(() => id),
    label: `Server ${id}`,
    origin,
    color: { kind: 'swatch' as const, swatch: 'blue' as const },
    revision: 0,
    ...overrides,
  });
}

function settingsWithServerProxyCredentials(secretRef: string) {
  const serverA = server('server-a', 'https://a.example', {
    proxy: {
      url: 'https://proxy.example',
      credentials: { username: 'alice', secretRef },
    },
  });
  return appSettingsSchema.parse({
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    hosts: [serverA],
    activeHostId: serverA.id,
    proxies: [],
    defaultModel: null,
    defaultReasoningEffort: null,
  });
}

describe('toAppSettingsSnapshot', () => {
  it('never emits the secretRef, even though it is present on the input', () => {
    const settings = settingsWithServerProxyCredentials(CANARY_SECRET_REF);

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(CANARY_SECRET_REF);
  });

  it('maps proxy credentials to only username and hasPassword', () => {
    const settings = settingsWithServerProxyCredentials(CANARY_SECRET_REF);

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    const proxy = snapshot.hosts[0]?.proxy;
    expect(proxy).toBeDefined();
    expect(proxy?.credentials).toEqual({ username: 'alice', hasPassword: true });
    // Exactly these two keys - no secretRef, no password, nothing else.
    expect(Object.keys(proxy?.credentials ?? {}).sort()).toEqual(['hasPassword', 'username']);
  });

  it('reports hasPassword: false when the predicate says there is no stored secret', () => {
    const settings = settingsWithServerProxyCredentials(CANARY_SECRET_REF);

    const snapshot = toAppSettingsSnapshot(settings, () => false);

    expect(snapshot.hosts[0]?.proxy?.credentials?.hasPassword).toBe(false);
  });

  it('projects a host proxy-library reference (proxyId) through unchanged', () => {
    const proxyEntry = proxyConfigSchema.parse({
      id: newProxyId(() => 'proxy-1'),
      label: 'Corporate',
      url: 'https://proxy.example:8080',
    });
    const serverA = server('server-a', 'https://a.example', { proxyId: proxyEntry.id });
    const settings = appSettingsSchema.parse({
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      hosts: [serverA],
      activeHostId: serverA.id,
      proxies: [proxyEntry],
      defaultModel: null,
      defaultReasoningEffort: null,
    });

    const snapshot = toAppSettingsSnapshot(settings, () => false);

    expect(snapshot.hosts[0]?.proxyId).toBe(proxyEntry.id);
    // The projected host re-parses under the snapshot schema.
    expect(() => serverSnapshotSchema.parse(snapshot.hosts[0])).not.toThrow();
  });

  it('calls the predicate with the exact secretRef recorded for that proxy', () => {
    const settings = settingsWithServerProxyCredentials(CANARY_SECRET_REF);
    const seenRefs: string[] = [];

    toAppSettingsSnapshot(settings, (ref) => {
      seenRefs.push(ref);
      return true;
    });

    expect(seenRefs).toEqual([CANARY_SECRET_REF]);
  });

  it('omits proxy.credentials entirely when the server has no proxy credentials configured', () => {
    const serverA = server('server-a', 'https://a.example');
    const settings = appSettingsSchema.parse({
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      hosts: [serverA],
      activeHostId: serverA.id,
      proxies: [],
      defaultModel: null,
      defaultReasoningEffort: null,
    });

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    expect(snapshot.hosts[0]?.proxy).toBeUndefined();
  });

  it('maps a proxy-library entry with its id and label, and hashes its password', () => {
    const serverA = server('server-a', 'https://a.example');
    const settings = appSettingsSchema.parse({
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      hosts: [serverA],
      activeHostId: serverA.id,
      proxies: [
        {
          id: newProxyId(() => 'proxy-a'),
          label: 'Corporate',
          url: 'https://copilot-proxy.example',
          credentials: { username: 'bob', secretRef: CANARY_SECRET_REF },
        },
      ],
      defaultModel: null,
      defaultReasoningEffort: null,
    });

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    expect(snapshot.proxies).toEqual([
      {
        id: 'proxy-a',
        label: 'Corporate',
        url: 'https://copilot-proxy.example',
        credentials: { username: 'bob', hasPassword: true },
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(CANARY_SECRET_REF);
  });

  it('preserves tlsException, which is not a secret', () => {
    const serverA = server('server-a', 'https://a.example', {
      tlsException: {
        origin: 'https://a.example',
        certificateSha256Fingerprint: 'a'.repeat(64),
        errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
      },
    });
    const settings = appSettingsSchema.parse({
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      hosts: [serverA],
      activeHostId: serverA.id,
      proxies: [],
      defaultModel: null,
      defaultReasoningEffort: null,
    });

    const snapshot = toAppSettingsSnapshot(settings, () => false);

    expect(snapshot.hosts[0]?.tlsException).toEqual({
      origin: 'https://a.example',
      certificateSha256Fingerprint: 'a'.repeat(64),
      errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
    });
  });

  it('produces a value that re-validates against appSettingsSnapshotSchema', () => {
    const settings = settingsWithServerProxyCredentials(CANARY_SECRET_REF);

    const snapshot = toAppSettingsSnapshot(settings, () => true);

    expect(() => appSettingsSnapshotSchema.parse(snapshot)).not.toThrow();
  });
});

describe('serverSnapshotSchema / appSettingsSnapshotSchema (.strict())', () => {
  const validServerSnapshot = {
    id: newServerId(() => 'server-a'),
    label: 'Production',
    origin: 'https://a.example',
    color: { kind: 'swatch' as const, swatch: 'blue' as const },
    revision: 0,
  };

  it('rejects a server snapshot carrying a secretRef', () => {
    expect(() =>
      serverSnapshotSchema.parse({
        ...validServerSnapshot,
        proxy: {
          url: 'https://proxy.example',
          credentials: { username: 'alice', hasPassword: true, secretRef: 'server:x' },
        },
      }),
    ).toThrow();
  });

  it('rejects a server snapshot carrying a password field', () => {
    expect(() =>
      serverSnapshotSchema.parse({
        ...validServerSnapshot,
        proxy: {
          url: 'https://proxy.example',
          credentials: { username: 'alice', hasPassword: true, password: 'hunter2' },
        },
      }),
    ).toThrow();
  });

  it('rejects an app settings snapshot with an unknown top-level key', () => {
    expect(() =>
      appSettingsSnapshotSchema.parse({
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
        hosts: [],
        activeHostId: null,
        proxies: [],
        defaultModel: null,
        defaultReasoningEffort: null,
        secretsDir: '/should/not/be/here',
      }),
    ).toThrow();
  });
});
