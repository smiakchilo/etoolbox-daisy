import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFetch } from '../../../../src/shared';
import {
  defaultAppSettings,
  newProxyId,
  proxyConfigSchema,
  type AppSettings,
} from '../../../../src/shared';

const buildProxyFetch = vi.fn<(proxy: unknown) => AgentFetch>();

vi.mock('../../../../src/main/agents/proxyFetch', () => ({
  buildProxyFetch: (proxy: unknown) => buildProxyFetch(proxy),
}));

const { createUpdateFetch } = await import('../../../../src/main/updates/proxy');

const proxyEntry = (id: string, credentials = false) =>
  proxyConfigSchema.parse({
    id: newProxyId(() => id),
    label: `Proxy ${id}`,
    url: 'https://proxy.example:8080',
    ...(credentials ? { credentials: { username: 'bob', secretRef: `ref-${id}` } } : {}),
  });

const secretStore = { get: vi.fn<(ref: string) => Promise<string | undefined>>() };
const FETCH: AgentFetch = () => Promise.resolve(new Response('{}'));

beforeEach(() => {
  buildProxyFetch.mockReset();
  buildProxyFetch.mockReturnValue(FETCH);
  secretStore.get.mockReset();
  secretStore.get.mockResolvedValue('s3cret');
});

function settingsWith(overrides: Partial<Record<keyof AppSettings, unknown>>): AppSettings {
  return { ...defaultAppSettings(), ...overrides } as AppSettings;
}

describe('createUpdateFetch', () => {
  it('connects directly when no proxy is configured', async () => {
    expect(await createUpdateFetch(defaultAppSettings(), secretStore)).toBe(FETCH);
    expect(buildProxyFetch).toHaveBeenCalledWith(undefined);
  });

  it("uses the browser's default proxy", async () => {
    const entry = proxyEntry('one');
    await createUpdateFetch(
      settingsWith({
        proxies: [entry],
        browser: { ...defaultAppSettings().browser, proxy: entry.id },
      }),
      secretStore,
    );
    expect(buildProxyFetch).toHaveBeenCalledWith({
      httpsProxy: 'https://proxy.example:8080',
      httpProxy: 'https://proxy.example:8080',
    });
  });

  it("falls back to the active agent's proxy", async () => {
    const entry = proxyEntry('two');
    await createUpdateFetch(
      settingsWith({ proxies: [entry], agents: { copilot: { active: true, proxy: entry.id } } }),
      secretStore,
    );
    expect(buildProxyFetch).toHaveBeenCalledWith(
      expect.objectContaining({ httpsProxy: 'https://proxy.example:8080' }),
    );
  });

  it('reads the proxy password from the secret store', async () => {
    const entry = proxyEntry('three', true);
    await createUpdateFetch(
      settingsWith({
        proxies: [entry],
        browser: { ...defaultAppSettings().browser, proxy: entry.id },
      }),
      secretStore,
    );
    expect(secretStore.get).toHaveBeenCalledWith('ref-three');
    const [proxy] = buildProxyFetch.mock.calls[0] ?? [];
    expect(JSON.stringify(proxy)).toContain('s3cret');
  });

  it('connects directly when the selected proxy no longer exists', async () => {
    const entry = proxyEntry('four');
    await createUpdateFetch(
      settingsWith({ browser: { ...defaultAppSettings().browser, proxy: entry.id } }),
      secretStore,
    );
    expect(buildProxyFetch).toHaveBeenCalledWith(undefined);
  });
});
