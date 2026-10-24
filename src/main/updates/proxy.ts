import type { AgentFetch, AppSettings } from '../../shared';
import { buildRuntimeProxyOverrides } from '../agents/connection';
import { buildProxyFetch } from '../agents/proxyFetch';
import type { SecretStore } from '../secretStore';

/**
 * A fetch for the update check and download. An update goes through the same
 * proxy the user already configured: the browser's default proxy, otherwise the
 * active agent's, otherwise a direct connection.
 */
export async function createUpdateFetch(
  settings: AppSettings,
  secretStore: Pick<SecretStore, 'get'>,
): Promise<AgentFetch> {
  const entry = resolveProxyEntry(settings);
  if (entry === undefined) return buildProxyFetch(undefined);
  const password =
    entry.credentials === undefined
      ? undefined
      : await secretStore.get(entry.credentials.secretRef);
  return buildProxyFetch(buildRuntimeProxyOverrides(entry, password));
}

/**
 * Whether {@link createUpdateFetch} would go through a proxy for this settings
 * document. The anonymous outside fetch asks this because a proxy resolves the
 * address itself: the app can then only check literals and internal-looking
 * names, not pin the connection (see `src/main/externalFetch.ts`).
 */
export function isUpdateProxyConfigured(settings: AppSettings): boolean {
  return resolveProxyEntry(settings) !== undefined;
}

function resolveProxyEntry(settings: AppSettings): AppSettings['proxies'][number] | undefined {
  const activeAgentProxy = Object.values(settings.agents).find((node) => node?.active)?.proxy;
  const proxyId = settings.browser.proxy ?? activeAgentProxy;
  if (proxyId === undefined) return undefined;
  return settings.proxies.find((proxy) => proxy.id === proxyId);
}
