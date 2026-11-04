import { beforeEach, describe, expect, it } from 'vitest';
import { mergeImportedSettings } from '../../../src/main/settingsStore';
import {
  agentIdSchema,
  appSettingsSchema,
  defaultAppSettings,
  newProjectId,
  newProxyId,
  newServerId,
  portableSettingsDocumentSchema,
  type AppSettings,
} from '../../../src/shared';

const COPILOT = agentIdSchema.parse('copilot');
const OPENROUTER = agentIdSchema.parse('openrouter');

/** Deterministic id generator: fresh ids read `mint-01`, `mint-02`, ... within one test. */
let counter = 0;
const mintId = (): string => `mint-${String(++counter).padStart(2, '0')}`;
beforeEach(() => {
  counter = 0;
});

/** Parses a portable document literal into the schema's type. */
function doc(raw: unknown): Parameters<typeof mergeImportedSettings>[1] {
  return portableSettingsDocumentSchema.parse(raw);
}

const BLUE = { kind: 'swatch', swatch: 'blue' } as const;
const RED = { kind: 'swatch', swatch: 'red' } as const;

/** One host as it is persisted (current settings), revision included. */
function existingHost(
  id: string,
  origin: string,
  label: string,
  revision: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, origin, label, color: BLUE, revision, ...extra };
}

/** One host as it appears in a portable import document - no `revision`. */
function importedHost(
  id: string,
  origin: string,
  label: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, origin, label, color: BLUE, ...extra };
}

function currentWithHosts(...hosts: Record<string, unknown>[]): AppSettings {
  return appSettingsSchema.parse({ ...defaultAppSettings(), hosts });
}

