import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_SETTINGS_SCHEMA_VERSION,
  appSettingsSchema,
  defaultAppSettings,
  type AppSettings,
} from '../../../src/shared/contracts/appSettings';
import { newServerId } from '../../../src/shared/contracts/ids';
import { serverConfigSchema, type ServerConfig } from '../../../src/shared/contracts/serverConfig';
import {
  addServer,
  applyServerPresentationChange,
  applyServerTargetingChange,
  confirmOriginChange,
  COPILOT_PROXY_SECRET_REF,
  loadSettings,
  migrateSettingsData,
  removeServer,
  saveSettings,
  settingsFilePath,
  updateCopilotProxy,
  updateModelPreferences,
  type SchemaMigration,
} from '../../../src/main/settingsStore';

/**
 * Scratch directories live under the project's own `test-results/` (already
 * gitignored), never an OS temp directory - matching
 * tests/unit/main/secretStore.test.ts and tests/unit/main/appPaths.test.ts.
 */
const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'main-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'settingsStore-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeServer(
  id: string,
  origin: string,
  overrides: Partial<Record<string, unknown>> = {},
): ServerConfig {
  return serverConfigSchema.parse({
    id: newServerId(() => id),
    label: `Server ${id}`,
    origin,
    color: { kind: 'swatch', swatch: 'blue' },
    revision: 0,
    ...overrides,
  });
}

function makeSettings(servers: ServerConfig[], activeServerId: string | null = null): AppSettings {
  return appSettingsSchema.parse({
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    servers,
    activeServerId,
    defaultModel: null,
    defaultReasoningEffort: null,
  });
}

function listDirEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

describe('saveSettings / loadSettings round trip', () => {
  it('preserves every field across a save then load', async () => {
    const dir = createScratchRoot();
    const server = makeServer('server-a', 'https://a.example', {
      proxy: {
        url: 'https://proxy.example:8080',
        credentials: { username: 'alice', secretRef: 'vault://server-a/proxy' },
      },
      tlsException: {
        origin: 'https://a.example',
        certificateSha256Fingerprint: 'a'.repeat(64),
        errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
      },
    });
    const settings = makeSettings([server], server.id);
    const withCopilotProxy = appSettingsSchema.parse({
      ...settings,
      servers: settings.servers,
      copilotProxy: {
        url: 'https://copilot-proxy.example:3128',
        credentials: { username: 'bob', secretRef: 'vault://copilot/bob' },
      },
      defaultModel: 'gpt-5',
      defaultReasoningEffort: 'high',
    });

    const saveResult = await saveSettings(dir, withCopilotProxy);
    expect(saveResult.ok).toBe(true);

    const loadResult = await loadSettings(dir);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.status).toBe('loaded');
      expect(loadResult.value.settings).toEqual(withCopilotProxy);
    }
  });
});

describe('loadSettings: first run', () => {
  it('yields defaults, distinguished from corruption, when no file exists', async () => {
    const dir = createScratchRoot();

    const result = await loadSettings(dir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('defaults');
      expect(result.value.settings).toEqual(defaultAppSettings());
    }
  });
});

