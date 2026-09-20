import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultAppSettings,
  DEFAULT_AGENT_ID,
  err,
  newProxyId,
  ok,
  type AppSettings,
  type ModelCatalogEntry,
  type ProxyId,
} from '../../../../src/shared';
import {
  addProxy,
  loadSettings,
  saveSettings,
  updateAgentSettings,
} from '../../../../src/main/settingsStore';
import {
  setAgentSettings,
  type AgentSettingsDependencies,
} from '../../../../src/main/ipc/settings';

/**
 * Tests for `settings:set-agent-settings` (the Agents surface).
 *
 * The regression this file exists for: a proxy (or active-provider) change used
 * to be validated against the live model catalogue even though it does not
 * choose a model. Removing the proxy is exactly what makes the catalogue
 * unreadable, so switching the proxy back was refused as
 * `model_catalog_unavailable` and never persisted - leaving the app stuck on
 * "No proxy" with a permanent "could not retrieve the list of models" banner.
 * Only a catalogue-choosing change may consult (and be refused by) the
 * catalogue.
 */

const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const base = path.join(process.cwd(), 'test-results', 'main-unit-scratch');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'agentSettings-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const catalog: readonly ModelCatalogEntry[] = [
  { id: 'model-a', name: 'Model A', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'model-b', name: 'Model B', supportedReasoningEfforts: [] },
];

const UNAVAILABLE = err({ message: 'Copilot is still starting' });

function deps(overrides: Partial<AgentSettingsDependencies> = {}): AgentSettingsDependencies {
  return {
    loadCatalog: () => Promise.resolve(ok(catalog)),
    isTurnInFlight: () => false,
    onAgentSettingsSaved: () => undefined,
    ...overrides,
  };
}

function errorCodeOf(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

/** Seeds one library proxy and a stored model, so the old code would have validated it. */
async function seedProxyAndModel(dir: string): Promise<ProxyId> {
  const proxyId = newProxyId(() => 'proxy-1');
  const created = addProxy(defaultAppSettings(), proxyId, {
    label: 'Corporate',
    url: 'https://proxy.example:8080',
  });
  if (!created.ok) throw new Error('could not seed proxy');

  const withModel = updateAgentSettings(created.value.settings, DEFAULT_AGENT_ID, {
    model: 'model-a',
    reasoningEffort: 'high',
  });
  if (!withModel.ok) throw new Error('could not seed model');

  const saved = await saveSettings(dir, withModel.value);
  if (!saved.ok) throw new Error('could not seed settings');
  return proxyId;
}

describe('setAgentSettings', () => {
  it('persists a proxy change even when the model catalogue cannot be read', async () => {
    const dir = createScratchRoot();
    const proxyId = await seedProxyAndModel(dir);

    const result = await setAgentSettings(
      dir,
      deps({ loadCatalog: () => Promise.resolve(UNAVAILABLE) }),
      { agentId: DEFAULT_AGENT_ID, changes: { proxy: proxyId } },
    );

    expect(result.ok).toBe(true);
    const loaded = await loadSettings(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.settings.agents[DEFAULT_AGENT_ID]?.proxy).toBe(proxyId);
  });

  it('persists CLEARING the proxy even when the catalogue cannot be read', async () => {
    const dir = createScratchRoot();
    await seedProxyAndModel(dir);

    const result = await setAgentSettings(
      dir,
      deps({ loadCatalog: () => Promise.resolve(UNAVAILABLE) }),
      { agentId: DEFAULT_AGENT_ID, changes: { proxy: null } },
    );

    expect(result.ok).toBe(true);
    const loaded = await loadSettings(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.settings.agents[DEFAULT_AGENT_ID]?.proxy).toBeUndefined();
  });

  it('persists an active-provider change even when the catalogue cannot be read', async () => {
    const dir = createScratchRoot();
    await seedProxyAndModel(dir);
    const onAgentSettingsSaved = vi.fn<(settings: AppSettings) => void>();

    const result = await setAgentSettings(
      dir,
      deps({ loadCatalog: () => Promise.resolve(UNAVAILABLE), onAgentSettingsSaved }),
      { agentId: DEFAULT_AGENT_ID, changes: { active: true } },
    );

    expect(result.ok).toBe(true);
    expect(onAgentSettingsSaved).toHaveBeenCalledTimes(1);
  });

  it('still refuses a model choice when the catalogue cannot be read', async () => {
    const dir = createScratchRoot();
    await seedProxyAndModel(dir);

    const result = await setAgentSettings(
      dir,
      deps({ loadCatalog: () => Promise.resolve(UNAVAILABLE) }),
      { agentId: DEFAULT_AGENT_ID, changes: { model: 'model-b' } },
    );

    expect(errorCodeOf(result)).toBe('model_catalog_unavailable');
  });

  it('still refuses an effort-only change when the catalogue cannot be read', async () => {
    // An effort is validated against the model already stored, so this still
    // needs the catalogue - unlike a proxy change.
    const dir = createScratchRoot();
    await seedProxyAndModel(dir);

    const result = await setAgentSettings(
      dir,
      deps({ loadCatalog: () => Promise.resolve(UNAVAILABLE) }),
      { agentId: DEFAULT_AGENT_ID, changes: { reasoningEffort: 'low' } },
    );

    expect(errorCodeOf(result)).toBe('model_catalog_unavailable');
  });

  it('refuses a model the SDK does not offer', async () => {
    const dir = createScratchRoot();
    await seedProxyAndModel(dir);

    const result = await setAgentSettings(dir, deps(), {
      agentId: DEFAULT_AGENT_ID,
      changes: { model: 'model-ghost' },
    });

    expect(errorCodeOf(result)).toBe('model_not_available');
  });

  it('refuses an unknown proxy id', async () => {
    const dir = createScratchRoot();
    await seedProxyAndModel(dir);

    const result = await setAgentSettings(dir, deps(), {
      agentId: DEFAULT_AGENT_ID,
      changes: { proxy: newProxyId(() => 'ghost') },
    });

    expect(errorCodeOf(result)).toBe('proxy_not_found');
  });

  it('notifies the runtime only AFTER a successful persist, with the whole document', async () => {
    const dir = createScratchRoot();
    const proxyId = await seedProxyAndModel(dir);
    const onAgentSettingsSaved = vi.fn<(settings: AppSettings) => void>();

    const result = await setAgentSettings(
      dir,
      deps({ onAgentSettingsSaved, loadCatalog: () => Promise.resolve(UNAVAILABLE) }),
      { agentId: DEFAULT_AGENT_ID, changes: { proxy: proxyId } },
    );

    expect(result.ok).toBe(true);
    expect(onAgentSettingsSaved).toHaveBeenCalledTimes(1);
    const saved = onAgentSettingsSaved.mock.calls[0]?.[0];
    expect(saved?.agents[DEFAULT_AGENT_ID]?.proxy).toBe(proxyId);
  });

  it('checks the turn lock BEFORE the catalogue', async () => {
    const dir = createScratchRoot();
    await seedProxyAndModel(dir);
    const loadCatalog = vi.fn(() => Promise.resolve(UNAVAILABLE));

    const result = await setAgentSettings(dir, deps({ isTurnInFlight: () => true, loadCatalog }), {
      agentId: DEFAULT_AGENT_ID,
      changes: { model: 'model-a' },
    });

    expect(errorCodeOf(result)).toBe('turn_in_flight');
    expect(loadCatalog).not.toHaveBeenCalled();
  });
});
