import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newProjectId, newProxyId, newServerId } from '../../../../src/shared';
import {
  defaultAppSettings,
  type AgentDefinition,
  type AgentId,
  type AppSettings,
} from '../../../../src/shared';
import { type ServerConfig, projectConfigSchema, serverConfigSchema } from '../../../../src/shared';
import { toAppSettingsSnapshot } from '../../../../src/shared';
import { saveSettings } from '../../../../src/main/settingsStore';
import { createSecretStore, type SecretCipher } from '../../../../src/main/secretStore';
import {
  addProject,
  addProxy,
  addServer,
  clearPassword,
  getSettingsSnapshot,
  isTrustedLocalSettingsSender,
  removeProject,
  removeProxy,
  removeServer,
  reorderProjects,
  reorderProxies,
  reorderServers,
  resolvePasswordSecretRef,
  setPassword,
  updateBrowserSettings,
  updateProject,
  updateProxy,
  updateServerPresentation,
  updateServerTargeting,
  type SettingsIpcSenderInfo,
  type TrustedSenderExpectation,
} from '../../../../src/main/ipc/settings';
import { TEST_AGENT_DEFINITIONS, TEST_AGENT_ID } from '../../../support/agentDefinitions';

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

const PROXY_ID = newProxyId(() => 'proxy-a');
const PROXY_SECRET_REF = 'proxy:proxy-a';

function settingsWithProxy(secretRef: string, options: { username?: string } = {}): AppSettings {
  return {
    hosts: [],
    projects: [],
    proxies: [
      {
        id: PROXY_ID,
        label: 'Corporate',
        url: 'https://proxy.example',
        credentials: { username: options.username ?? 'alice', secretRef },
      },
    ],
    agents: { [TEST_AGENT_ID]: { active: true } },
    browser: { disableNativeWebAuthn: true },
  };
}

const SERVER_ID = newServerId(() => 'server-a');

/** A settings document with exactly one server and no proxy library. */
function settingsWithServer(): AppSettings {
  const server = serverConfigSchema.parse({
    id: SERVER_ID,
    label: 'Production',
    origin: 'https://a.example',
    color: { kind: 'swatch' as const, swatch: 'blue' as const },
    revision: 0,
  });
  return { ...defaultAppSettings(), hosts: [server] };
}

async function writeSettings(settingsDir: string, settings: AppSettings): Promise<void> {
  const result = await saveSettings(settingsDir, settings);
  if (!result.ok) throw new Error(`failed to write test settings: ${result.error.message}`);
}