describe('loadSettings: corruption handling', () => {
  it('reports an explicit error for unparseable JSON and leaves the file untouched', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    const filePath = settingsFilePath(dir);
    const damagedContent = '{ this is not valid JSON ';
    writeFileSync(filePath, damagedContent, 'utf8');

    const result = await loadSettings(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unparseable');
    }
    expect(readFileSync(filePath, 'utf8')).toBe(damagedContent);
  });

  it('reports an explicit error for schema-invalid JSON', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      settingsFilePath(dir),
      JSON.stringify({ schemaVersion: APP_SETTINGS_SCHEMA_VERSION, servers: 'not an array' }),
      'utf8',
    );

    const result = await loadSettings(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('schema_invalid');
    }
  });

  it('fails closed - never silently trusted - for a legacy tlsException persisted before errorClass was required', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    const server = {
      id: newServerId(() => 'server-a'),
      label: 'Production',
      origin: 'https://a.example',
      color: { kind: 'swatch', swatch: 'blue' },
      revision: 0,
      // This is the pre-errorClass shape: a real file written before this
      // field existed would look exactly like this, with no errorClass at
      // all rather than an empty or null one.
      tlsException: {
        origin: 'https://a.example',
        certificateSha256Fingerprint: 'a'.repeat(64),
      },
    };
    writeFileSync(
      settingsFilePath(dir),
      JSON.stringify({
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
        servers: [server],
        activeServerId: server.id,
        defaultModel: null,
        defaultReasoningEffort: null,
      }),
      'utf8',
    );

    const result = await loadSettings(dir);

    // The one genuinely dangerous outcome would be this failing entry being
    // dropped while the rest of the document (and, worse, some trace of the
    // exception itself) still loaded as if it were approved. There is no
    // per-entry recovery anywhere in this module (`parseAppSettings`
    // validates the whole document at once via `.safeParse`), so the actual
    // behaviour is blunter but safe: the entire load fails, and `result.ok`
    // being `false` means there is no `result.value.settings` at all for a
    // caller to (mis)read a certificate exception out of.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('schema_invalid');
      expect(result.error.message).toContain('errorClass');
    }
  });

  it('reports an explicit error, rather than defaults, for a version newer than this build understands', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      settingsFilePath(dir),
      JSON.stringify({
        schemaVersion: APP_SETTINGS_SCHEMA_VERSION + 1,
        servers: [],
        activeServerId: null,
        defaultModel: null,
        defaultReasoningEffort: null,
      }),
      'utf8',
    );

    const result = await loadSettings(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('version_too_new');
    }
  });

  it("reports an explicit 'unreadable' error, not defaults, when the file cannot be read", async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsFilePath(dir), JSON.stringify(defaultAppSettings()), 'utf8');

    vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('simulated permission error'), { code: 'EACCES' }),
    );

    const result = await loadSettings(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unreadable');
    }
  });

  it('never returns defaultAppSettings() as if a damaged file were absent', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsFilePath(dir), 'not json at all', 'utf8');

    const result = await loadSettings(dir);

    // The failure must be visible as an error, never silently coerced into
    // an ok result carrying defaults.
    expect(result.ok).toBe(false);
  });
});

describe('loadSettings: migrations', () => {
  it('migrates an older version explicitly and produces a valid current-version document', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });

    // A hypothetical schema version 0 that stored `servers` under the name
    // `entries` instead of `servers`. This version never really existed
    // (there is no real version 0 - see SETTINGS_MIGRATIONS's doc comment),
    // but it proves the chaining mechanism a real "1 -> 2" migration would
    // rely on.
    const legacyDocument = {
      schemaVersion: 0,
      entries: [],
      activeServerId: null,
      defaultModel: null,
      defaultReasoningEffort: null,
    };
    writeFileSync(settingsFilePath(dir), JSON.stringify(legacyDocument), 'utf8');

    const fakeMigration: SchemaMigration = {
      fromVersion: 0,
      toVersion: APP_SETTINGS_SCHEMA_VERSION,
      migrate: (data) => {
        const { entries, ...rest } = data;
        return {
          ...rest,
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
          servers: entries ?? [],
        };
      },
    };

    const result = await loadSettings(dir, { migrations: [fakeMigration] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('migrated');
      expect(result.value.fromVersion).toBe(0);
      expect(result.value.settings.schemaVersion).toBe(APP_SETTINGS_SCHEMA_VERSION);
      expect(() => appSettingsSchema.parse(result.value.settings)).not.toThrow();
    }
  });

  it('chains multiple migration hops in one load', () => {
    const migrations: SchemaMigration[] = [
      { fromVersion: 0, toVersion: 1, migrate: (data) => ({ ...data, schemaVersion: 1, hop: 1 }) },
    ];

    const result = migrateSettingsData({ schemaVersion: 0 }, 0, migrations);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hop).toBe(1);
      expect(result.value.schemaVersion).toBe(1);
    }
  });

  it('reports an explicit error when no migration path exists for an older version', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      settingsFilePath(dir),
      JSON.stringify({ schemaVersion: 0, servers: [], activeServerId: null }),
      'utf8',
    );

    const result = await loadSettings(dir, { migrations: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('schema_invalid');
    }
  });
});

