import { describe, expect, it, vi } from 'vitest';
import {
  type BridgeRequestOptions,
  type BrokerOutcome,
  chatIdSchema,
  requestIdSchema,
  serverIdSchema,
  turnIdSchema,
} from '../../../src/shared';
import {
  HTTP_FETCH_MODEL_BODY_LIMIT,
  HTTP_FETCH_NESTED_BODY_LIMIT,
  createHttpFetchExecutor,
  executeHttpFetch,
  httpFetchArgsSchema,
  resolveFetchUrl,
  type HttpFetchDeps,
  type HttpFetchExecutorConfig,
  type HttpFetchRequest,
} from '../../../src/tools/http-fetch/httpFetch';
import { createCountingIdGenerator } from '../../support/testIds';

const ORIGIN = 'https://author.example';

function envelope(args: Record<string, unknown>): HttpFetchRequest {
  return {
    operation: 'http_fetch',
    requestId: requestIdSchema.parse('req-1'),
    chatId: chatIdSchema.parse('chat-1'),
    turnId: turnIdSchema.parse('turn-1'),
    serverId: serverIdSchema.parse('server-1'),
    serverRevision: 1,
    navigationEpoch: 0,
    deadlineMs: 1_000_000,
    args: httpFetchArgsSchema.parse(args),
  };
}

function response(status = 200, bodyText = 'ok', contentType: string | null = 'text/html') {
  return { kind: 'response', status, contentType, bodyText } satisfies BrokerOutcome;
}

interface Spies {
  readonly bridge: ReturnType<typeof vi.fn<HttpFetchDeps['viaBridge']>>;
  readonly external: ReturnType<typeof vi.fn<NonNullable<HttpFetchDeps['external']>>>;
}

function makeDeps(
  overrides: Partial<HttpFetchDeps> = {},
  bridgeOutcome: BrokerOutcome = response(),
  externalOutcome: BrokerOutcome = response(),
): { deps: HttpFetchDeps } & Spies {
  const bridge = vi.fn<HttpFetchDeps['viaBridge']>(() => Promise.resolve(bridgeOutcome));
  const external = vi.fn<NonNullable<HttpFetchDeps['external']>>(() =>
    Promise.resolve(externalOutcome),
  );
  return {
    bridge,
    external,
    deps: {
      origin: ORIGIN,
      now: () => 1_700_000_000_000,
      viaBridge: bridge,
      external,
      isConfiguredOrigin: (origin) => origin === 'https://other.example',
      bodyLimit: 1000,
      signal: undefined,
      ...overrides,
    },
  };
}

describe('resolveFetchUrl', () => {
  it('resolves a path against the pane origin and drops the fragment', () => {
    expect(resolveFetchUrl('/content/a.html#x', ORIGIN)?.href).toBe(`${ORIGIN}/content/a.html`);
  });

  it.each([
    ['a scheme-relative URL', '//evil.example/x'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['embedded credentials', 'https://user:pw@example.com/'],
    ['nonsense', 'not a url'],
  ])('refuses %s', (_label, raw) => {
    expect(resolveFetchUrl(raw, ORIGIN)).toBeUndefined();
  });
});

describe('executeHttpFetch - routing', () => {
  it("sends a same-origin request through the pane's bridge", async () => {
    const { deps, bridge, external } = makeDeps();

    const result = await executeHttpFetch(envelope({ url: '/content/a.html' }), deps);

    expect(result).toMatchObject({ ok: true, via: 'bridge', status: 200 });
    expect(bridge).toHaveBeenCalledOnce();
    expect(external).not.toHaveBeenCalled();
  });

  it('sends an absolute URL on the pane origin through the bridge too', async () => {
    const { deps, bridge } = makeDeps();

    await executeHttpFetch(envelope({ url: `${ORIGIN}/x` }), deps);

    expect(bridge).toHaveBeenCalledOnce();
  });

  it('sends any other host through the anonymous fetch', async () => {
    const { deps, bridge, external } = makeDeps();

    const result = await executeHttpFetch(envelope({ url: 'https://example.com/a' }), deps);

    expect(result).toMatchObject({ ok: true, via: 'external' });
    expect(external).toHaveBeenCalledOnce();
    expect(bridge).not.toHaveBeenCalled();
  });

  it('refuses another configured host rather than fetching it without its session', async () => {
    const { deps, bridge, external } = makeDeps();

    const result = await executeHttpFetch(envelope({ url: 'https://other.example/a' }), deps);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'ACCESS_DENIED', requiredAction: 'select_server' },
    });
    expect(bridge).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
  });

  it('reports an unusable URL without making a request', async () => {
    const { deps, bridge, external } = makeDeps();

    const result = await executeHttpFetch(envelope({ url: 'ftp://example.com/' }), deps);

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(bridge).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
  });

  it('reports the anonymous fetch as unavailable when the application offers none', async () => {
    const { deps } = makeDeps({ external: undefined });

    const result = await executeHttpFetch(envelope({ url: 'https://example.com/' }), deps);

    expect(result).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } });
  });

  it('hands the method, the accept header and the abort signal on', async () => {
    const controller = new AbortController();
    const { deps, external } = makeDeps({ signal: controller.signal });

    await executeHttpFetch(
      envelope({ url: 'https://example.com/', method: 'HEAD', accept: 'text/html' }),
      deps,
    );

    const [, options, signal] = external.mock.calls[0] ?? [];
    expect(options).toEqual<BridgeRequestOptions>({ method: 'HEAD', accept: 'text/html' });
    expect(signal).toBe(controller.signal);
  });

  it('tells the anonymous fetch the body limit this call accepts', async () => {
    const { deps, external } = makeDeps({ bodyLimit: 1234 });

    await executeHttpFetch(envelope({ url: 'https://example.com/' }), deps);

    expect(external.mock.calls[0]?.[3]).toBe(1234);
  });
});

