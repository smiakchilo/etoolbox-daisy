import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_SETTINGS_SCHEMA_VERSION, newProxyId, newServerId } from '../../../../src/shared';
import { defaultAppSettings, type AppSettings } from '../../../../src/shared';
import { serverConfigSchema } from '../../../../src/shared';
import { toAppSettingsSnapshot } from '../../../../src/shared';
import { saveSettings } from '../../../../src/main/settingsStore';
import { createSecretStore, type SecretCipher } from '../../../../src/main/secretStore';
import {
  addProxy,
  addServer,
  clearPassword,
  getSettingsSnapshot,
  isTrustedLocalSettingsSender,
  removeProxy,
  removeServer,
  reorderProxies,
  reorderServers,
  resolvePasswordSecretRef,
  setPassword,
  updateProxy,
  updateServerPresentation,
  updateServerTargeting,
  type SettingsIpcSenderInfo,
  type TrustedSenderExpectation,
} from '../../../../src/main/ipc/settings';

const CANARY_PASSWORD = 'CANARY-PASSWORD-8f14e45fceea167a';

/** Scratch directories live under the project's own `test-results/`, never an OS temp dir. */
const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'main-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'settingsIpc-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A real (non-Electron) AES-256-GCM cipher standing in for `electron.safeStorage`. */
function createFakeCipher(options: { available?: boolean } = {}): SecretCipher {
  const available = options.available ?? true;
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => available,
    encryptString(plainText: string): Buffer {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return Buffer.concat([iv, authTag, ciphertext]);
    },
    decryptString(encrypted: Buffer): string {
      const iv = encrypted.subarray(0, 12);
      const authTag = encrypted.subarray(12, 28);
      const ciphertext = encrypted.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}

function serverWithProxy(secretRef: string, options: { username?: string } = {}): AppSettings {
  const server = serverConfigSchema.parse({
    id: newServerId(() => 'server-a'),
    label: 'Production',
    origin: 'https://a.example',
    color: { kind: 'swatch' as const, swatch: 'blue' as const },
    revision: 0,
    proxy: {
      url: 'https://proxy.example',
      credentials: { username: options.username ?? 'alice', secretRef },
    },
  });
  return {
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    hosts: [server],
    activeHostId: server.id,
    proxies: [],
    defaultModel: null,
    defaultReasoningEffort: null,
  };
}

const SERVER_ID = newServerId(() => 'server-a');

async function writeSettings(settingsDir: string, settings: AppSettings): Promise<void> {
  const result = await saveSettings(settingsDir, settings);
  if (!result.ok) throw new Error(`failed to write test settings: ${result.error.message}`);
}

describe('getSettingsSnapshot / setPassword / clearPassword (round trip)', () => {
  it('stores a password, reports hasPassword: true, and never leaks it through the snapshot', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, serverWithProxy('server:server-a:proxy'));

    const setResult = await setPassword(settingsDir, secretStore, {
      target: { kind: 'server', serverId: SERVER_ID },
      password: CANARY_PASSWORD,
    });
    expect(setResult).toEqual({ ok: true });
    // The success result carries no data - `Object.keys` proves nothing but
    // `ok` is present, not merely that a stringify happens not to include it.
    expect(Object.keys(setResult)).toEqual(['ok']);

    const snapshotResult = await getSettingsSnapshot(settingsDir, secretStore);
    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) throw new Error('expected ok snapshot result');
    expect(snapshotResult.snapshot.hosts[0]?.proxy?.credentials).toEqual({
      username: 'alice',
      hasPassword: true,
    });

    const serialized = JSON.stringify(snapshotResult);
    expect(serialized).not.toContain(CANARY_PASSWORD);
    expect(serialized).not.toContain('server:server-a:proxy');

    // The password is recoverable only through the secret store directly.
    await expect(secretStore.get('server:server-a:proxy')).resolves.toBe(CANARY_PASSWORD);
  });

  it('reports hasPassword: false before any password has been set', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, serverWithProxy('server:server-a:proxy'));

    const snapshotResult = await getSettingsSnapshot(settingsDir, secretStore);

    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) throw new Error('expected ok snapshot result');
    expect(snapshotResult.snapshot.hosts[0]?.proxy?.credentials).toEqual({
      username: 'alice',
      hasPassword: false,
    });
  });

  it('clears a stored password: hasPassword flips back to false and the store no longer has it', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, serverWithProxy('server:server-a:proxy'));
    await setPassword(settingsDir, secretStore, {
      target: { kind: 'server', serverId: SERVER_ID },
      password: CANARY_PASSWORD,
    });

    const clearResult = await clearPassword(settingsDir, secretStore, {
      target: { kind: 'server', serverId: SERVER_ID },
    });

    expect(clearResult).toEqual({ ok: true });
    await expect(secretStore.get('server:server-a:proxy')).resolves.toBeUndefined();
    const snapshotResult = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshotResult.ok) throw new Error('expected ok snapshot result');
    expect(snapshotResult.snapshot.hosts[0]?.proxy?.credentials?.hasPassword).toBe(false);
  });

  it('round-trips a password for a proxy-library target', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    const proxyId = newProxyId(() => 'proxy-a');
    const settings: AppSettings = {
      ...defaultAppSettings(),
      proxies: [
        {
          id: proxyId,
          label: 'Corporate',
          url: 'https://copilot-proxy.example',
          credentials: { username: 'bob', secretRef: 'proxy:proxy-a' },
        },
      ],
    };
    await writeSettings(settingsDir, settings);

    const setResult = await setPassword(settingsDir, secretStore, {
      target: { kind: 'proxy', proxyId },
      password: CANARY_PASSWORD,
    });
    expect(setResult).toEqual({ ok: true });

    await expect(secretStore.get('proxy:proxy-a')).resolves.toBe(CANARY_PASSWORD);
    const snapshotResult = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshotResult.ok) throw new Error('expected ok snapshot result');
    expect(snapshotResult.snapshot.proxies[0]?.credentials).toEqual({
      username: 'bob',
      hasPassword: true,
    });
  });

  it('returns no_proxy_configured when setting a password for a server with no proxy configured', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    const server = serverConfigSchema.parse({
      id: SERVER_ID,
      label: 'Production',
      origin: 'https://a.example',
      color: { kind: 'swatch' as const, swatch: 'blue' as const },
      revision: 0,
    });
    await writeSettings(settingsDir, {
      ...defaultAppSettings(),
      hosts: [server],
      activeHostId: server.id,
    });

    const result = await setPassword(settingsDir, secretStore, {
      target: { kind: 'server', serverId: SERVER_ID },
      password: CANARY_PASSWORD,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('no_proxy_configured');
  });

  it('returns no_proxy_configured when clearing a password for an unknown server id', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await clearPassword(settingsDir, secretStore, {
      target: { kind: 'server', serverId: newServerId(() => 'unknown-server') },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('no_proxy_configured');
  });

  it('returns storage_error when the settings file is corrupt', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(path.join(settingsDir, 'settings.json'), '{ not valid json', 'utf8');

    const result = await getSettingsSnapshot(settingsDir, secretStore);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('storage_error');
  });

  it('returns storage_error, never a snapshot with the exception treated as approved, for a legacy tlsException missing errorClass', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        schemaVersion: 1,
        hosts: [
          {
            id: SERVER_ID,
            label: 'Production',
            origin: 'https://a.example',
            color: { kind: 'swatch', swatch: 'blue' },
            revision: 0,
            // Pre-errorClass persisted shape - the exact thing a real
            // upgrade from before this field existed would leave on disk.
            tlsException: {
              origin: 'https://a.example',
              certificateSha256Fingerprint: 'a'.repeat(64),
            },
          },
        ],
        activeHostId: SERVER_ID,
        proxies: [],
        defaultModel: null,
        defaultReasoningEffort: null,
      }),
      'utf8',
    );

    const result = await getSettingsSnapshot(settingsDir, secretStore);

    // A snapshot carrying that tlsException at all - approved or not - would
    // mean the exception survived a failed validation, which is the one
    // dangerous outcome. Failing the whole snapshot is blunt but safe: there
    // is no `result.snapshot` here for a caller to read a certificate
    // exception out of.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('storage_error');
  });

  it('returns secret_storage_unavailable, not a silent success, when secure storage is unavailable', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(
      path.join(settingsDir, 'secrets'),
      createFakeCipher({ available: false }),
    );
    await writeSettings(settingsDir, serverWithProxy('server:server-a:proxy'));

    const result = await setPassword(settingsDir, secretStore, {
      target: { kind: 'server', serverId: SERVER_ID },
      password: CANARY_PASSWORD,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('secret_storage_unavailable');
  });
});

