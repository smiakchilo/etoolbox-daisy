import type { AgentConnection, AgentId, AppSettings, ProxyConfig } from '../../shared';
import type { SecretStore } from '../secretStore';

/**
 * The host side of `AgentHost.resolveConnection`: reads an agent's proxy and
 * personal-access token from settings and secure storage, so an agent never
 * sees the secret store - only the resolved values its runtime is started with.
 *
 * `buildRuntimeProxyOverrides` turns a proxies-library entry plus its
 * already-resolved password into the proxy environment overrides an agent's
 * runtime child process is started with.
 *
 * Why credentials are embedded in the URL rather than passed some other way:
 * the runtime is a separate child process that makes its own outbound
 * connections, so Electron's `login` event (which the AEM pane's proxy uses -
 * see `aem/proxyAuth.ts`) is not available to it. `HTTPS_PROXY`/
 * `HTTP_PROXY` URLs carrying `user:pass@` are the only mechanism the runtime
 * understands. The password is read from `secretStore` by the caller and
 * never persisted anywhere else; this function only formats it.
 *
 * Encoding is left to the `URL` setter, not done by hand: assigning
 * `url.username`/`url.password` percent-encodes exactly the characters that
 * must be encoded in userinfo (`@`, `:`, `/`, ...) and nothing else, whereas
 * pre-encoding here would double-encode every `%` the user's password
 * legitimately contains ("p%40ss" would become "p%2540ss").
 *
 * The trailing `/` `URL` appends to an origin with no path is removed so the
 * value reads as the proxy address the user configured, not as a URL with an
 * empty path segment.
 */
export function buildRuntimeProxyOverrides(
  proxy: ProxyConfig,
  password: string | undefined,
): NonNullable<AgentConnection['proxy']> {
  const url = new URL(proxy.url);
  const credentials = proxy.credentials;
  if (credentials !== undefined && password !== undefined) {
    // Deliberately raw: see this function's own doc comment on double-encoding.
    url.username = credentials.username;
    url.password = password;
  }
  const address = url.pathname === '/' ? url.toString().slice(0, -1) : url.toString();
  return { httpsProxy: address, httpProxy: address };
}

/**
 * Resolves `agentId`'s connection details from `settings`: its `proxy` entry
 * (with the password read from secure storage) and its stored token. A missing
 * proxy or token means "none" - the normal direct-connection / interactive
 * sign-in case, not an error. A dangling proxy id (rejected by the schema in
 * practice, but a settings file is hand-editable) also resolves to no proxy
 * rather than refusing to start the runtime over a reference the document
 * already considers invalid.
 *
 * The token is deliberately not validated here: `settings:set-password` never
 * calls the provider to check it either, and the runtime is the only component
 * that can legitimately decide whether a token works.
 *
 * A secret-store failure rejects; the runtime manager treats that as "abort the
 * recycle before the working runtime is touched".
 */
export async function resolveConnection(
  agentId: AgentId,
  settings: AppSettings | undefined,
  secretStore: Pick<SecretStore, 'get'>,
): Promise<AgentConnection> {
  const node = settings?.agents[agentId];
  if (settings === undefined || node === undefined) return {};
  const proxyEntry =
    node.proxy === undefined
      ? undefined
      : settings.proxies.find((entry) => entry.id === node.proxy);
  const proxyPassword =
    proxyEntry?.credentials === undefined
      ? undefined
      : await secretStore.get(proxyEntry.credentials.secretRef);
  const secretRef = node.token?.secretRef;
  const accessToken = secretRef === undefined ? undefined : await secretStore.get(secretRef);
  return {
    ...(proxyEntry !== undefined
      ? { proxy: buildRuntimeProxyOverrides(proxyEntry, proxyPassword) }
      : {}),
    ...(accessToken !== undefined ? { accessToken } : {}),
  };
}
