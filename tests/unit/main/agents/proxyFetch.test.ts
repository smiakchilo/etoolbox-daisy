import { describe, expect, it } from 'vitest';
import type { Dispatcher } from 'undici';

import { buildProxyFetch } from '../../../../src/main/agents/proxyFetch';

/**
 * `buildProxyFetch` is the one place the host turns an agent's resolved proxy
 * into an in-process `fetch` (`AgentHost.createProxyFetch`). These tests use
 * its `createDispatcher`/`baseFetch` seams so they prove the dispatcher is
 * built from the proxy URL and handed to `fetch` without opening a socket.
 */

const PROXY = {
  httpsProxy: 'http://proxy.example:8080',
  httpProxy: 'http://proxy.example:8080',
};

describe('buildProxyFetch', () => {
  it('returns the base fetch unchanged when no proxy is selected', () => {
    const baseFetch = (): Promise<Response> => Promise.resolve(new Response('{}'));

    expect(buildProxyFetch(undefined, () => ({}) as Dispatcher, baseFetch)).toBe(baseFetch);
  });

  it('builds a dispatcher from the HTTPS proxy and hands it to every request', async () => {
    const dispatcher = { name: 'proxy-dispatcher' } as unknown as Dispatcher;
    const response = new Response('{}', { status: 200 });
    const seen: Array<{ input: unknown; init: unknown }> = [];
    const baseFetch = (input: unknown, init: unknown): Promise<Response> => {
      seen.push({ input, init });
      return Promise.resolve(response);
    };
    const dispatcherUrls: string[] = [];
    const createDispatcher = (proxyUrl: string): Dispatcher => {
      dispatcherUrls.push(proxyUrl);
      return dispatcher;
    };

    const fetchImpl = buildProxyFetch(PROXY, createDispatcher, baseFetch);
    const result = await fetchImpl('https://openrouter.ai/api/v1/models', { method: 'POST' });

    expect(dispatcherUrls).toEqual(['http://proxy.example:8080']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toBe('https://openrouter.ai/api/v1/models');
    expect(seen[0]?.init).toMatchObject({ method: 'POST', dispatcher });
    expect(result).toBe(response);
  });
});