describe('saveSettings: atomic writes and failures', () => {
  it('leaves no partial or temp file behind after a successful write', async () => {
    const dir = createScratchRoot();

    const result = await saveSettings(dir, defaultAppSettings());

    expect(result.ok).toBe(true);
    const entries = listDirEntries(dir);
    expect(entries).toEqual([path.basename(settingsFilePath(dir))]);
  });

  it('does not destroy the previous good file when the rename step fails mid-write', async () => {
    const dir = createScratchRoot();
    const server = makeServer('server-a', 'https://a.example');
    const goodSettings = makeSettings([server], server.id);
    const firstSave = await saveSettings(dir, goodSettings);
    expect(firstSave.ok).toBe(true);

    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('simulated disk failure'));

    const badSettings = makeSettings([makeServer('server-b', 'https://b.example')]);
    const secondSave = await saveSettings(dir, badSettings);

    expect(secondSave.ok).toBe(false);

    // The previous good file must still be exactly what it was.
    const reload = await loadSettings(dir);
    expect(reload.ok).toBe(true);
    if (reload.ok) {
      expect(reload.value.settings).toEqual(goodSettings);
    }
    // And no stray temp file should linger forever in the directory.
    const entries = listDirEntries(dir);
    expect(entries).toEqual([path.basename(settingsFilePath(dir))]);
  });

  it('surfaces an explicit error, rather than a silent no-op, when the write fails', async () => {
    const dir = createScratchRoot();
    // Occupy the settings directory's path with a plain file, so creating
    // the directory (and thus writing into it) fails.
    const blockerPath = path.join(dir, 'blocked-settings-dir');
    writeFileSync(blockerPath, 'occupied', 'utf8');

    const result = await saveSettings(blockerPath, defaultAppSettings());

    expect(result.ok).toBe(false);
  });
});

