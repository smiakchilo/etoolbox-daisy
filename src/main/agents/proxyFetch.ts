import { ProxyAgent, type Dispatcher } from 'undici';

import type { AgentConnection, AgentFetch } from '../../shared';

/**
 * The one place the host turns a resolved {@link AgentConnection} into the
 * in-process `fetch` an agent makes its own HTTP calls with. It implements
 * `AgentHost.createProxyFetch`, so an agent folder never imports `undici` and
 * a selected proxy is applied identically for every in-process provider.
 *
 * A connection with no proxy returns `baseFetch` unchanged: a direct
 * connection must never be wrapped in a dispatcher, and there is nothing to
 * route.
 *
 * `undici`'s `ProxyAgent` is the Node mechanism for this. The OpenRouter SDK
 * accepts a custom `fetcher` but has no proxy option of its own, and Node's
 * global `fetch` neither honours `HTTPS_PROXY` nor exports `ProxyAgent`. Only
 * HTTPS egress matters for an in-process provider (the OpenRouter API is
 * HTTPS-only), so the single `httpsProxy` URL is used for every request; the
 * connection carries both URL fields because a child-process runtime reads
 * `HTTPS_PROXY` *and* `HTTP_PROXY` from its environment.
 *
 * `createDispatcher` and `baseFetch` are seams for the unit test: they let it
 * prove the dispatcher is built from the proxy URL and handed to `fetch`
 * without opening a socket.
 */
export function buildProxyFetch(
  proxy: AgentConnection['proxy'],
  createDispatcher: (proxyUrl: string) => Dispatcher = (proxyUrl) => new ProxyAgent(proxyUrl),
  baseFetch: AgentFetch = fetch,
): AgentFetch {
  if (proxy === undefined) return baseFetch;
  const dispatcher = createDispatcher(proxy.httpsProxy);
  return (input, init) => {
    const withDispatcher = { ...init, dispatcher } as Parameters<AgentFetch>[1] & {
      dispatcher: Dispatcher;
    };
    return baseFetch(input, withDispatcher);
  };
}
