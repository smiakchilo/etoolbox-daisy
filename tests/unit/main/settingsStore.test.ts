import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addProxy,
  addServer,
  agentTokenSecretRef,
  applyBrowserSettingsChange,
  applyServerPresentationChange,
  applyServerTargetingChange,
  confirmOriginChange,
  configuredAgentId,
  loadSettings,
  loadSettingsSync,
  normalizeSettingsDocument,
  proxySecretRef,
  removeProxy,
  removeServer,
  repairProxyEntries,
  reorderProxies,
  reorderServers,
  saveSettings,
  settingsFilePath,
  updateAgentToken,
  updateModelPreferences,
  updateProxy,
} from '../../../src/main/settingsStore';
import {
  type AgentId,
  type AppSettings,
  type ServerConfig,
  appSettingsSchema,
  defaultAppSettings,
  HOST_PROXY_NONE,
  newProxyId,
  newServerId,
  proxyConfigSchema,
  serverConfigSchema,
} from '../../../src/shared';
import { TEST_AGENT_DEFINITIONS, TEST_AGENT_ID } from '../../support/agentDefinitions';

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

function makeSettings(hosts: ServerConfig[], proxies: readonly unknown[] = []): AppSettings {
  return appSettingsSchema.parse({
    hosts,
    proxies,
    agents: { [TEST_AGENT_ID]: { active: true } },
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
    const proxyEntry = {
      id: newProxyId(() => 'proxy-a'),
      label: 'Corporate',
      url: 'https://copilot-proxy.example:3128',
      credentials: { username: 'bob', secretRef: 'vault://proxy/bob' },
    };
    const server = makeServer('server-a', 'https://a.example', {
      proxyId: proxyEntry.id,
      tlsException: {
        origin: 'https://a.example',
        certificateSha256Fingerprint: 'a'.repeat(64),
        errorClass: 'net::ERR_CERT_AUTHORITY_INVALID',
      },
    });
    const withProxy = appSettingsSchema.parse({
      hosts: [server],
      proxies: [proxyEntry],
      browser: { disableNativeWebAuthn: true, proxy: proxyEntry.id },
      agents: {
        [TEST_AGENT_ID]: { active: true, model: 'gpt-5', reasoningEffort: 'high' },
      },
    });

    const saveResult = await saveSettings(dir, withProxy);
    expect(saveResult.ok).toBe(true);

    const loadResult = await loadSettings(dir);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.status).toBe('loaded');
      expect(loadResult.value.settings).toEqual(withProxy);
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

describe('loadSettings: tolerant agent node', () => {
  it('loads a document whose agent node omits active, defaulting it to false and falling back to the default agent', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      settingsFilePath(dir),
      JSON.stringify({
        hosts: [],
        proxies: [],
        agents: { [TEST_AGENT_ID]: { model: 'gpt-5' } },
      }),
      'utf8',
    );

    const result = await loadSettings(dir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('loaded');
      expect(result.value.settings.agents[TEST_AGENT_ID]?.active).toBe(false);
      expect(result.value.settings.agents[TEST_AGENT_ID]?.model).toBe('gpt-5');
      // "No stored node is active" is well-defined: the default provider.
      expect(configuredAgentId(result.value.settings, TEST_AGENT_DEFINITIONS)).toBe(TEST_AGENT_ID);
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

  it('coerces a wrong-shaped hosts value to an empty list instead of failing the load', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsFilePath(dir), JSON.stringify({ hosts: 'not an array' }), 'utf8');

    const result = await loadSettings(dir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('loaded');
      expect(result.value.settings.hosts).toEqual([]);
    }
  });

  it('drops a legacy tlsException missing errorClass and loads the host, failing closed', async () => {
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
        hosts: [server],
        proxies: [],
        agents: { [TEST_AGENT_ID]: { active: true } },
      }),
      'utf8',
    );

    const result = await loadSettings(dir);

    // The unapprovable exception is discarded, never silently trusted: the
    // host loads with no exception at all, so the next navigation to it raises
    // a fresh decision. That is the "fail closed" direction - nothing in
    // `result.value.settings` claims a certificate was approved.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.hosts).toHaveLength(1);
      expect(result.value.settings.hosts[0]?.tlsException).toBeUndefined();
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

describe('loadSettings: repairs a legacy-shaped proxy entry instead of failing', () => {
  it('loads a file whose proxy entry carries url/credentials but no id/label', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    // The exact shape a hand-edit of the old single `copilotProxy` node
    // produces: the address and credentials survive, the newer identity
    // fields do not.
    const onDisk = JSON.stringify({
      hosts: [],
      proxies: [
        {
          url: 'http://109.207.79.171:3128',
          credentials: { username: 'proxyuser', secretRef: 'copilotProxy' },
        },
      ],
      agents: { [TEST_AGENT_ID]: { active: true } },
    });
    writeFileSync(settingsFilePath(dir), onDisk, 'utf8');

    const result = await loadSettings(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('loaded');
    const proxy = result.value.settings.proxies[0];
    expect(proxy?.label).toBe('http://109.207.79.171:3128');
    expect(proxy?.id).toMatch(/^repaired-[0-9a-f]{32}$/);
    expect(proxy?.credentials).toEqual({ username: 'proxyuser', secretRef: 'copilotProxy' });
    // The file on disk is not rewritten by the read.
    expect(readFileSync(settingsFilePath(dir), 'utf8')).toBe(onDisk);
  });
});

describe('normalizeSettingsDocument', () => {
  function normalize(raw: unknown): Record<string, unknown> {
    return normalizeSettingsDocument(raw) as Record<string, unknown>;
  }

  it('defaults missing hosts, proxies and agents', () => {
    const normalized = normalize({});

    expect(normalized['hosts']).toEqual([]);
    expect(normalized['proxies']).toEqual([]);
    expect(normalized['agents']).toEqual({});
  });

  it('keeps a boolean browser flag and drops an unrecognised or non-boolean one', () => {
    expect(
      normalize({ browser: { disableNativeWebAuthn: false, extra: 'gone' } })['browser'],
    ).toEqual({ disableNativeWebAuthn: false });
    // The schema restores the default afterwards, so a bad value cannot fail
    // the whole load.
    expect(normalize({ browser: { disableNativeWebAuthn: 'yes' } })['browser']).toEqual({});
    expect(normalize({})['browser']).toEqual({});
  });

  it('keeps a browser default proxy that names a configured entry and drops a dangling one', () => {
    const base = {
      hosts: [],
      proxies: [{ id: 'proxy-a', label: 'Corporate', url: 'https://proxy.example' }],
    };
    expect(normalize({ ...base, browser: { proxy: 'proxy-a' } })['browser']).toEqual({
      proxy: 'proxy-a',
    });
    expect(normalize({ ...base, browser: { proxy: 'proxy-ghost' } })['browser']).toEqual({});
    // The "No proxy" sentinel is a host-only value; as a default it means
    // "no default", i.e. it is dropped.
    expect(normalize({ ...base, browser: { proxy: HOST_PROXY_NONE } })['browser']).toEqual({});
  });

  it('keeps a host\'s "No proxy" sentinel, resolves a real reference, and treats a falsy or dangling value as "(Default)"', () => {
    const base = {
      hosts: [
        { id: 'server-a', origin: 'https://a.example', proxyId: HOST_PROXY_NONE },
        { id: 'server-b', origin: 'https://b.example', proxyId: 'proxy-a' },
        { id: 'server-c', origin: 'https://c.example', proxyId: null },
        { id: 'server-d', origin: 'https://d.example', proxyId: 'proxy-ghost' },
      ],
      proxies: [{ id: 'proxy-a', label: 'Corporate', url: 'https://proxy.example' }],
    };
    const hosts = normalize(base)['hosts'] as Record<string, unknown>[];
    expect(hosts[0]?.['proxyId']).toBe(HOST_PROXY_NONE);
    expect(hosts[1]?.['proxyId']).toBe('proxy-a');
    expect(hosts[2]?.['proxyId']).toBeUndefined();
    expect(hosts[3]?.['proxyId']).toBeUndefined();
  });

  it('strips unrecognised keys at every level but never inside credentials', () => {
    const normalized = normalize({
      extra: 'gone',
      hosts: [],
      proxies: [
        {
          id: 'proxy-a',
          label: 'Corporate',
          url: 'https://proxy.example',
          extra: 'gone',
          credentials: { username: 'u', secretRef: 's', password: 'hunter2' },
        },
      ],
      agents: { [TEST_AGENT_ID]: { active: true, extra: 'gone' } },
    });

    expect(normalized).not.toHaveProperty('extra');
    const proxy = (normalized['proxies'] as Record<string, unknown>[])[0];
    expect(proxy).not.toHaveProperty('extra');
    // The credentials object is copied through so the strict schema can still
    // reject the smuggled password.
    expect(proxy?.['credentials']).toEqual({
      username: 'u',
      secretRef: 's',
      password: 'hunter2',
    });
    const agent = (normalized['agents'] as Record<string, Record<string, unknown>>)[TEST_AGENT_ID];
    expect(agent).not.toHaveProperty('extra');
  });

  it('copies an agent token reference through so the strict schema still rejects a plaintext token', () => {
    const normalized = normalize({
      hosts: [],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true, token: { secretRef: 'agent-token:copilot' } } },
    });

    const agent = (normalized['agents'] as Record<string, Record<string, unknown>>)[TEST_AGENT_ID];
    expect(agent?.['token']).toEqual({ secretRef: 'agent-token:copilot' });
  });

  it('drops a host with no usable id or origin', () => {
    const normalized = normalize({
      hosts: [
        {
          id: 'server-a',
          origin: 'https://a.example',
          label: 'A',
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
        { id: 'server-b' },
        { origin: 'https://c.example' },
        { id: 'server-d', origin: 'not a url' },
      ],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true } },
    });

    const hosts = normalized['hosts'] as Record<string, unknown>[];
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.['id']).toBe('server-a');
  });

  it("fills a host's missing label, colour and revision", () => {
    const normalized = normalize({
      hosts: [{ id: 'server-a', origin: 'https://author.example:4502' }],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true } },
    });

    expect((normalized['hosts'] as Record<string, unknown>[])[0]).toMatchObject({
      id: 'server-a',
      origin: 'https://author.example:4502',
      label: 'author.example:4502',
      color: { kind: 'swatch', swatch: 'blue' },
      revision: 0,
    });
  });

  it('keeps and trims a host’s roots, and drops an empty one', () => {
    const normalized = normalize({
      hosts: [
        {
          id: 'server-a',
          origin: 'https://a.example',
          label: 'A',
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
          contentRoots: '  /content/a; /content/b  ',
          componentRoots: '   ',
        },
      ],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true } },
    });

    const host = (normalized['hosts'] as Record<string, unknown>[])[0];
    expect(host?.['contentRoots']).toBe('/content/a; /content/b');
    expect(host).not.toHaveProperty('componentRoots');
  });

  it('clears references that no longer resolve and an effort with no model', () => {
    const normalized = normalize({
      hosts: [
        {
          id: 'server-a',
          origin: 'https://a.example',
          label: 'A',
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
          proxyId: 'ghost',
        },
      ],
      proxies: [],
      agents: { [TEST_AGENT_ID]: { active: true, proxy: 'ghost', reasoningEffort: 'high' } },
    });

    expect((normalized['hosts'] as Record<string, unknown>[])[0]).not.toHaveProperty('proxyId');
    const agent = (normalized['agents'] as Record<string, Record<string, unknown>>)[TEST_AGENT_ID];
    expect(agent).not.toHaveProperty('proxy');
    expect(agent).not.toHaveProperty('reasoningEffort');
  });

  it('keeps only the first of a duplicated host and the first active agent', () => {
    const normalized = normalize({
      hosts: [
        {
          id: 'server-a',
          origin: 'https://a.example',
          label: 'A',
          color: { kind: 'swatch', swatch: 'blue' },
          revision: 0,
        },
        {
          id: 'server-a',
          origin: 'https://b.example',
          label: 'B',
          color: { kind: 'swatch', swatch: 'red' },
          revision: 0,
        },
      ],
      proxies: [],
      agents: {
        [TEST_AGENT_ID]: { active: true },
        opencode: { active: true },
      },
    });

    expect(normalized['hosts']).toHaveLength(1);
    const agents = normalized['agents'] as Record<string, Record<string, unknown>>;
    expect(agents[TEST_AGENT_ID]?.['active']).toBe(true);
    expect(agents['opencode']?.['active']).toBe(false);
  });
});

