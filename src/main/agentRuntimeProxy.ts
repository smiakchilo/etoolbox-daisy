import type { ProxyEnvOverrides } from '../agent';
import type { AppSettings, ProxyConfig } from '../shared';
import { configuredAgentId } from './settingsStore';
import type { SecretStore } from './secretStore';

/**
 * Resolves the credentials the Copilot runtime child process is started with,
 * both read from settings and secure storage: the active provider's proxy
 * password and its optional personal-access token.
 *
 * Turns a proxies-library entry plus its already-resolved password into the
 * environment overrides the Copilot runtime child process is started with.
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
): ProxyEnvOverrides {
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
 * Resolves the runtime proxy for `settings`: the *active* provider's `proxy`
 * entry, with its password read from secure storage. `undefined` means "no
 * proxy selected", which is the normal, direct-connection case - not an
 * error.
 *
 * A missing entry (a dangling id - rejected by the schema in practice, but a
 * settings file is hand-editable) resolves to no proxy rather than failing:
 * the alternative is refusing to start the runtime at all over a reference
 * the document itself already considers invalid.
 */
export async function resolveAgentProxyOverrides(
  settings: AppSettings | undefined,
  secretStore: Pick<SecretStore, 'get'>,
): Promise<ProxyEnvOverrides | undefined> {
  if (settings === undefined) return undefined;
  const proxyId = settings.agents[configuredAgentId(settings)]?.proxy;
  if (proxyId === undefined) return undefined;
  const proxy = settings.proxies.find((entry) => entry.id === proxyId);
  if (proxy === undefined) return undefined;
  const password =
    proxy.credentials === undefined
      ? undefined
      : await secretStore.get(proxy.credentials.secretRef);
  return buildRuntimeProxyOverrides(proxy, password);
}

/**
 * Resolves the *active* provider's stored personal-access token, reading its
 * plaintext from secure storage. `undefined` means no token is stored, which
 * is the normal interactive-sign-in case - not an error.
 *
 * The token is deliberately not validated here: `settings:set-password` never
 * calls GitHub to check it either (see `ipc/settings.ts`'s
 * `setAgentTokenSecret`), and the runtime is the only component that can
 * legitimately decide whether a token works. A malformed one is reported by
 * the runtime itself ("No GitHub OAuth token or Copilot HMAC key provided.")
 * rather than being guessed at here.
 *
 * Like the proxy, a missing entry resolves to no token rather than failing: a
 * settings file is hand-editable, and refusing to start the runtime over a
 * reference the document already considers invalid would be worse than
 * falling back to interactive sign-in.
 */
export async function resolveAgentGithubToken(
  settings: AppSettings | undefined,
  secretStore: Pick<SecretStore, 'get'>,
): Promise<string | undefined> {
  if (settings === undefined) return undefined;
  const secretRef = settings.agents[configuredAgentId(settings)]?.token?.secretRef;
  if (secretRef === undefined) return undefined;
  return secretStore.get(secretRef);
}
