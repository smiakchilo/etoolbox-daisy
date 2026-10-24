import { describe, expect, it, vi } from 'vitest';
import { performBridgeFetch, type BridgeFetchDeps } from '../../../src/preload/bridgeFetch';
import type { WebviewBridgeFetchCommand } from '../../../src/shared/contracts/webviewBridge';

const ORIGIN = 'https://author.example';
const COMMAND: WebviewBridgeFetchCommand = {
  requestId: 'req-1',
  url: `${ORIGIN}/content/site.0.json`,
};

/** Builds a `Response`-shaped stub without depending on a real network stack. */
function responseStub(init: {
  status?: number;
  type?: string;
  contentType?: string | null;
  body?: string;
  bodyThrows?: Error;
  headers?: Record<string, string>;
}): Response {
  const headers = new Headers();
  if (init.contentType !== null && init.contentType !== undefined) {
    headers.set('content-type', init.contentType);
  }
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    headers.set(name, value);
  }
  return {
    status: init.status ?? 200,
    type: init.type ?? 'basic',
    headers,
    text: () =>
      init.bodyThrows ? Promise.reject(init.bodyThrows) : Promise.resolve(init.body ?? ''),
  } as unknown as Response;
}

function deps(fetchImpl: BridgeFetchDeps['fetch']): BridgeFetchDeps {
  return { fetch: fetchImpl, currentOrigin: ORIGIN };
}

const neverCalled: BridgeFetchDeps['fetch'] = () => {
  throw new Error('fetch must not be called');
};