describe('mergeImportedSettings', () => {
  it('merges a host by origin: overwrites label/colour/type, keeps id and revision', () => {
    const current = currentWithHosts(
      existingHost(
        newServerId(() => 'existing-host'),
        'https://a.example',
        'Old',
        5,
        {
          type: 'author',
        },
      ),
    );
    const imported = doc({
      hosts: [
        {
          id: newServerId(() => 'imported-host'),
          origin: 'https://a.example',
          label: 'New',
          color: RED,
          type: 'publish',
        },
      ],
    });

    const result = mergeImportedSettings(current, imported, mintId);
    expect(result.ok).toBe(true);
    const merged = result.ok ? result.value.hosts[0] : undefined;
    expect(merged?.id).toBe('existing-host');
    expect(merged?.revision).toBe(5);
    expect(merged?.label).toBe('New');
    expect(merged?.color).toEqual(RED);
    expect(merged?.type).toBe('publish');
  });

  it('adds a new host with a fresh id and revision 0', () => {
    const current = defaultAppSettings();
    const imported = doc({
      hosts: [{ id: newServerId(() => 'imported-new'), origin: 'https://b.example', label: 'B' }],
    });

    const result = mergeImportedSettings(current, imported, mintId);
    expect(result.ok).toBe(true);
    const merged = result.ok ? result.value.hosts[0] : undefined;
    expect(merged?.id).toBe('mint-01');
    expect(merged?.revision).toBe(0);
    expect(merged?.origin).toBe('https://b.example');
  });

  it('remaps a host proxyId through the imported proxy (by url) to the existing id', () => {
    const current = appSettingsSchema.parse({
      ...defaultAppSettings(),
      proxies: [
        { id: newProxyId(() => 'existing-proxy'), label: 'Corp', url: 'https://proxy.example' },
      ],
    });
    const imported = doc({
      proxies: [{ id: newProxyId(() => 'imported-proxy'), url: 'https://proxy.example' }],
      hosts: [
        importedHost(
          newServerId(() => 'imported-host'),
          'https://a.example',
          'A',
          {
            proxyId: 'imported-proxy',
          },
        ),
      ],
    });

    const result = mergeImportedSettings(current, imported, mintId);
    expect(result.ok).toBe(true);
    const merged = result.ok ? result.value.hosts[0] : undefined;
    expect(merged?.proxyId).toBe('existing-proxy');
  });

  it('remaps a host projectId through the imported project (by label)', () => {
    const current = appSettingsSchema.parse({
      ...defaultAppSettings(),
      projects: [{ id: newProjectId(() => 'existing-project'), label: 'Acme project' }],
    });
    const imported = doc({
      projects: [{ id: newProjectId(() => 'imported-project'), label: 'Acme project' }],
      hosts: [
        importedHost(
          newServerId(() => 'imported-host'),
          'https://a.example',
          'A',
          {
            projectId: 'imported-project',
          },
        ),
      ],
    });

    const result = mergeImportedSettings(current, imported, mintId);
    expect(result.ok).toBe(true);
    const merged = result.ok ? result.value.hosts[0] : undefined;
    expect(merged?.projectId).toBe('existing-project');
  });

  it('drops a proxyId reference the import file does not contain', () => {
    const current = defaultAppSettings();
    const imported = doc({
      hosts: [
        importedHost(
          newServerId(() => 'imported-host'),
          'https://a.example',
          'A',
          {
            proxyId: 'ghost-proxy',
          },
        ),
      ],
    });

    const result = mergeImportedSettings(current, imported, mintId);
    expect(result.ok).toBe(true);
    const merged = result.ok ? result.value.hosts[0] : undefined;
    expect(merged?.proxyId).toBeUndefined();
  });

  it('preserves the "No proxy" sentinel through a host merge', () => {
    const current = currentWithHosts(
      existingHost(
        newServerId(() => 'h'),
        'https://a.example',
        'A',
        1,
      ),
    );
    const imported = doc({
      hosts: [
        { id: newServerId(() => 'imported-host'), origin: 'https://a.example', proxyId: 'none' },
      ],
    });

    const result = mergeImportedSettings(current, imported, mintId);
    expect(result.ok).toBe(true);
    const merged = result.ok ? result.value.hosts[0] : undefined;
    expect(merged?.proxyId).toBe('none');
  });

  it('merges a proxy by url and keeps its credentials (password never round-trips)', () => {
    const current = appSettingsSchema.parse({
      ...defaultAppSettings(),
      proxies: [
        {
          id: newProxyId(() => 'existing-proxy'),
          label: 'Old',
          url: 'https://proxy.example',
          credentials: { username: 'alice', secretRef: 'proxy:existing-proxy' },
        },
      ],
    });
    const imported = doc({
      proxies: [
        { id: newProxyId(() => 'imported-proxy'), url: 'https://proxy.example', label: 'New' },
      ],
    });

    const result = mergeImportedSettings(current, imported, mintId);
    expect(result.ok).toBe(true);
    const proxy = result.ok ? result.value.proxies[0] : undefined;
    expect(proxy?.id).toBe('existing-proxy');
    expect(proxy?.label).toBe('New');
    expect(proxy?.credentials).toEqual({ username: 'alice', secretRef: 'proxy:existing-proxy' });
  });

  it('adds a new proxy with a fresh id and no credentials', () => {
    const result = mergeImportedSettings(
      defaultAppSettings(),
      doc({ proxies: [{ id: newProxyId(() => 'imported-proxy'), url: 'https://proxy.example' }] }),
      mintId,
    );
    expect(result.ok).toBe(true);
    const proxy = result.ok ? result.value.proxies[0] : undefined;
    expect(proxy?.id).toBe('mint-01');
    expect(proxy?.credentials).toBeUndefined();
  });

  it('merges a project by label, replacing its roots', () => {
    const current = appSettingsSchema.parse({
      ...defaultAppSettings(),
      projects: [
        { id: newProjectId(() => 'existing-project'), label: 'Acme', contentRoots: '/old' },
      ],
    });
    const imported = doc({
      projects: [
        {
          id: newProjectId(() => 'imported-project'),
          label: 'Acme',
          contentRoots: '/new',
          damRoots: '/content/dam',
        },
      ],
    });

    const result = mergeImportedSettings(current, imported, mintId);
    expect(result.ok).toBe(true);
    const project = result.ok ? result.value.projects[0] : undefined;
    expect(project?.id).toBe('existing-project');
    expect(project?.contentRoots).toBe('/new');
    expect(project?.damRoots).toBe('/content/dam');
  });

  it('merges agents per provider id, preserves the token, and the imported active wins', () => {
    const current = appSettingsSchema.parse({
      ...defaultAppSettings(),
      agents: {
        [COPILOT]: { active: true, token: { secretRef: 'agent-token:copilot' } },
        [OPENROUTER]: { active: false },
      },
    });
    const imported = doc({ agents: { openrouter: { active: true } } });

    const result = mergeImportedSettings(current, imported, mintId);
    expect(result.ok).toBe(true);
    const agents = result.ok ? result.value.agents : undefined;
    expect(agents?.[COPILOT]?.active).toBe(false);
    expect(agents?.[OPENROUTER]?.active).toBe(true);
    expect(agents?.[COPILOT]?.token).toEqual({ secretRef: 'agent-token:copilot' });
  });

  it('leaves singular sections untouched when absent from the import', () => {
    const current = appSettingsSchema.parse({
      ...defaultAppSettings(),
      browser: { disableNativeWebAuthn: false },
      memos: { enabled: false },
      updates: { checkOnStartup: true },
    });
    const result = mergeImportedSettings(current, doc({ hosts: [] }), mintId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.browser.disableNativeWebAuthn).toBe(false);
    expect(result.value.memos.enabled).toBe(false);
    expect(result.value.updates.checkOnStartup).toBe(true);
  });

  it('overwrites a singular section when present, remapping its proxy reference', () => {
    const current = appSettingsSchema.parse({
      ...defaultAppSettings(),
      proxies: [
        { id: newProxyId(() => 'existing-proxy'), label: 'Corp', url: 'https://proxy.example' },
      ],
      browser: { disableNativeWebAuthn: false },
    });
    const imported = doc({
      proxies: [{ id: newProxyId(() => 'imported-proxy'), url: 'https://proxy.example' }],
      browser: { disableNativeWebAuthn: true, proxy: 'imported-proxy' },
    });

    const result = mergeImportedSettings(current, imported, mintId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.browser.disableNativeWebAuthn).toBe(true);
    expect(result.value.browser.proxy).toBe('existing-proxy');
  });

  it('merges two imported hosts sharing an origin: the later entry wins', () => {
    const imported = doc({
      hosts: [
        { id: newServerId(() => 'h1'), origin: 'https://a.example', label: 'First' },
        { id: newServerId(() => 'h2'), origin: 'https://a.example', label: 'Second' },
      ],
    });
    const result = mergeImportedSettings(defaultAppSettings(), imported, mintId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hosts).toHaveLength(1);
    expect(result.value.hosts[0]?.label).toBe('Second');
  });

  it('refuses an import that would leave two agents active', () => {
    const imported = doc({
      agents: { copilot: { active: true }, openrouter: { active: true } },
    });
    const result = mergeImportedSettings(defaultAppSettings(), imported, mintId);
    expect(result.ok).toBe(false);
  });
});