describe('addServer', () => {
  it('creates and persists a new server, returning it as a secret-free snapshot', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await addServer(settingsDir, secretStore, {
      label: 'Staging',
      origin: 'https://staging.example',
      color: { kind: 'swatch', swatch: 'blue' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an ok result');
    expect(result.server.label).toBe('Staging');
    expect(result.server.origin).toBe('https://staging.example');
    expect(JSON.stringify(result)).not.toContain('secretRef');

    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected ok snapshot result');
    expect(snapshot.snapshot.hosts).toHaveLength(1);
  });

  it('returns duplicate_origin, not a raw throw, for an origin already in use', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, serverWithProxy('server:server-a:proxy'));

    const result = await addServer(settingsDir, secretStore, {
      label: 'Duplicate',
      origin: 'https://a.example',
      color: { kind: 'swatch', swatch: 'blue' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('duplicate_origin');
  });

  it('adds a plain-HTTP origin without any confirmation flag', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await addServer(settingsDir, secretStore, {
      label: 'Insecure',
      origin: 'http://insecure.example',
      color: { kind: 'swatch', swatch: 'blue' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.server.origin).toBe('http://insecure.example');
    }
  });

  it('returns storage_error rather than throwing when the settings file is corrupt', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(path.join(settingsDir, 'settings.json'), '{ not valid json', 'utf8');

    const result = await addServer(settingsDir, secretStore, {
      label: 'Insecure',
      origin: 'http://insecure.example',
      color: { kind: 'swatch', swatch: 'blue' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('storage_error');
  });
});

describe('removeServer', () => {
  it('removes the server and persists the change', async () => {
    const settingsDir = createScratchRoot();
    await writeSettings(settingsDir, serverWithProxy('server:server-a:proxy'));

    const result = await removeServer(settingsDir, { serverId: SERVER_ID });

    expect(result).toEqual({ ok: true });
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected ok snapshot result');
    expect(snapshot.snapshot.hosts).toHaveLength(0);
  });

  it('returns server_not_found, not a raw throw, for an unknown server id', async () => {
    const settingsDir = createScratchRoot();
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await removeServer(settingsDir, {
      serverId: newServerId(() => 'ghost-server'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('server_not_found');
  });

  it('clears activeHostId, rather than leaving a dangling reference, when the removed server was active', async () => {
    const settingsDir = createScratchRoot();
    await writeSettings(settingsDir, serverWithProxy('server:server-a:proxy'));

    const result = await removeServer(settingsDir, { serverId: SERVER_ID });
    expect(result).toEqual({ ok: true });

    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected ok snapshot result');
    expect(snapshot.snapshot.activeHostId).toBeNull();
  });
});

describe('reorderServers', () => {
  function twoServerSettings(): AppSettings {
    const a = serverConfigSchema.parse({
      id: newServerId(() => 'server-a'),
      label: 'A',
      origin: 'https://a.example',
      color: { kind: 'swatch' as const, swatch: 'blue' as const },
      revision: 0,
    });
    const b = serverConfigSchema.parse({
      id: newServerId(() => 'server-b'),
      label: 'B',
      origin: 'https://b.example',
      color: { kind: 'swatch' as const, swatch: 'red' as const },
      revision: 0,
    });
    return {
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      hosts: [a, b],
      activeHostId: a.id,
      proxies: [],
      defaultModel: null,
      defaultReasoningEffort: null,
    };
  }

  it('persists the requested order', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, twoServerSettings());

    const result = await reorderServers(settingsDir, {
      serverIds: [newServerId(() => 'server-b'), newServerId(() => 'server-a')],
    });

    expect(result).toEqual({ ok: true });
    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected ok snapshot result');
    expect(snapshot.snapshot.hosts.map((server) => server.id)).toEqual([
      newServerId(() => 'server-b'),
      newServerId(() => 'server-a'),
    ]);
  });

  it('rejects an order that is not a permutation instead of dropping a server', async () => {
    const settingsDir = createScratchRoot();
    await writeSettings(settingsDir, twoServerSettings());

    const result = await reorderServers(settingsDir, {
      serverIds: [newServerId(() => 'server-a')],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('invalid_change');
  });
});

describe('updateServerPresentation', () => {
  it('updates label/colour and returns the updated snapshot', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, serverWithProxy('server:server-a:proxy'));

    const result = await updateServerPresentation(settingsDir, secretStore, {
      serverId: SERVER_ID,
      changes: { label: 'Renamed', color: { kind: 'swatch', swatch: 'purple' } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an ok result');
    expect(result.server.label).toBe('Renamed');
  });

  it('returns server_not_found for an unknown server id', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await updateServerPresentation(settingsDir, secretStore, {
      serverId: newServerId(() => 'ghost-server'),
      changes: { label: 'X' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('server_not_found');
  });
});

describe('updateServerTargeting', () => {
  it('requires confirmation for an origin change and rejects the request without it', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, serverWithProxy('server:server-a:proxy'));

    const result = await updateServerTargeting(settingsDir, secretStore, {
      serverId: SERVER_ID,
      changes: { origin: 'https://b.example' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('origin_change_requires_confirmation');
  });

  it('changes the origin once originChangeConfirmed is set, reporting kind: origin_changed', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, serverWithProxy('server:server-a:proxy'));

    const result = await updateServerTargeting(settingsDir, secretStore, {
      serverId: SERVER_ID,
      changes: { origin: 'https://b.example' },
      originChangeConfirmed: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an ok result');
    expect(result.server.origin).toBe('https://b.example');
    expect(result.kind).toBe('origin_changed');
  });

  it('returns server_not_found for an unknown server id', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await updateServerTargeting(settingsDir, secretStore, {
      serverId: newServerId(() => 'ghost-server'),
      changes: { origin: 'https://b.example' },
      originChangeConfirmed: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('server_not_found');
  });
});

describe('addProxy / updateProxy / removeProxy / reorderProxies', () => {
  it('addProxy creates and persists an entry, returning it as a secret-free snapshot', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await addProxy(settingsDir, secretStore, {
      label: 'Corporate',
      url: 'https://copilot-proxy.example',
      username: 'alice',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.proxy.label).toBe('Corporate');
    expect(result.proxy.url).toBe('https://copilot-proxy.example');
    expect(result.proxy.credentials).toEqual({ username: 'alice', hasPassword: false });
    expect(JSON.stringify(result)).not.toContain('secretRef');

    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected ok snapshot result');
    expect(snapshot.snapshot.proxies).toHaveLength(1);
  });

  it('updateProxy deletes the orphaned password from the secret store when the username is omitted', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    const proxyId = newProxyId(() => 'proxy-a');
    const settings: AppSettings = {
      ...defaultAppSettings(),
      proxies: [
        {
          id: proxyId,
          label: 'Corporate',
          url: 'https://copilot-proxy.example',
          credentials: { username: 'alice', secretRef: 'proxy:proxy-a' },
        },
      ],
    };
    await writeSettings(settingsDir, settings);
    await setPassword(settingsDir, secretStore, {
      target: { kind: 'proxy', proxyId },
      password: CANARY_PASSWORD,
    });

    const result = await updateProxy(settingsDir, secretStore, {
      proxyId,
      label: 'Corporate',
      url: 'https://new-copilot-proxy.example',
    });

    expect(result).toEqual({ ok: true });
    await expect(secretStore.get('proxy:proxy-a')).resolves.toBeUndefined();
    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected ok snapshot result');
    expect(snapshot.snapshot.proxies[0]?.credentials).toBeUndefined();
    expect(snapshot.snapshot.proxies[0]?.url).toBe('https://new-copilot-proxy.example');
  });

  it('updateProxy returns proxy_not_found for an unknown id', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await updateProxy(settingsDir, secretStore, {
      proxyId: newProxyId(() => 'ghost-proxy'),
      label: 'Corporate',
      url: 'https://copilot-proxy.example',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('proxy_not_found');
  });

  it('removeProxy deletes the entry and its orphaned password', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    const proxyId = newProxyId(() => 'proxy-a');
    const settings: AppSettings = {
      ...defaultAppSettings(),
      proxies: [
        {
          id: proxyId,
          label: 'Corporate',
          url: 'https://copilot-proxy.example',
          credentials: { username: 'alice', secretRef: 'proxy:proxy-a' },
        },
      ],
    };
    await writeSettings(settingsDir, settings);
    await setPassword(settingsDir, secretStore, {
      target: { kind: 'proxy', proxyId },
      password: CANARY_PASSWORD,
    });

    const result = await removeProxy(settingsDir, secretStore, { proxyId });

    expect(result).toEqual({ ok: true });
    await expect(secretStore.get('proxy:proxy-a')).resolves.toBeUndefined();
    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected ok snapshot result');
    expect(snapshot.snapshot.proxies).toEqual([]);
  });

  it('reorderProxies persists the new order', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    const proxyIdA = newProxyId(() => 'proxy-a');
    const proxyIdB = newProxyId(() => 'proxy-b');
    await writeSettings(settingsDir, {
      ...defaultAppSettings(),
      proxies: [
        { id: proxyIdA, label: 'A', url: 'https://a.example' },
        { id: proxyIdB, label: 'B', url: 'https://b.example' },
      ],
    });

    const result = await reorderProxies(settingsDir, { proxyIds: [proxyIdB, proxyIdA] });

    expect(result).toEqual({ ok: true });
    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected ok snapshot result');
    expect(snapshot.snapshot.proxies.map((proxy) => proxy.id)).toEqual([proxyIdB, proxyIdA]);
  });

  it('returns storage_error rather than throwing when the settings file is corrupt', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(path.join(settingsDir, 'settings.json'), '{ not valid json', 'utf8');

    const result = await addProxy(settingsDir, secretStore, {
      label: 'Corporate',
      url: 'https://copilot-proxy.example',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('storage_error');
  });
});

describe('resolvePasswordSecretRef', () => {
  it('resolves the secretRef already recorded for a server target', () => {
    const settings = serverWithProxy('server:server-a:proxy');

    const result = resolvePasswordSecretRef(settings, { kind: 'server', serverId: SERVER_ID });

    expect(result).toEqual({ ok: true, value: 'server:server-a:proxy' });
  });

  it('resolves the secretRef already recorded for a proxy-library target', () => {
    const proxyId = newProxyId(() => 'proxy-a');
    const settings: AppSettings = {
      ...defaultAppSettings(),
      proxies: [
        {
          id: proxyId,
          label: 'Corporate',
          url: 'https://copilot-proxy.example',
          credentials: { username: 'bob', secretRef: 'proxy:proxy-a' },
        },
      ],
    };

    const result = resolvePasswordSecretRef(settings, { kind: 'proxy', proxyId });

    expect(result).toEqual({ ok: true, value: 'proxy:proxy-a' });
  });

  it('never mints a new secretRef for a target with no proxy configured', () => {
    const result = resolvePasswordSecretRef(defaultAppSettings(), {
      kind: 'proxy',
      proxyId: newProxyId(() => 'proxy-a'),
    });

    expect(result.ok).toBe(false);
  });
});

describe('isTrustedLocalSettingsSender', () => {
  const SHELL_ID = 1;
  const OTHER_LOCAL_ID = 2;
  const expectation: TrustedSenderExpectation = {
    isTrustedWebContentsId: (id) => id === SHELL_ID,
    rendererDistDir: path.join('C:', 'app', 'out', 'renderer'),
  };

  function localFileSender(overrides: Partial<SettingsIpcSenderInfo> = {}): SettingsIpcSenderInfo {
    return {
      url: `file:///${path.join('C:', 'app', 'out', 'renderer', 'index.html').replace(/\\/g, '/')}`,
      isMainFrame: true,
      webContentsId: SHELL_ID,
      ...overrides,
    };
  }

  it("trusts the main frame of the expected window showing the packaged app's own file:// URL", () => {
    expect(isTrustedLocalSettingsSender(localFileSender(), expectation)).toBe(true);
  });

  it('rejects a request with no sender frame (navigated away / destroyed)', () => {
    expect(isTrustedLocalSettingsSender(undefined, expectation)).toBe(false);
  });

  it('rejects a remote AEM-like origin', () => {
    const sender = localFileSender({ url: 'https://author.example/some/page' });
    expect(isTrustedLocalSettingsSender(sender, expectation)).toBe(false);
  });

  it('rejects a sender whose webContents id is not a known app window', () => {
    const sender = localFileSender({ webContentsId: 999 });
    expect(isTrustedLocalSettingsSender(sender, expectation)).toBe(false);
  });

  // The Settings surface is served from the one-and-only shell window (it
  // became a panel in the shell, not a separate child window), so the shell
  // id is the only trusted webContents id. The check remains a predicate so
  // a future panel surface (e.g. History) can join without re-typing it.
  it('rejects any other local webContents id: the shell is the only trusted window', () => {
    const sender = localFileSender({ webContentsId: OTHER_LOCAL_ID });
    expect(isTrustedLocalSettingsSender(sender, expectation)).toBe(false);
  });

  it('rejects a sender whose trust has been revoked', () => {
    const revoked: TrustedSenderExpectation = {
      isTrustedWebContentsId: () => false,
      rendererDistDir: path.join('C:', 'app', 'out', 'renderer'),
    };
    const sender = localFileSender();
    expect(isTrustedLocalSettingsSender(sender, revoked)).toBe(false);
  });

  it('rejects a request from a non-top-level (iframe) frame', () => {
    const sender = localFileSender({ isMainFrame: false });
    expect(isTrustedLocalSettingsSender(sender, expectation)).toBe(false);
  });

  it('trusts the electron-vite dev server origin when ELECTRON_RENDERER_URL is set', () => {
    const previous = process.env['ELECTRON_RENDERER_URL'];
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
    try {
      const sender = localFileSender({ url: 'http://localhost:5173/index.html' });
      expect(isTrustedLocalSettingsSender(sender, expectation)).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env['ELECTRON_RENDERER_URL'];
      } else {
        process.env['ELECTRON_RENDERER_URL'] = previous;
      }
    }
  });

  it('rejects an unparsable URL', () => {
    const sender = localFileSender({ url: 'not a url' });
    expect(isTrustedLocalSettingsSender(sender, expectation)).toBe(false);
  });
});

describe('toAppSettingsSnapshot via getSettingsSnapshot never leaks the canary password', () => {
  it('does not include the canary password anywhere in the JSON-serialized snapshot', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, serverWithProxy('server:server-a:proxy'));
    await setPassword(settingsDir, secretStore, {
      target: { kind: 'server', serverId: SERVER_ID },
      password: CANARY_PASSWORD,
    });

    const result = await getSettingsSnapshot(settingsDir, secretStore);
    if (!result.ok) throw new Error('expected ok snapshot result');

    // Exercise the pure mapper directly too, since it is the structural
    // guarantee this test is really about.
    const settings = serverWithProxy('server:server-a:proxy');
    const directSnapshot = toAppSettingsSnapshot(settings, () => true);

    expect(JSON.stringify(result.snapshot)).not.toContain(CANARY_PASSWORD);
    expect(JSON.stringify(directSnapshot)).not.toContain(CANARY_PASSWORD);
    expect(JSON.stringify(directSnapshot)).not.toContain('server:server-a:proxy');
  });
});