describe('performBridgeFetch - what it refuses before touching the network', () => {
  it('blocks a cross-origin URL even though main asked for it', async () => {
    // Main builds the URL and is trusted to build it correctly. This check
    // exists so that a bug there is not by itself enough to turn a document
    // holding a live AEM session into a general-purpose cross-origin fetcher.
    const fetchSpy = vi.fn(neverCalled);
    const reply = await performBridgeFetch(
      { requestId: 'req-1', url: 'https://evil.example/steal' },
      deps(fetchSpy),
      new AbortController().signal,
    );
    expect(reply).toEqual({ kind: 'blocked', requestId: 'req-1', reason: 'cross_origin' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks a same-host URL on a different scheme or port', async () => {
    // `URL.origin` covers scheme, host AND port; all three must match, because
    // a cookie is host-scoped but the session boundary this bridge relies on
    // is the full origin.
    for (const url of ['http://author.example/x.0.json', 'https://author.example:8443/x.0.json']) {
      const reply = await performBridgeFetch(
        { requestId: 'req-1', url },
        deps(vi.fn(neverCalled)),
        new AbortController().signal,
      );
      expect(reply).toEqual({ kind: 'blocked', requestId: 'req-1', reason: 'cross_origin' });
    }
  });

  it('blocks an unparseable URL', async () => {
    const reply = await performBridgeFetch(
      { requestId: 'req-1', url: 'not a url' },
      deps(vi.fn(neverCalled)),
      new AbortController().signal,
    );
    expect(reply).toEqual({ kind: 'blocked', requestId: 'req-1', reason: 'invalid_url' });
  });
});

describe('performBridgeFetch - how it issues the request', () => {
  it('uses ambient same-origin credentials and never follows a redirect', async () => {
    const fetchSpy = vi.fn<BridgeFetchDeps['fetch']>(() =>
      Promise.resolve(responseStub({ body: '{}' })),
    );
    await performBridgeFetch(COMMAND, deps(fetchSpy), new AbortController().signal);

    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('same-origin');
    // `manual`, not `error`: both refuse to follow, but only `manual` stays
    // distinguishable from a connection failure afterwards.
    expect(init?.redirect).toBe('manual');
    expect(init?.cache).toBe('no-store');
  });

  it('never sends an Authorization header or any cookie of its own', async () => {
    // The session is *used*, not *obtained*: the cookie is HttpOnly and this
    // code never asks for it. Asserting on the actual outgoing headers is what
    // makes that claim checkable rather than merely stated in a comment.
    const fetchSpy = vi.fn<BridgeFetchDeps['fetch']>(() =>
      Promise.resolve(responseStub({ body: '{}' })),
    );
    await performBridgeFetch(COMMAND, deps(fetchSpy), new AbortController().signal);

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const headerNames = Object.keys(headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('authorization');
    expect(headerNames).not.toContain('cookie');
    expect(headers['Accept']).toBe('application/json');
  });

  it('issues a GET by default', async () => {
    const fetchSpy = vi.fn<BridgeFetchDeps['fetch']>(() => Promise.resolve(responseStub({})));
    await performBridgeFetch(COMMAND, deps(fetchSpy), new AbortController().signal);

    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('issues a HEAD when asked, still same-origin only', async () => {
    const fetchSpy = vi.fn<BridgeFetchDeps['fetch']>(() => Promise.resolve(responseStub({})));
    await performBridgeFetch(
      { ...COMMAND, method: 'HEAD' },
      deps(fetchSpy),
      new AbortController().signal,
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('HEAD');

    const crossOrigin = await performBridgeFetch(
      { requestId: 'req-2', url: 'https://evil.example/x', method: 'HEAD' },
      deps(vi.fn(neverCalled)),
      new AbortController().signal,
    );
    expect(crossOrigin).toEqual({ kind: 'blocked', requestId: 'req-2', reason: 'cross_origin' });
  });

  it('replaces the Accept header only when the command carries one', async () => {
    const fetchSpy = vi.fn<BridgeFetchDeps['fetch']>(() => Promise.resolve(responseStub({})));
    await performBridgeFetch(
      { ...COMMAND, accept: 'text/html' },
      deps(fetchSpy),
      new AbortController().signal,
    );

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Accept']).toBe('text/html');
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('cookie');
  });
});

describe('performBridgeFetch - how it reports each outcome', () => {
  it('returns the raw status, content type and body without interpreting them', async () => {
    // Classification is main's job. If this module started deciding what counts
    // as usable, there would be two places that answer that question.
    const reply = await performBridgeFetch(
      COMMAND,
      deps(() =>
        Promise.resolve(
          responseStub({ status: 200, contentType: 'application/json', body: '{"a":1}' }),
        ),
      ),
      new AbortController().signal,
    );
    expect(reply).toEqual({
      kind: 'response',
      requestId: 'req-1',
      status: 200,
      contentType: 'application/json',
      bodyText: '{"a":1}',
      headers: [{ name: 'content-type', value: 'application/json' }],
    });
  });

  it('reports the response headers it could read, lowercased by the Headers object', async () => {
    const reply = await performBridgeFetch(
      COMMAND,
      deps(() =>
        Promise.resolve(
          responseStub({
            status: 200,
            contentType: 'application/json',
            body: '{}',
            headers: { 'X-Aem-Path': '/content/foo', 'Cache-Control': 'no-store' },
          }),
        ),
      ),
      new AbortController().signal,
    );
    // The `Headers` object decides iteration order, so assert membership and
    // count rather than a fixed sequence.
    const headers = reply.kind === 'response' ? reply.headers : undefined;
    expect(headers).toHaveLength(3);
    expect(headers).toEqual(
      expect.arrayContaining([
        { name: 'content-type', value: 'application/json' },
        { name: 'x-aem-path', value: '/content/foo' },
        { name: 'cache-control', value: 'no-store' },
      ]),
    );
  });

  it('passes a non-200 status straight through rather than treating it as an error', async () => {
    for (const status of [401, 403, 404, 500]) {
      const reply = await performBridgeFetch(
        COMMAND,
        deps(() =>
          Promise.resolve(responseStub({ status, contentType: 'text/plain', body: 'no' })),
        ),
        new AbortController().signal,
      );
      expect(reply).toMatchObject({ kind: 'response', status });
    }
  });

  it('reports a missing Content-Type as null rather than inventing one', async () => {
    const reply = await performBridgeFetch(
      COMMAND,
      deps(() => Promise.resolve(responseStub({ contentType: null, body: 'x' }))),
      new AbortController().signal,
    );
    expect(reply).toMatchObject({ contentType: null });
  });

  it('reports an opaque redirect as redirect_blocked, carrying no target URL', async () => {
    const reply = await performBridgeFetch(
      COMMAND,
      deps(() => Promise.resolve(responseStub({ status: 0, type: 'opaqueredirect' }))),
      new AbortController().signal,
    );
    expect(reply).toEqual({ kind: 'blocked', requestId: 'req-1', reason: 'redirect_blocked' });
    // The IdP URL must not reach the agent's context, and with `manual` it is
    // genuinely unreadable - so there is nothing here that could leak it.
    expect(JSON.stringify(reply)).not.toContain('http');
  });

  it('treats a status-0 response as a blocked redirect, not an empty success', async () => {
    const reply = await performBridgeFetch(
      COMMAND,
      deps(() => Promise.resolve(responseStub({ status: 0, type: 'basic' }))),
      new AbortController().signal,
    );
    expect(reply).toMatchObject({ kind: 'blocked', reason: 'redirect_blocked' });
  });

  it('reports a connection failure as network_error, keeping the message', async () => {
    const reply = await performBridgeFetch(
      COMMAND,
      deps(() => Promise.reject(new TypeError('Failed to fetch'))),
      new AbortController().signal,
    );
    expect(reply).toEqual({
      kind: 'network_error',
      requestId: 'req-1',
      message: 'Failed to fetch',
    });
  });

  it('reports an abort as cancelled, never as a network failure', async () => {
    // These arrive through the same rejection path, so the distinction rests
    // entirely on checking `signal.aborted` - which is exactly why it is worth
    // a test of its own.
    const controller = new AbortController();
    controller.abort();
    const reply = await performBridgeFetch(
      COMMAND,
      deps(() => Promise.reject(new DOMException('Aborted', 'AbortError'))),
      controller.signal,
    );
    expect(reply).toEqual({ kind: 'cancelled', requestId: 'req-1' });
  });

  it('reports an abort that happens while the body is being read as cancelled', async () => {
    const controller = new AbortController();
    const reply = await performBridgeFetch(
      COMMAND,
      deps(() => {
        controller.abort();
        return Promise.resolve(responseStub({ bodyThrows: new Error('aborted mid-stream') }));
      }),
      controller.signal,
    );
    expect(reply).toEqual({ kind: 'cancelled', requestId: 'req-1' });
  });

  it('reports a body-read failure that is not an abort as network_error', async () => {
    const reply = await performBridgeFetch(
      COMMAND,
      deps(() => Promise.resolve(responseStub({ bodyThrows: new Error('stream broke') }))),
      new AbortController().signal,
    );
    expect(reply).toEqual({ kind: 'network_error', requestId: 'req-1', message: 'stream broke' });
  });

  it('applies no byte cap - a payload over 1 MiB passes through intact', async () => {
    // The user explicitly rejected a size cap, so this asserts the absence of
    // a limit rather than the presence of one.
    const big = 'x'.repeat(1_200_000);
    const reply = await performBridgeFetch(
      COMMAND,
      deps(() =>
        Promise.resolve(
          responseStub({ contentType: 'application/json', body: `{"blob":"${big}"}` }),
        ),
      ),
      new AbortController().signal,
    );
    expect(reply).toMatchObject({ kind: 'response' });
    expect(reply.kind === 'response' && reply.bodyText.length).toBeGreaterThan(1024 * 1024);
  });

  it('echoes back the request id it was given, never one of its own', async () => {
    const reply = await performBridgeFetch(
      { requestId: 'distinct-id', url: COMMAND.url },
      deps(() => Promise.resolve(responseStub({ body: '{}' }))),
      new AbortController().signal,
    );
    expect(reply.requestId).toBe('distinct-id');
  });
});