describe('applyServerPresentationChange', () => {
  it('updates label/colour without changing the revision', () => {
    const server = makeServer('server-a', 'https://a.example', { revision: 3 });
    const settings = makeSettings([server], server.id);

    const result = applyServerPresentationChange(settings, server.id, {
      label: 'Renamed',
      color: { kind: 'swatch', swatch: 'purple' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('presentation');
      expect(result.value.server.label).toBe('Renamed');
      expect(result.value.server.revision).toBe(3);
      expect(result.value.server.origin).toBe('https://a.example');
    }
  });

  it('fails for an unknown server id', () => {
    const settings = makeSettings([]);
    const result = applyServerPresentationChange(
      settings,
      newServerId(() => 'ghost'),
      { label: 'X' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('server_not_found');
    }
  });
});

describe('applyServerTargetingChange: origin changes', () => {
  it('rejects an origin change with no confirmation, and nothing is persisted', async () => {
    const dir = createScratchRoot();
    const server = makeServer('server-a', 'https://a.example');
    const settings = makeSettings([server], server.id);
    const saveResult = await saveSettings(dir, settings);
    expect(saveResult.ok).toBe(true);

    const mutation = applyServerTargetingChange(settings, server.id, {
      origin: 'https://b.example',
    });

    expect(mutation.ok).toBe(false);
    if (!mutation.ok) {
      expect(mutation.error.kind).toBe('origin_change_requires_confirmation');
    }

    const reload = await loadSettings(dir);
    expect(reload.ok).toBe(true);
    if (reload.ok) {
      expect(reload.value.settings.servers[0]?.origin).toBe('https://a.example');
      expect(reload.value.settings.servers[0]?.revision).toBe(0);
    }
  });

  it('rejects an origin change whose confirmation names a different origin', () => {
    const server = makeServer('server-a', 'https://a.example');
    const settings = makeSettings([server], server.id);

    const mutation = applyServerTargetingChange(
      settings,
      server.id,
      { origin: 'https://b.example' },
      confirmOriginChange('https://not-the-target.example'),
    );

    expect(mutation.ok).toBe(false);
    if (!mutation.ok) {
      expect(mutation.error.kind).toBe('origin_change_requires_confirmation');
    }
  });

  it('with confirmation, increments the revision, keeps the server id, and does not carry over the old TLS exception', () => {
    const server = makeServer('server-a', 'https://a.example', {
      revision: 5,
      tlsException: {
        origin: 'https://a.example',
        certificateSha256Fingerprint: 'b'.repeat(64),
        errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
      },
    });
    const settings = makeSettings([server], server.id);

    const mutation = applyServerTargetingChange(
      settings,
      server.id,
      { origin: 'https://b.example' },
      confirmOriginChange('https://b.example'),
    );

    expect(mutation.ok).toBe(true);
    if (mutation.ok) {
      expect(mutation.value.kind).toBe('origin_changed');
      expect(mutation.value.server.id).toBe(server.id);
      expect(mutation.value.server.origin).toBe('https://b.example');
      expect(mutation.value.server.revision).toBe(6);
      expect(mutation.value.server.tlsException).toBeUndefined();
    }
  });

  it("rejects an origin change that collides with another configured server's origin", () => {
    const serverA = makeServer('server-a', 'https://a.example');
    const serverB = makeServer('server-b', 'https://b.example');
    const settings = makeSettings([serverA, serverB], serverA.id);

    const mutation = applyServerTargetingChange(
      settings,
      serverA.id,
      { origin: 'https://b.example' },
      confirmOriginChange('https://b.example'),
    );

    expect(mutation.ok).toBe(false);
    if (!mutation.ok) {
      expect(mutation.error.kind).toBe('invalid_change');
    }
  });
});

describe('applyServerTargetingChange: proxy changes', () => {
  it('reports that a safe transition is required for a proxy change on the active server', () => {
    const server = makeServer('server-a', 'https://a.example');
    const settings = makeSettings([server], server.id);

    const mutation = applyServerTargetingChange(settings, server.id, {
      proxy: {
        url: 'https://proxy.example:8080',
        credentials: { username: 'alice', secretRef: 'vault://server-a/proxy' },
      },
    });

    expect(mutation.ok).toBe(true);
    if (mutation.ok) {
      expect(mutation.value.kind).toBe('requires_safe_transition');
      expect(mutation.value.server.origin).toBe('https://a.example');
      expect(mutation.value.server.revision).toBe(1);
    }
  });
});

describe('addServer', () => {
  it('creates a new server at revision 0 with no proxy/TLS exception', () => {
    const settings = makeSettings([]);

    const result = addServer(
      settings,
      newServerId(() => 'server-new'),
      {
        label: 'New server',
        origin: 'https://new.example',
        color: { kind: 'swatch', swatch: 'blue' },
        allowInsecureHttp: false,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.server.label).toBe('New server');
      expect(result.value.server.origin).toBe('https://new.example');
      expect(result.value.server.revision).toBe(0);
      expect(result.value.server.proxy).toBeUndefined();
      expect(result.value.server.tlsException).toBeUndefined();
      expect(result.value.settings.servers).toHaveLength(1);
    }
  });

  it('rejects a plain-HTTP origin when allowInsecureHttp is not set', () => {
    const settings = makeSettings([]);

    const result = addServer(
      settings,
      newServerId(() => 'server-new'),
      {
        label: 'New server',
        origin: 'http://new.example',
        color: { kind: 'swatch', swatch: 'blue' },
        allowInsecureHttp: false,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('insecure_http_not_confirmed');
    }
  });

  it('accepts a plain-HTTP origin when allowInsecureHttp is explicitly set', () => {
    const settings = makeSettings([]);

    const result = addServer(
      settings,
      newServerId(() => 'server-new'),
      {
        label: 'New server',
        origin: 'http://new.example',
        color: { kind: 'swatch', swatch: 'blue' },
        allowInsecureHttp: true,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.server.origin).toBe('http://new.example');
    }
  });

  it('rejects an origin that already belongs to a configured server', () => {
    const existing = makeServer('server-a', 'https://a.example');
    const settings = makeSettings([existing]);

    const result = addServer(
      settings,
      newServerId(() => 'server-new'),
      {
        label: 'Duplicate',
        origin: 'https://a.example',
        color: { kind: 'swatch', swatch: 'blue' },
        allowInsecureHttp: false,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('duplicate_origin');
    }
  });
});

describe('removeServer', () => {
  it('removes the server entry', () => {
    const server = makeServer('server-a', 'https://a.example');
    const other = makeServer('server-b', 'https://b.example');
    const settings = makeSettings([server, other], other.id);

    const result = removeServer(settings, server.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.servers.map((s) => s.id)).toEqual([other.id]);
      expect(result.value.wasActive).toBe(false);
      expect(result.value.settings.activeServerId).toBe(other.id);
    }
  });

  it('fails for an unknown server id', () => {
    const settings = makeSettings([]);

    const result = removeServer(
      settings,
      newServerId(() => 'ghost'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('server_not_found');
    }
  });

  it('clears activeServerId (rather than leaving a dangling reference) when the removed server was active', () => {
    const server = makeServer('server-a', 'https://a.example');
    const settings = makeSettings([server], server.id);

    const result = removeServer(settings, server.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.wasActive).toBe(true);
      expect(result.value.settings.activeServerId).toBeNull();
      expect(result.value.settings.servers).toHaveLength(0);
      // The resulting document must itself still validate - the whole
      // reason activeServerId is cleared rather than left dangling.
      expect(() => appSettingsSchema.parse(result.value.settings)).not.toThrow();
    }
  });
});

describe('updateCopilotProxy', () => {
  it('sets a brand new proxy with a username, minting COPILOT_PROXY_SECRET_REF', () => {
    const settings = defaultAppSettings();

    const result = updateCopilotProxy(settings, {
      url: 'https://proxy.example:8080',
      username: 'alice',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.copilotProxy).toEqual({
        url: 'https://proxy.example:8080',
        credentials: { username: 'alice', secretRef: COPILOT_PROXY_SECRET_REF },
      });
      expect(result.value.orphanedSecretRef).toBeUndefined();
    }
  });

  it('preserves the existing secretRef when only the username changes', () => {
    const settings: AppSettings = {
      ...defaultAppSettings(),
      copilotProxy: {
        url: 'https://proxy.example:8080',
        credentials: { username: 'alice', secretRef: 'existing-ref' },
      },
    };

    const result = updateCopilotProxy(settings, {
      url: 'https://proxy.example:8080',
      username: 'bob',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.copilotProxy?.credentials).toEqual({
        username: 'bob',
        secretRef: 'existing-ref',
      });
      expect(result.value.orphanedSecretRef).toBeUndefined();
    }
  });

  it('removes credentials and reports the orphaned secretRef when username is omitted', () => {
    const settings: AppSettings = {
      ...defaultAppSettings(),
      copilotProxy: {
        url: 'https://proxy.example:8080',
        credentials: { username: 'alice', secretRef: 'existing-ref' },
      },
    };

    const result = updateCopilotProxy(settings, { url: 'https://new-proxy.example:8080' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.copilotProxy).toEqual({ url: 'https://new-proxy.example:8080' });
      expect(result.value.orphanedSecretRef).toBe('existing-ref');
    }
  });

  it('does not report an orphaned secretRef when there were no prior credentials', () => {
    const result = updateCopilotProxy(defaultAppSettings(), { url: 'https://proxy.example:8080' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orphanedSecretRef).toBeUndefined();
    }
  });
});

describe('canary: plaintext secrets never reach settings', () => {
  const CANARY = 'CANARY-SECRET-d41d8cd98f00b204';

  it('proxyCredentialsSchema (via appSettingsSchema) rejects a password field carrying the canary', () => {
    const raw = {
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      servers: [],
      activeServerId: null,
      defaultModel: null,
      defaultReasoningEffort: null,
      copilotProxy: {
        url: 'https://proxy.example:8080',
        credentials: { username: 'alice', secretRef: 'vault://alice', password: CANARY },
      },
    };

    expect(() => appSettingsSchema.parse(raw)).toThrow();
  });

  it('loadSettings refuses a file carrying a smuggled password field instead of silently accepting it', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    const rawWithCanary = {
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      servers: [],
      activeServerId: null,
      defaultModel: null,
      defaultReasoningEffort: null,
      copilotProxy: {
        url: 'https://proxy.example:8080',
        credentials: { username: 'alice', secretRef: 'vault://alice', password: CANARY },
      },
    };
    writeFileSync(settingsFilePath(dir), JSON.stringify(rawWithCanary), 'utf8');

    const result = await loadSettings(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('schema_invalid');
      // The canary must not leak into the error message either.
      expect(result.error.message).not.toContain(CANARY);
    }
    // The damaged file is left exactly as it was - never "helpfully"
    // rewritten with the password stripped.
    expect(readFileSync(settingsFilePath(dir), 'utf8')).toBe(JSON.stringify(rawWithCanary));
  });

  it('a normal save/load round trip never writes a `password` key to disk', async () => {
    const dir = createScratchRoot();
    const server = makeServer('server-a', 'https://a.example', {
      proxy: {
        url: 'https://proxy.example:8080',
        credentials: { username: 'alice', secretRef: 'vault://server-a/proxy' },
      },
    });
    const settings = makeSettings([server], server.id);

    await saveSettings(dir, settings);

    const onDisk = readFileSync(settingsFilePath(dir), 'utf8');
    expect(onDisk).not.toContain('password');
    expect(onDisk).not.toContain(CANARY);
  });
});

describe('updateModelPreferences', () => {
  it('stores a model and its reasoning effort', () => {
    const result = updateModelPreferences(defaultAppSettings(), {
      model: 'model-a',
      reasoningEffort: 'high',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultModel).toBe('model-a');
    expect(result.value.defaultReasoningEffort).toBe('high');
  });

  it('forces the reasoning effort to null when the model is cleared', () => {
    // Defence in depth. `setModelPreferencesRequestSchema` already refuses an
    // effort without a model, so this combination cannot arrive over IPC - but
    // an orphaned effort persisted here would be re-applied against whatever
    // model Copilot picks next, which is precisely a silently-changed setting.
    const result = updateModelPreferences(defaultAppSettings(), {
      model: null,
      reasoningEffort: 'high',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultModel).toBeNull();
    expect(result.value.defaultReasoningEffort).toBeNull();
  });

  it('clears a previously stored effort when the model is cleared', () => {
    const withBoth = updateModelPreferences(defaultAppSettings(), {
      model: 'model-a',
      reasoningEffort: 'high',
    });
    expect(withBoth.ok).toBe(true);
    if (!withBoth.ok) return;

    const cleared = updateModelPreferences(withBoth.value, {
      model: null,
      reasoningEffort: null,
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.defaultReasoningEffort).toBeNull();
  });

  it('leaves every other setting untouched', () => {
    const before = defaultAppSettings();
    const result = updateModelPreferences(before, { model: 'model-a', reasoningEffort: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.servers).toEqual(before.servers);
    expect(result.value.copilotProxy).toEqual(before.copilotProxy);
  });

  it('rejects a model id the settings contract will not accept', () => {
    const result = updateModelPreferences(defaultAppSettings(), {
      model: 'x'.repeat(5000),
      reasoningEffort: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_change');
  });
});