describe('getSettingsSnapshot / setPassword / clearPassword (round trip)', () => {
  it('stores a password, reports hasPassword: true, and never leaks it through the snapshot', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, settingsWithProxy(PROXY_SECRET_REF));

    const setResult = await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'proxy', proxyId: PROXY_ID },
        password: CANARY_PASSWORD,
      },
      TEST_AGENT_DEFINITIONS,
    );
    expect(setResult).toEqual({ ok: true });
    // The success result carries no data - `Object.keys` proves nothing but
    // `ok` is present, not merely that a stringify happens not to include it.
    expect(Object.keys(setResult)).toEqual(['ok']);

    const snapshotResult = await getSettingsSnapshot(settingsDir, secretStore);
    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) throw new Error('expected ok snapshot result');
    expect(snapshotResult.snapshot.proxies[0]?.credentials).toEqual({
      username: 'alice',
      hasPassword: true,
    });

    const serialized = JSON.stringify(snapshotResult);
    expect(serialized).not.toContain(CANARY_PASSWORD);
    expect(serialized).not.toContain(PROXY_SECRET_REF);

    // The password is recoverable only through the secret store directly.
    await expect(secretStore.get(PROXY_SECRET_REF)).resolves.toBe(CANARY_PASSWORD);
  });

  it('reports hasPassword: false before any password has been set', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, settingsWithProxy(PROXY_SECRET_REF));

    const snapshotResult = await getSettingsSnapshot(settingsDir, secretStore);

    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) throw new Error('expected ok snapshot result');
    expect(snapshotResult.snapshot.proxies[0]?.credentials).toEqual({
      username: 'alice',
      hasPassword: false,
    });
  });

  it('clears a stored password: hasPassword flips back to false and the store no longer has it', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, settingsWithProxy(PROXY_SECRET_REF));
    await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'proxy', proxyId: PROXY_ID },
        password: CANARY_PASSWORD,
      },
      TEST_AGENT_DEFINITIONS,
    );

    const clearResult = await clearPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'proxy', proxyId: PROXY_ID },
      },
      TEST_AGENT_DEFINITIONS,
    );

    expect(clearResult).toEqual({ ok: true });
    await expect(secretStore.get(PROXY_SECRET_REF)).resolves.toBeUndefined();
    const snapshotResult = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshotResult.ok) throw new Error('expected ok snapshot result');
    expect(snapshotResult.snapshot.proxies[0]?.credentials?.hasPassword).toBe(false);
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

    const setResult = await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'proxy', proxyId },
        password: CANARY_PASSWORD,
      },
      TEST_AGENT_DEFINITIONS,
    );
    expect(setResult).toEqual({ ok: true });

    await expect(secretStore.get('proxy:proxy-a')).resolves.toBe(CANARY_PASSWORD);
    const snapshotResult = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshotResult.ok) throw new Error('expected ok snapshot result');
    expect(snapshotResult.snapshot.proxies[0]?.credentials).toEqual({
      username: 'bob',
      hasPassword: true,
    });
  });

  it('returns no_proxy_configured when setting a password for a proxy entry with no username configured', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, {
      ...defaultAppSettings(),
      proxies: [{ id: PROXY_ID, label: 'Corporate', url: 'https://proxy.example' }],
    });

    const result = await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'proxy', proxyId: PROXY_ID },
        password: CANARY_PASSWORD,
      },
      TEST_AGENT_DEFINITIONS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('no_proxy_configured');
  });

  it('returns no_proxy_configured when clearing a password for an unknown proxy id', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await clearPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'proxy', proxyId: newProxyId(() => 'unknown-proxy') },
      },
      TEST_AGENT_DEFINITIONS,
    );

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

  it('drops a legacy tlsException missing errorClass rather than presenting it as approved', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
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
        proxies: [],
        agents: { [TEST_AGENT_ID]: { active: true } },
      }),
      'utf8',
    );

    const result = await getSettingsSnapshot(settingsDir, secretStore);

    // Fail closed: the unapprovable exception is discarded, so the snapshot
    // still loads and carries no trace of it - never a certificate treated as
    // approved.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok snapshot result');
    expect(result.snapshot.hosts).toHaveLength(1);
    expect(result.snapshot.hosts[0]?.tlsException).toBeUndefined();
  });

  it('returns secret_storage_unavailable, not a silent success, when secure storage is unavailable', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(
      path.join(settingsDir, 'secrets'),
      createFakeCipher({ available: false }),
    );
    await writeSettings(settingsDir, settingsWithProxy(PROXY_SECRET_REF));

    const result = await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'proxy', proxyId: PROXY_ID },
        password: CANARY_PASSWORD,
      },
      TEST_AGENT_DEFINITIONS,
    );

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
    await writeSettings(settingsDir, settingsWithServer());

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
    await writeSettings(settingsDir, settingsWithServer());

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
      hosts: [a, b],
      projects: [],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true } },
      browser: { disableNativeWebAuthn: true },
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