describe('executeHttpFetch - results', () => {
  it.each([301, 401, 404, 500])('returns HTTP %i as data, not as a failure', async (status) => {
    const { deps } = makeDeps({}, response(status, 'body'), response(status, 'body'));

    const viaBridge = await executeHttpFetch(envelope({ url: '/a' }), deps);
    const viaExternal = await executeHttpFetch(envelope({ url: 'https://example.com/a' }), deps);

    expect(viaBridge).toMatchObject({ ok: true, status });
    expect(viaExternal).toMatchObject({ ok: true, status });
  });

  it('cuts a body to the limit and says so', async () => {
    const { deps } = makeDeps({ bodyLimit: 10 }, response(200, 'x'.repeat(25)));

    const result = await executeHttpFetch(envelope({ url: '/a' }), deps);

    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) expect(result.bodyText).toHaveLength(10);
  });

  it('does not mark a body within the limit', async () => {
    const { deps } = makeDeps({ bodyLimit: 10 }, response(200, 'x'.repeat(10)));

    const result = await executeHttpFetch(envelope({ url: '/a' }), deps);

    expect(result).toMatchObject({ ok: true, truncated: false });
  });

  it('reports a body the anonymous fetch cut at its own limit', async () => {
    const cut: BrokerOutcome = {
      kind: 'response',
      status: 200,
      contentType: 'text/plain',
      bodyText: 'short',
      truncated: true,
    };
    const { deps } = makeDeps({}, response(), cut);

    const result = await executeHttpFetch(envelope({ url: 'https://example.com/' }), deps);

    expect(result).toMatchObject({ ok: true, bodyText: 'short', truncated: true });
  });
});

