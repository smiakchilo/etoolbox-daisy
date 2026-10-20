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
  const activeAgentProxy = Object.values(settings.agents).find((node) => node?.active)?.proxy;
  const proxyId = settings.browser.proxy ?? activeAgentProxy;
  const entry =
    proxyId === undefined ? undefined : settings.proxies.find((proxy) => proxy.id === proxyId);
  if (entry === undefined) return buildProxyFetch(undefined);
  const password =
    entry.credentials === undefined
      ? undefined
      : await secretStore.get(entry.credentials.secretRef);
  return buildProxyFetch(buildRuntimeProxyOverrides(entry, password));
}