describe('updateBrowserSettings', () => {
  it('persists the flag and reads it back through the snapshot', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await updateBrowserSettings(settingsDir, {
      changes: { disableNativeWebAuthn: false },
    });
    expect(result).toEqual({ ok: true });

    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error('expected a snapshot');
    expect(snapshot.snapshot.browser.disableNativeWebAuthn).toBe(false);
  });

  it('sets and clears the browser default proxy', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, {
      ...defaultAppSettings(),
      proxies: [{ id: PROXY_ID, label: 'Corporate', url: 'https://proxy.example' }],
    });

    const set = await updateBrowserSettings(settingsDir, { changes: { proxy: PROXY_ID } });
    expect(set).toEqual({ ok: true });
    const afterSet = await getSettingsSnapshot(settingsDir, secretStore);
    if (!afterSet.ok) throw new Error('expected a snapshot');
    expect(afterSet.snapshot.browser.proxy).toBe(PROXY_ID);

    const cleared = await updateBrowserSettings(settingsDir, { changes: { proxy: null } });
    expect(cleared).toEqual({ ok: true });
    const afterClear = await getSettingsSnapshot(settingsDir, secretStore);
    if (!afterClear.ok) throw new Error('expected a snapshot');
    expect(afterClear.snapshot.browser.proxy).toBeUndefined();
  });

  it('refuses a default proxy that does not name a configured entry', async () => {
    const settingsDir = createScratchRoot();
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await updateBrowserSettings(settingsDir, {
      changes: { proxy: newProxyId(() => 'proxy-ghost') },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('proxy_not_found');
  });

  it('reports a storage error when the settings file cannot be read', async () => {
    const settingsDir = createScratchRoot();
    writeFileSync(path.join(settingsDir, 'settings.json'), '{ not json', 'utf8');

    const result = await updateBrowserSettings(settingsDir, {
      changes: { disableNativeWebAuthn: false },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected an error result');
    expect(result.error.code).toBe('storage_error');
  });
});

describe('updateServerPresentation', () => {
  it('updates label/colour and returns the updated snapshot', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, settingsWithServer());

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
    await writeSettings(settingsDir, settingsWithServer());

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
    await writeSettings(settingsDir, settingsWithServer());

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
    await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'proxy', proxyId },
        password: CANARY_PASSWORD,
      },
      TEST_AGENT_DEFINITIONS,
    );

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
    await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'proxy', proxyId },
        password: CANARY_PASSWORD,
      },
      TEST_AGENT_DEFINITIONS,
    );

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
  it('resolves the secretRef already recorded for a proxy-library target', () => {
    const settings = settingsWithProxy(PROXY_SECRET_REF, { username: 'bob' });

    const result = resolvePasswordSecretRef(settings, { kind: 'proxy', proxyId: PROXY_ID });

    expect(result).toEqual({ ok: true, value: PROXY_SECRET_REF });
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
    await writeSettings(settingsDir, settingsWithProxy(PROXY_SECRET_REF));
    await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'proxy', proxyId: PROXY_ID },
        password: CANARY_PASSWORD,
      },
      TEST_AGENT_DEFINITIONS,
    );

    const result = await getSettingsSnapshot(settingsDir, secretStore);
    if (!result.ok) throw new Error('expected ok snapshot result');

    // Exercise the pure mapper directly too, since it is the structural
    // guarantee this test is really about.
    const settings = settingsWithProxy(PROXY_SECRET_REF);
    const directSnapshot = toAppSettingsSnapshot(settings, () => true);

    expect(JSON.stringify(result.snapshot)).not.toContain(CANARY_PASSWORD);
    expect(JSON.stringify(directSnapshot)).not.toContain(CANARY_PASSWORD);
    expect(JSON.stringify(directSnapshot)).not.toContain(PROXY_SECRET_REF);
  });
});