describe('executeHttpFetch - transport failures', () => {
  it.each<[string, BrokerOutcome, string, string]>([
    ['a timeout', { kind: 'timeout' }, 'TIMEOUT', 'none'],
    ['a cancellation', { kind: 'cancelled' }, 'CANCELLED', 'none'],
    ['a network error', { kind: 'network_error', message: 'x' }, 'NETWORK_ERROR', 'none'],
    ['no pane', { kind: 'no_view' }, 'ACCESS_DENIED', 'select_server'],
    ['an unavailable bridge', { kind: 'bridge_unavailable' }, 'ACCESS_DENIED', 'none'],
    [
      'a stale navigation',
      { kind: 'stale', status: 'stale_navigation_epoch' },
      'STALE_CONTEXT',
      'none',
    ],
    [
      'a redirect off the host',
      { kind: 'blocked', reason: 'redirect_blocked' },
      'REDIRECT_BLOCKED',
      'sign_in_to_host',
    ],
    [
      'a cross-origin refusal',
      { kind: 'blocked', reason: 'cross_origin' },
      'ACCESS_DENIED',
      'none',
    ],
  ])('maps %s from the bridge', async (_label, outcome, code, requiredAction) => {
    const { deps } = makeDeps({}, outcome);

    const result = await executeHttpFetch(envelope({ url: '/a' }), deps);

    expect(result).toMatchObject({ ok: false, error: { code, requiredAction } });
  });

  it('treats a blocked redirect of an anonymous request as "too many", never a lost sign-in', async () => {
    const { deps } = makeDeps({}, response(), { kind: 'blocked', reason: 'redirect_blocked' });

    const result = await executeHttpFetch(envelope({ url: 'https://example.com/' }), deps);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNEXPECTED_RESPONSE', requiredAction: 'none' },
    });
  });

  it('reports a refused address as access denied', async () => {
    const { deps } = makeDeps({}, response(), { kind: 'blocked', reason: 'cross_origin' });

    const result = await executeHttpFetch(envelope({ url: 'https://example.com/' }), deps);

    expect(result).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } });
  });

  it("never echoes a transport failure's own message", async () => {
    const secret = 'SECRET-HOST-9f3a';
    const { deps } = makeDeps({}, response(), { kind: 'network_error', message: secret });

    const result = await executeHttpFetch(envelope({ url: 'https://example.com/' }), deps);

    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('createHttpFetchExecutor', () => {
  const ids = createCountingIdGenerator('id');

  function makeExecutor(bodyText: string) {
    const request = vi.fn<HttpFetchExecutorConfig['request']>(() =>
      Promise.resolve(response(200, bodyText, 'text/html')),
    );
    const executor = createHttpFetchExecutor({
      request,
      external: undefined,
      isConfiguredOrigin: () => false,
      currentContext: () => ({
        origin: ORIGIN,
        serverId: serverIdSchema.parse('server-1'),
        serverRevision: 1,
        navigationEpoch: 0,
        chatId: chatIdSchema.parse('chat-1'),
        turnId: turnIdSchema.parse('turn-1'),
      }),
      clock: () => 1_700_000_000_000,
      idGenerator: ids,
    });
    return { executor, request };
  }

  const callId = 'call-1' as never;

  it('gives the model the body and a nested caller only the status line', async () => {
    const { executor, request } = makeExecutor('BODY-TEXT');

    const forModel = await executor({ url: '/a' }, { toolCallId: callId, signal: undefined });
    const nested = await executor(
      { url: '/a' },
      { toolCallId: callId, signal: undefined, nested: true },
    );

    expect(forModel).toMatchObject({ ok: true });
    expect(JSON.stringify(forModel)).toContain('BODY');
    expect(nested).toMatchObject({ ok: true, value: { bodyText: 'BODY-TEXT' } });
    expect(nested).toMatchObject({
      ok: true,
      value: { textResultForLlm: expect.not.stringContaining('BODY') as unknown },
    });
    // Only the application's own nested read may be evidence about the session.
    expect(request.mock.calls[0]?.[2]).not.toMatchObject({ authEvidence: true });
    expect(request.mock.calls[1]?.[2]).toMatchObject({ authEvidence: true });
  });

  it('gives a nested caller a larger body than the model', async () => {
    const big = 'x'.repeat(HTTP_FETCH_MODEL_BODY_LIMIT + 50);
    const { executor } = makeExecutor(big);

    const forModel = await executor({ url: '/a' }, { toolCallId: callId, signal: undefined });
    const nested = await executor(
      { url: '/a' },
      { toolCallId: callId, signal: undefined, nested: true },
    );

    expect(big.length).toBeLessThan(HTTP_FETCH_NESTED_BODY_LIMIT);
    expect(forModel).toMatchObject({ ok: true, value: { truncated: true } });
    expect(nested).toMatchObject({ ok: true, value: { truncated: false } });
  });

  it('rejects an unknown argument before any request', async () => {
    const { executor, request } = makeExecutor('');

    const result = await executor(
      { url: '/a', body: 'x' },
      { toolCallId: callId, signal: undefined },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(request).not.toHaveBeenCalled();
  });
});