describe('applyBrowserSettingsChange', () => {
  it('replaces the flag when supplied and leaves it when omitted', () => {
    const disabled = applyBrowserSettingsChange(defaultAppSettings(), {
      disableNativeWebAuthn: false,
    });
    expect(disabled.browser.disableNativeWebAuthn).toBe(false);

    const unchanged = applyBrowserSettingsChange(disabled, {});
    expect(unchanged.browser.disableNativeWebAuthn).toBe(false);
  });

  it('sets and clears the default proxy', () => {
    const proxyEntry = proxyConfigSchema.parse({
      id: newProxyId(() => 'proxy-a'),
      label: 'Corporate',
      url: 'https://proxy.example:8080',
    });
    const settings = makeSettings([], [proxyEntry]);

    const set = applyBrowserSettingsChange(settings, { proxy: proxyEntry.id });
    expect(set.browser.proxy).toBe(proxyEntry.id);

    const cleared = applyBrowserSettingsChange(set, { proxy: null });
    expect(cleared.browser.proxy).toBeUndefined();

    // Omitted means unchanged.
    expect(applyBrowserSettingsChange(set, {}).browser.proxy).toBe(proxyEntry.id);
  });
});

describe('loadSettingsSync (startup-only read)', () => {
  it('returns defaults when the settings file does not exist', () => {
    expect(loadSettingsSync(createScratchRoot()).browser.disableNativeWebAuthn).toBe(true);
  });

  it('returns the persisted flag', async () => {
    const dir = createScratchRoot();
    const saved = await saveSettings(dir, {
      ...defaultAppSettings(),
      browser: { disableNativeWebAuthn: false },
    });
    expect(saved.ok).toBe(true);
    expect(loadSettingsSync(dir).browser.disableNativeWebAuthn).toBe(false);
  });

  it('returns defaults on a corrupt file rather than throwing', () => {
    const dir = createScratchRoot();
    writeFileSync(settingsFilePath(dir), '{ not json', 'utf8');
    expect(loadSettingsSync(dir).browser.disableNativeWebAuthn).toBe(true);
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
    const goodSettings = makeSettings([server]);
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
    const settings = makeSettings([server]);

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
    const settings = makeSettings([server]);
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
      expect(reload.value.settings.hosts[0]?.origin).toBe('https://a.example');
      expect(reload.value.settings.hosts[0]?.revision).toBe(0);
    }
  });

  it('rejects an origin change whose confirmation names a different origin', () => {
    const server = makeServer('server-a', 'https://a.example');
    const settings = makeSettings([server]);

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
    const settings = makeSettings([server]);

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
    const settings = makeSettings([serverA, serverB]);

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

describe('applyServerTargetingChange: proxy selection changes', () => {
  it('reports that a safe transition is required for a proxy selection change', () => {
    const proxyEntry = proxyConfigSchema.parse({
      id: newProxyId(() => 'proxy-1'),
      label: 'Corporate',
      url: 'https://proxy.example:8080',
    });
    const server = makeServer('server-a', 'https://a.example');
    const settings = makeSettings([server], [proxyEntry]);

    const mutation = applyServerTargetingChange(settings, server.id, {
      proxyId: proxyEntry.id,
    });

    expect(mutation.ok).toBe(true);
    if (mutation.ok) {
      expect(mutation.value.kind).toBe('requires_safe_transition');
      expect(mutation.value.server.proxyId).toBe(proxyEntry.id);
      expect(mutation.value.server.revision).toBe(1);
    }
  });

  it('stores the "No proxy" sentinel as an explicit override', () => {
    const server = makeServer('server-a', 'https://a.example');
    const settings = makeSettings([server]);

    const mutation = applyServerTargetingChange(settings, server.id, {
      proxyId: HOST_PROXY_NONE,
    });

    expect(mutation.ok).toBe(true);
    if (mutation.ok) {
      expect(mutation.value.server.proxyId).toBe(HOST_PROXY_NONE);
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
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.server.label).toBe('New server');
      expect(result.value.server.origin).toBe('https://new.example');
      expect(result.value.server.revision).toBe(0);
      expect(result.value.server.proxyId).toBeUndefined();
      expect(result.value.server.tlsException).toBeUndefined();
      expect(result.value.settings.hosts).toHaveLength(1);
    }
  });

  it('accepts a plain-HTTP origin - hosts are added at all schemes', () => {
    const settings = makeSettings([]);

    const result = addServer(
      settings,
      newServerId(() => 'server-new'),
      {
        label: 'New server',
        origin: 'http://new.example',
        color: { kind: 'swatch', swatch: 'blue' },
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
    const settings = makeSettings([server, other]);

    const result = removeServer(settings, server.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hosts.map((s) => s.id)).toEqual([other.id]);
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

  it('returns a document that still validates after removing a server', () => {
    const server = makeServer('server-a', 'https://a.example');
    const settings = makeSettings([server]);

    const result = removeServer(settings, server.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hosts).toHaveLength(0);
      expect(() => appSettingsSchema.parse(result.value)).not.toThrow();
    }
  });
});

describe('reorderServers', () => {
  it('reorders the servers to the given permutation without touching revisions', () => {
    const a = makeServer('server-a', 'https://a.example');
    const b = makeServer('server-b', 'https://b.example');
    const c = makeServer('server-c', 'https://c.example');
    const settings = makeSettings([a, b, c]);

    const result = reorderServers(settings, [c.id, a.id, b.id]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hosts.map((server) => server.id)).toEqual([c.id, a.id, b.id]);
      expect(result.value.hosts.map((server) => server.revision)).toEqual([0, 0, 0]);
    }
  });

  it('rejects an order that omits a configured server', () => {
    const a = makeServer('server-a', 'https://a.example');
    const b = makeServer('server-b', 'https://b.example');
    const settings = makeSettings([a, b]);

    const result = reorderServers(settings, [a.id]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_change');
  });

  it('rejects an order with a duplicate id', () => {
    const a = makeServer('server-a', 'https://a.example');
    const b = makeServer('server-b', 'https://b.example');
    const settings = makeSettings([a, b]);

    const result = reorderServers(settings, [a.id, a.id]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_change');
  });

  it('rejects an unknown id', () => {
    const a = makeServer('server-a', 'https://a.example');
    const settings = makeSettings([a]);

    const result = reorderServers(settings, [newServerId(() => 'ghost')]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_change');
  });

  it('accepts an empty order for a settings document with no servers', () => {
    const settings = makeSettings([]);

    const result = reorderServers(settings, []);

    expect(result.ok).toBe(true);
  });
});

describe('proxy library mutations', () => {
  const proxyId = newProxyId(() => 'proxy-a');

  it('addProxy appends an entry and mints a deterministic secretRef when a username is given', () => {
    const result = addProxy(defaultAppSettings(), proxyId, {
      label: 'Corporate',
      url: 'https://proxy.example:8080',
      username: 'alice',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.proxies).toEqual([
        {
          id: proxyId,
          label: 'Corporate',
          url: 'https://proxy.example:8080',
          credentials: { username: 'alice', secretRef: proxySecretRef(proxyId) },
        },
      ]);
      expect(result.value.proxy.id).toBe(proxyId);
    }
  });

  it('addProxy without a username creates no credentials', () => {
    const result = addProxy(defaultAppSettings(), proxyId, {
      label: 'Corporate',
      url: 'https://proxy.example:8080',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.proxies[0]?.credentials).toBeUndefined();
    }
  });

  it('updateProxy preserves the existing secretRef when only the username changes', () => {
    const settings: AppSettings = {
      ...defaultAppSettings(),
      proxies: [
        {
          id: proxyId,
          label: 'Corporate',
          url: 'https://proxy.example:8080',
          credentials: { username: 'alice', secretRef: 'existing-ref' },
        },
      ],
    };

    const result = updateProxy(settings, proxyId, {
      label: 'Corporate',
      url: 'https://proxy.example:8080',
      username: 'bob',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.proxies[0]?.credentials).toEqual({
        username: 'bob',
        secretRef: 'existing-ref',
      });
      expect(result.value.orphanedSecretRef).toBeUndefined();
    }
  });

  it('updateProxy removes credentials and reports the orphaned secretRef when username is omitted', () => {
    const settings: AppSettings = {
      ...defaultAppSettings(),
      proxies: [
        {
          id: proxyId,
          label: 'Corporate',
          url: 'https://proxy.example:8080',
          credentials: { username: 'alice', secretRef: 'existing-ref' },
        },
      ],
    };

    const result = updateProxy(settings, proxyId, {
      label: 'Corporate',
      url: 'https://new-proxy.example:8080',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.proxies[0]).toEqual({
        id: proxyId,
        label: 'Corporate',
        url: 'https://new-proxy.example:8080',
      });
      expect(result.value.orphanedSecretRef).toBe('existing-ref');
    }
  });

  it('updateProxy rejects an unknown id', () => {
    const result = updateProxy(defaultAppSettings(), proxyId, {
      label: 'Corporate',
      url: 'https://proxy.example:8080',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('proxy_not_found');
  });

  it('removeProxy deletes the entry and reports its orphaned secretRef', () => {
    const settings: AppSettings = {
      ...defaultAppSettings(),
      proxies: [
        {
          id: proxyId,
          label: 'Corporate',
          url: 'https://proxy.example:8080',
          credentials: { username: 'alice', secretRef: 'existing-ref' },
        },
      ],
    };

    const result = removeProxy(settings, proxyId);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.proxies).toEqual([]);
      expect(result.value.orphanedSecretRef).toBe('existing-ref');
    }
  });

  it('removeProxy rejects an unknown id', () => {
    const result = removeProxy(defaultAppSettings(), proxyId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('proxy_not_found');
  });

  it('removeProxy clears the reference from every host that named it, keeping the document valid', () => {
    const referencing = makeServer('server-a', 'https://a.example', { proxyId });
    const other = makeServer('server-b', 'https://b.example');
    const settings: AppSettings = {
      ...defaultAppSettings(),
      hosts: [referencing, other],
      proxies: [{ id: proxyId, label: 'Corporate', url: 'https://proxy.example:8080' }],
    };
    // Sanity: a host naming a configured proxy is valid before removal.
    expect(() => appSettingsSchema.parse(settings)).not.toThrow();

    const result = removeProxy(settings, proxyId);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.hosts[0]?.proxyId).toBeUndefined();
      expect(result.value.settings.hosts[1]?.proxyId).toBeUndefined();
      expect(result.value.settings.proxies).toEqual([]);
      expect(() => appSettingsSchema.parse(result.value.settings)).not.toThrow();
    }
  });

  it('removeProxy clears the browser default and every agent that named it, rather than refusing', () => {
    const settings: AppSettings = appSettingsSchema.parse({
      hosts: [],
      proxies: [{ id: proxyId, label: 'Corporate', url: 'https://proxy.example:8080' }],
      agents: {
        [TEST_AGENT_ID]: { active: true, proxy: proxyId },
      },
      browser: { disableNativeWebAuthn: true, proxy: proxyId },
    });
    expect(() => appSettingsSchema.parse(settings)).not.toThrow();

    const result = removeProxy(settings, proxyId);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settings.browser.proxy).toBeUndefined();
      expect(result.value.settings.agents[TEST_AGENT_ID]?.proxy).toBeUndefined();
      expect(() => appSettingsSchema.parse(result.value.settings)).not.toThrow();
    }
  });

  it('reorderProxies accepts a full permutation', () => {
    const proxyIdB = newProxyId(() => 'proxy-b');
    const settings: AppSettings = {
      ...defaultAppSettings(),
      proxies: [
        { id: proxyId, label: 'A', url: 'https://a.example' },
        { id: proxyIdB, label: 'B', url: 'https://b.example' },
      ],
    };

    const result = reorderProxies(settings, [proxyIdB, proxyId]);

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.proxies.map((proxy) => proxy.id)).toEqual([proxyIdB, proxyId]);
  });

  it('reorderProxies rejects an order that is not a permutation', () => {
    const settings: AppSettings = {
      ...defaultAppSettings(),
      proxies: [{ id: proxyId, label: 'A', url: 'https://a.example' }],
    };

    const result = reorderProxies(settings, [newProxyId(() => 'ghost')]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_change');
  });
});

describe('repairProxyEntries', () => {
  it('fills a missing id and label from the address, preserving url and credentials', () => {
    const raw = {
      hosts: [],
      proxies: [
        {
          url: 'http://109.207.79.171:3128',
          credentials: { username: 'proxyuser', secretRef: 'copilotProxy' },
        },
      ],
      agents: { [TEST_AGENT_ID]: { active: true } },
    };

    const repaired = repairProxyEntries(raw) as Record<string, unknown>;
    const entry = (repaired['proxies'] as Record<string, unknown>[])[0];
    expect(entry?.['label']).toBe('http://109.207.79.171:3128');
    expect(entry?.['id']).toMatch(/^repaired-[0-9a-f]{32}$/);
    expect(entry?.['credentials']).toEqual({
      username: 'proxyuser',
      secretRef: 'copilotProxy',
    });
    // The repaired document now passes the strict contract.
    expect(() => appSettingsSchema.parse(repaired)).not.toThrow();
  });

  it('is deterministic across calls, so a repaired id is stable while the file is not rewritten', () => {
    const raw = {
      proxies: [{ url: 'https://proxy.example:8080' }],
    };
    const first = repairProxyEntries(raw) as Record<string, unknown>;
    const second = repairProxyEntries(raw) as Record<string, unknown>;
    expect((first['proxies'] as Record<string, unknown>[])[0]?.['id']).toBe(
      (second['proxies'] as Record<string, unknown>[])[0]?.['id'],
    );
  });

  it('drops entries that are not objects, and entries with no usable address', () => {
    const raw = {
      proxies: ['nope', null, { url: 'not a url', label: 'x' }, { url: 'https://ok.example' }],
    };
    const repaired = repairProxyEntries(raw) as Record<string, unknown>;
    const proxies = repaired['proxies'] as Record<string, unknown>[];
    expect(proxies).toHaveLength(1);
    expect(proxies[0]?.['url']).toBe('https://ok.example');
  });

  it('does not strip unknown keys, so a smuggled field still fails strict validation', () => {
    const raw = {
      proxies: [
        {
          id: 'proxy-a',
          label: 'Corporate',
          url: 'https://proxy.example:8080',
          credentials: { username: 'alice', secretRef: 'vault://alice', password: 'hunter2' },
        },
      ],
    };
    const repaired = repairProxyEntries(raw) as Record<string, unknown>;
    const credentials = (repaired['proxies'] as Record<string, unknown>[])[0]?.['credentials'];
    expect(credentials).toHaveProperty('password');
  });

  it('returns the input untouched when there is nothing to repair', () => {
    const raw = {
      proxies: [{ id: 'proxy-a', label: 'Corporate', url: 'https://proxy.example:8080' }],
    };
    expect(repairProxyEntries(raw)).toBe(raw);
  });

  it('leaves a document with no proxies array untouched', () => {
    const raw = { hosts: [] };
    expect(repairProxyEntries(raw)).toBe(raw);
  });
});

describe('canary: plaintext secrets never reach settings', () => {
  const CANARY = 'CANARY-SECRET-d41d8cd98f00b204';

  it('proxyCredentialsSchema (via appSettingsSchema) rejects a password field carrying the canary', () => {
    const raw = {
      hosts: [],
      proxies: [
        {
          id: 'proxy-a',
          label: 'Corporate',
          url: 'https://proxy.example:8080',
          credentials: { username: 'alice', secretRef: 'vault://alice', password: CANARY },
        },
      ],
      agents: { [TEST_AGENT_ID]: { active: true } },
    };

    expect(() => appSettingsSchema.parse(raw)).toThrow();
  });

  it('loadSettings refuses a file carrying a smuggled password field instead of silently accepting it', async () => {
    const dir = createScratchRoot();
    mkdirSync(dir, { recursive: true });
    const rawWithCanary = {
      hosts: [],
      proxies: [
        {
          id: 'proxy-a',
          label: 'Corporate',
          url: 'https://proxy.example:8080',
          credentials: { username: 'alice', secretRef: 'vault://alice', password: CANARY },
        },
      ],
      agents: { [TEST_AGENT_ID]: { active: true } },
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
    const proxyEntry = proxyConfigSchema.parse({
      id: newProxyId(() => 'proxy-a'),
      label: 'Corporate',
      url: 'https://proxy.example:8080',
      credentials: { username: 'alice', secretRef: 'vault://proxy/alice' },
    });
    const server = makeServer('server-a', 'https://a.example', { proxyId: proxyEntry.id });
    const settings = makeSettings([server], [proxyEntry]);

    await saveSettings(dir, settings);

    const onDisk = readFileSync(settingsFilePath(dir), 'utf8');
    expect(onDisk).not.toContain('password');
    expect(onDisk).not.toContain(CANARY);
  });
});

describe('agent token mutations', () => {
  it('mints a deterministic secretRef per provider', () => {
    expect(agentTokenSecretRef(TEST_AGENT_ID)).toBe(`agent-token:${TEST_AGENT_ID}`);
    // Scoped by provider id, not a single shared key.
    expect(agentTokenSecretRef(TEST_AGENT_ID)).not.toBe(agentTokenSecretRef('other' as AgentId));
  });

  it('adds a token reference for an existing provider', () => {
    const result = updateAgentToken(defaultAppSettings(), TEST_AGENT_ID, {
      secretRef: agentTokenSecretRef(TEST_AGENT_ID),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agents[TEST_AGENT_ID]?.token).toEqual({
      secretRef: agentTokenSecretRef(TEST_AGENT_ID),
    });
    // A node created by the mutation is not marked active.
    expect(result.value.agents[TEST_AGENT_ID]?.active).toBe(false);
  });

  it('replaces an existing token reference', () => {
    const withToken = updateAgentToken(defaultAppSettings(), TEST_AGENT_ID, {
      secretRef: 'agent-token:old',
    });
    expect(withToken.ok).toBe(true);
    if (!withToken.ok) return;

    const replaced = updateAgentToken(withToken.value, TEST_AGENT_ID, {
      secretRef: 'agent-token:new',
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.value.agents[TEST_AGENT_ID]?.token?.secretRef).toBe('agent-token:new');
  });

  it('clears a token reference with null', () => {
    const withToken = updateAgentToken(defaultAppSettings(), TEST_AGENT_ID, {
      secretRef: agentTokenSecretRef(TEST_AGENT_ID),
    });
    expect(withToken.ok).toBe(true);
    if (!withToken.ok) return;

    const cleared = updateAgentToken(withToken.value, TEST_AGENT_ID, null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.agents[TEST_AGENT_ID]?.token).toBeUndefined();
  });

  it('creates an inactive node for a provider with no stored node', () => {
    // Unknown ids are refused earlier, at the IPC boundary, against the
    // discovered definitions; the store itself just records the change.
    const result = updateAgentToken(defaultAppSettings(), TEST_AGENT_ID, {
      secretRef: 'agent-token:x',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agents[TEST_AGENT_ID]).toEqual({
      active: false,
      token: { secretRef: 'agent-token:x' },
    });
  });
});

describe('updateModelPreferences', () => {
  it('stores a model and its reasoning effort', () => {
    const result = updateModelPreferences(defaultAppSettings(), TEST_AGENT_ID, {
      model: 'model-a',
      reasoningEffort: 'high',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agents[TEST_AGENT_ID]?.model).toBe('model-a');
    expect(result.value.agents[TEST_AGENT_ID]?.reasoningEffort).toBe('high');
  });

  it('forces the reasoning effort to null when the model is cleared', () => {
    // Defence in depth. `setModelPreferencesRequestSchema` already refuses an
    // effort without a model, so this combination cannot arrive over IPC - but
    // an orphaned effort persisted here would be re-applied against whatever
    // model Copilot picks next, which is precisely a silently-changed setting.
    const result = updateModelPreferences(defaultAppSettings(), TEST_AGENT_ID, {
      model: null,
      reasoningEffort: 'high',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agents[TEST_AGENT_ID]?.model).toBeUndefined();
    expect(result.value.agents[TEST_AGENT_ID]?.reasoningEffort).toBeUndefined();
  });

  it('clears a previously stored effort when the model is cleared', () => {
    const withBoth = updateModelPreferences(defaultAppSettings(), TEST_AGENT_ID, {
      model: 'model-a',
      reasoningEffort: 'high',
    });
    expect(withBoth.ok).toBe(true);
    if (!withBoth.ok) return;

    const cleared = updateModelPreferences(withBoth.value, TEST_AGENT_ID, {
      model: null,
      reasoningEffort: null,
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.agents[TEST_AGENT_ID]?.reasoningEffort).toBeUndefined();
  });

  it('leaves every other setting untouched', () => {
    const before = defaultAppSettings();
    const result = updateModelPreferences(before, TEST_AGENT_ID, {
      model: 'model-a',
      reasoningEffort: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hosts).toEqual(before.hosts);
    expect(result.value.proxies).toEqual(before.proxies);
  });

  it('rejects a model id the settings contract will not accept', () => {
    const result = updateModelPreferences(defaultAppSettings(), TEST_AGENT_ID, {
      model: 'x'.repeat(5000),
      reasoningEffort: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_change');
  });
});