describe('agent token (setPassword / clearPassword targeting an agent)', () => {
  const CANARY_TOKEN = 'ghp_CANARY_TOKEN_7f3a91c4';
  const AGENT_TOKEN_REF = `agent-token:${TEST_AGENT_ID}`;

  it('stores a token, reports hasToken: true, and never leaks the token or its secretRef', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const setResult = await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'agent', agentId: TEST_AGENT_ID },
        password: CANARY_TOKEN,
      },
      TEST_AGENT_DEFINITIONS,
    );
    expect(setResult).toEqual({ ok: true });
    // The success result carries no data, so there is nothing to echo back.
    expect(Object.keys(setResult)).toEqual(['ok']);

    // The deterministic reference was minted and persisted so the snapshot can
    // resolve it; the secret itself lives only in the store.
    await expect(secretStore.get(AGENT_TOKEN_REF)).resolves.toBe(CANARY_TOKEN);

    const snapshotResult = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshotResult.ok) throw new Error('expected ok snapshot result');
    expect(snapshotResult.snapshot.agents[TEST_AGENT_ID]?.hasToken).toBe(true);

    const serialized = JSON.stringify(snapshotResult);
    expect(serialized).not.toContain(CANARY_TOKEN);
    expect(serialized).not.toContain(AGENT_TOKEN_REF);
  });

  it('overwrites an existing token without minting a second reference', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'agent', agentId: TEST_AGENT_ID },
        password: 'first-token',
      },
      TEST_AGENT_DEFINITIONS,
    );
    const second = await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'agent', agentId: TEST_AGENT_ID },
        password: CANARY_TOKEN,
      },
      TEST_AGENT_DEFINITIONS,
    );

    expect(second).toEqual({ ok: true });
    await expect(secretStore.get(AGENT_TOKEN_REF)).resolves.toBe(CANARY_TOKEN);
  });

  it('clears a token: the reference is removed and the secret deleted', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());
    await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'agent', agentId: TEST_AGENT_ID },
        password: CANARY_TOKEN,
      },
      TEST_AGENT_DEFINITIONS,
    );

    const cleared = await clearPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'agent', agentId: TEST_AGENT_ID },
      },
      TEST_AGENT_DEFINITIONS,
    );

    expect(cleared).toEqual({ ok: true });
    await expect(secretStore.get(AGENT_TOKEN_REF)).resolves.toBeUndefined();
    const snapshotResult = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshotResult.ok) throw new Error('expected ok snapshot result');
    expect(snapshotResult.snapshot.agents[TEST_AGENT_ID]?.hasToken).toBe(false);
  });

  it('returns no_token_configured when clearing an agent that has none', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const cleared = await clearPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'agent', agentId: TEST_AGENT_ID },
      },
      TEST_AGENT_DEFINITIONS,
    );

    expect(cleared.ok).toBe(false);
    if (cleared.ok) return;
    expect(cleared.error.code).toBe('no_token_configured');
  });

  it('returns agent_not_found for a provider this build does not ship', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const setResult = await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'agent', agentId: 'not-shipped' as AgentId },
        password: CANARY_TOKEN,
      },
      TEST_AGENT_DEFINITIONS,
    );

    expect(setResult.ok).toBe(false);
    if (setResult.ok) return;
    expect(setResult.error.code).toBe('agent_not_found');
  });

  it('does not persist a reference when the secret store is unavailable', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(
      path.join(settingsDir, 'secrets'),
      createFakeCipher({ available: false }),
    );
    await writeSettings(settingsDir, defaultAppSettings());

    const setResult = await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'agent', agentId: TEST_AGENT_ID },
        password: CANARY_TOKEN,
      },
      TEST_AGENT_DEFINITIONS,
    );

    expect(setResult.ok).toBe(false);
    if (setResult.ok) return;
    expect(setResult.error.code).toBe('secret_storage_unavailable');

    // The failure rolled back: no pointer was left behind, so the snapshot
    // still reports no token.
    const snapshotResult = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshotResult.ok) throw new Error('expected ok snapshot result');
    expect(snapshotResult.snapshot.agents[TEST_AGENT_ID]?.hasToken ?? false).toBe(false);
  });
});

describe('agent token change notification (onAgentTokenChanged)', () => {
  const CANARY_TOKEN = 'ghp_CANARY_TOKEN_7f3a91c4';

  it('notifies after a token is stored, so the runtime can recycle', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());
    const onAgentTokenChanged = vi.fn();

    const result = await setPassword(
      settingsDir,
      secretStore,
      { target: { kind: 'agent', agentId: TEST_AGENT_ID }, password: CANARY_TOKEN },
      TEST_AGENT_DEFINITIONS,
      onAgentTokenChanged,
    );

    expect(result).toEqual({ ok: true });
    expect(onAgentTokenChanged).toHaveBeenCalledTimes(1);
  });

  it('notifies after a token is cleared', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());
    await setPassword(
      settingsDir,
      secretStore,
      {
        target: { kind: 'agent', agentId: TEST_AGENT_ID },
        password: CANARY_TOKEN,
      },
      TEST_AGENT_DEFINITIONS,
    );
    const onAgentTokenChanged = vi.fn();

    const result = await clearPassword(
      settingsDir,
      secretStore,
      { target: { kind: 'agent', agentId: TEST_AGENT_ID } },
      TEST_AGENT_DEFINITIONS,
      onAgentTokenChanged,
    );

    expect(result).toEqual({ ok: true });
    expect(onAgentTokenChanged).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a proxy-library password - the runtime never consumes it', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, settingsWithProxy(PROXY_SECRET_REF));
    const onAgentTokenChanged = vi.fn();

    const result = await setPassword(
      settingsDir,
      secretStore,
      { target: { kind: 'proxy', proxyId: PROXY_ID }, password: CANARY_PASSWORD },
      TEST_AGENT_DEFINITIONS,
      onAgentTokenChanged,
    );

    expect(result).toEqual({ ok: true });
    expect(onAgentTokenChanged).not.toHaveBeenCalled();
  });

  it('does not notify when the token change fails', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(
      path.join(settingsDir, 'secrets'),
      createFakeCipher({ available: false }),
    );
    await writeSettings(settingsDir, defaultAppSettings());
    const onAgentTokenChanged = vi.fn();

    const result = await setPassword(
      settingsDir,
      secretStore,
      { target: { kind: 'agent', agentId: TEST_AGENT_ID }, password: CANARY_TOKEN },
      TEST_AGENT_DEFINITIONS,
      onAgentTokenChanged,
    );

    expect(result.ok).toBe(false);
    expect(onAgentTokenChanged).not.toHaveBeenCalled();
  });
});

describe('clearing a token switches off a provider whose only credential it was', () => {
  const CANARY_TOKEN = 'ghp_CANARY_TOKEN_7f3a91c4';
  const OPENROUTER = 'openrouter' as AgentId;
  const TOKEN_ONLY_DEFINITIONS: readonly AgentDefinition[] = [
    ...TEST_AGENT_DEFINITIONS,
    { id: OPENROUTER, label: 'OpenRouter', requiresAuth: true, supportsInteractiveLogin: false },
  ];

  /** An active agent node whose token reference points at a real stored secret. */
  async function activeAgentWithToken(
    agentId: AgentId,
  ): Promise<{ settingsDir: string; secretStore: ReturnType<typeof createSecretStore> }> {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    const secretRef = `agent-token:${agentId}`;
    await writeSettings(settingsDir, {
      ...defaultAppSettings(),
      agents: { [agentId]: { active: true, token: { secretRef } } },
    });
    await secretStore.set(secretRef, CANARY_TOKEN);
    return { settingsDir, secretStore };
  }

  async function activeFlagOf(
    settingsDir: string,
    secretStore: ReturnType<typeof createSecretStore>,
    agentId: AgentId,
  ): Promise<boolean | undefined> {
    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected an ok snapshot result');
    return snapshot.snapshot.agents[agentId]?.active;
  }

  it('switches off an active token-only provider and deletes the secret', async () => {
    const { settingsDir, secretStore } = await activeAgentWithToken(OPENROUTER);

    const result = await clearPassword(
      settingsDir,
      secretStore,
      { target: { kind: 'agent', agentId: OPENROUTER } },
      TOKEN_ONLY_DEFINITIONS,
      undefined,
      // A token-only provider never has an SSO session; even a true presence
      // must not keep it active.
      () => Promise.resolve(true),
    );

    expect(result).toEqual({ ok: true });
    await expect(secretStore.get(`agent-token:${OPENROUTER}`)).resolves.toBeUndefined();
    expect(await activeFlagOf(settingsDir, secretStore, OPENROUTER)).toBe(false);
  });

  it('keeps an active interactive provider when an SSO session outlives the token', async () => {
    const { settingsDir, secretStore } = await activeAgentWithToken(TEST_AGENT_ID);

    await clearPassword(
      settingsDir,
      secretStore,
      { target: { kind: 'agent', agentId: TEST_AGENT_ID } },
      TEST_AGENT_DEFINITIONS,
      undefined,
      () => Promise.resolve(true),
    );

    expect(await activeFlagOf(settingsDir, secretStore, TEST_AGENT_ID)).toBe(true);
  });

  it('switches off an active interactive provider when no SSO session remains', async () => {
    const { settingsDir, secretStore } = await activeAgentWithToken(TEST_AGENT_ID);

    await clearPassword(
      settingsDir,
      secretStore,
      { target: { kind: 'agent', agentId: TEST_AGENT_ID } },
      TEST_AGENT_DEFINITIONS,
      undefined,
      () => Promise.resolve(false),
    );

    expect(await activeFlagOf(settingsDir, secretStore, TEST_AGENT_ID)).toBe(false);
  });

  it('leaves an inactive provider inactive (and does not need a presence read)', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    const secretRef = `agent-token:${OPENROUTER}`;
    await writeSettings(settingsDir, {
      ...defaultAppSettings(),
      agents: { [OPENROUTER]: { active: false, token: { secretRef } } },
    });
    await secretStore.set(secretRef, CANARY_TOKEN);

    const result = await clearPassword(
      settingsDir,
      secretStore,
      { target: { kind: 'agent', agentId: OPENROUTER } },
      TOKEN_ONLY_DEFINITIONS,
    );

    expect(result).toEqual({ ok: true });
    expect(await activeFlagOf(settingsDir, secretStore, OPENROUTER)).toBe(false);
  });
});

describe('project library ipc', () => {
  const PROJECT_ID = newProjectId(() => 'project-a');
  const OTHER_PROJECT_ID = newProjectId(() => 'project-b');

  function serverWithProject(): ServerConfig {
    return serverConfigSchema.parse({
      id: SERVER_ID,
      label: 'A',
      origin: 'https://a.example',
      color: { kind: 'swatch', swatch: 'blue' },
      projectId: PROJECT_ID,
      revision: 0,
    });
  }

  it('addProject persists an entry and returns its snapshot', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, defaultAppSettings());

    const result = await addProject(settingsDir, {
      label: 'HPE',
      contentRoots: '/content/a; /content/b',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an ok result');
    expect(result.project.label).toBe('HPE');
    expect(result.project.contentRoots).toBe('/content/a; /content/b');

    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected ok snapshot result');
    expect(snapshot.snapshot.projects).toHaveLength(1);
  });

  it('addServer persists a captured projectId and returns it in the server snapshot', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, {
      ...defaultAppSettings(),
      projects: [projectConfigSchema.parse({ id: PROJECT_ID, label: 'HPE' })],
    });

    const result = await addServer(settingsDir, secretStore, {
      label: 'HPE Dev',
      origin: 'https://dev.example',
      color: { kind: 'swatch', swatch: 'blue' },
      projectId: PROJECT_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an ok result');
    expect(result.server.projectId).toBe(PROJECT_ID);
  });

  it('updateServerPresentation sets and clears a projectId', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, {
      ...defaultAppSettings(),
      hosts: [
        serverConfigSchema.parse({
          id: SERVER_ID,
          label: 'A',
          origin: 'https://a.example',
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        }),
      ],
      projects: [projectConfigSchema.parse({ id: PROJECT_ID, label: 'HPE' })],
    });

    const set = await updateServerPresentation(settingsDir, secretStore, {
      serverId: SERVER_ID,
      changes: { projectId: PROJECT_ID },
    });
    expect(set.ok).toBe(true);
    if (!set.ok) throw new Error('expected an ok result');
    expect(set.server.projectId).toBe(PROJECT_ID);

    const cleared = await updateServerPresentation(settingsDir, secretStore, {
      serverId: SERVER_ID,
      changes: { projectId: null },
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error('expected an ok result');
    expect(cleared.server.projectId).toBeUndefined();
  });

  it('removeProject clears the reference from every host in the same write', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, {
      ...defaultAppSettings(),
      hosts: [serverWithProject()],
      projects: [projectConfigSchema.parse({ id: PROJECT_ID, label: 'HPE' })],
    });

    const result = await removeProject(settingsDir, { projectId: PROJECT_ID });
    expect(result).toEqual({ ok: true });

    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected ok snapshot result');
    expect(snapshot.snapshot.projects).toEqual([]);
    expect(snapshot.snapshot.hosts[0]?.projectId).toBeUndefined();
  });

  it('updateProject replaces the entry and reports project_not_found for an unknown id', async () => {
    const settingsDir = createScratchRoot();
    await writeSettings(settingsDir, {
      ...defaultAppSettings(),
      projects: [
        projectConfigSchema.parse({ id: PROJECT_ID, label: 'HPE', contentRoots: '/content/a' }),
      ],
    });

    const updated = await updateProject(settingsDir, { projectId: PROJECT_ID, label: 'HPE Dev' });
    expect(updated.ok).toBe(true);

    const missing = await updateProject(settingsDir, {
      projectId: newProjectId(() => 'project-ghost'),
      label: 'X',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('project_not_found');
  });

  it('reorderProjects persists the requested order', async () => {
    const settingsDir = createScratchRoot();
    const secretStore = createSecretStore(path.join(settingsDir, 'secrets'), createFakeCipher());
    await writeSettings(settingsDir, {
      ...defaultAppSettings(),
      projects: [
        projectConfigSchema.parse({ id: PROJECT_ID, label: 'A' }),
        projectConfigSchema.parse({ id: OTHER_PROJECT_ID, label: 'B' }),
      ],
    });

    const result = await reorderProjects(settingsDir, {
      projectIds: [OTHER_PROJECT_ID, PROJECT_ID],
    });
    expect(result).toEqual({ ok: true });

    const snapshot = await getSettingsSnapshot(settingsDir, secretStore);
    if (!snapshot.ok) throw new Error('expected ok snapshot result');
    expect(snapshot.snapshot.projects.map((project) => project.id)).toEqual([
      OTHER_PROJECT_ID,
      PROJECT_ID,
    ]);
  });
});
