import { describe, expect, it, vi } from 'vitest';
import type { Dispatcher } from 'undici';
import type { AgentFetch } from '../../../src/shared';
import {
  EXTERNAL_FETCH_USER_AGENT,
  createExternalFetch,
  createPinnedLookup,
  isRefusedAddress,
} from '../../../src/main/externalFetch';

const PUBLIC = ['93.184.216.34'];

function reply(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function requestUrl(input: Parameters<AgentFetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

interface FakeDispatcher {
  readonly addresses: readonly string[];
  readonly destroy: ReturnType<typeof vi.fn>;
}

function setup(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response,
  options: Partial<Parameters<typeof createExternalFetch>[0]> = {},
) {
  const fetchImpl = vi.fn<AgentFetch>((input, init) =>
    Promise.resolve(handler(requestUrl(input), init)),
  );
  const resolveAddresses = vi.fn(() => Promise.resolve(PUBLIC));
  const dispatchers: FakeDispatcher[] = [];
  const external = createExternalFetch({
    getTransport: () => Promise.resolve({ fetch: fetchImpl, proxied: false }),
    resolveAddresses,
    createDispatcher: (addresses) => {
      const dispatcher: FakeDispatcher = { addresses, destroy: vi.fn() };
      dispatchers.push(dispatcher);
      return dispatcher as unknown as Dispatcher;
    },
    ...options,
  });
  return { external, fetchImpl, resolveAddresses, dispatchers };
}

function dispatcherOf(init: RequestInit | undefined): FakeDispatcher | undefined {
  return (init as (RequestInit & { dispatcher?: FakeDispatcher }) | undefined)?.dispatcher;
}

describe('isRefusedAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.8',
    '192.0.2.10',
    '192.88.99.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '2001:0:1::1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    '::127.0.0.1',
    '2002:7f00:0001::1',
    '64:ff9b::7f00:1',
  ])('refuses %s', (address) => {
    expect(isRefusedAddress(address)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
    '2002:0808:0808::1',
    '64:ff9b::8.8.8.8',
  ])('allows the public address %s', (address) => {
    expect(isRefusedAddress(address)).toBe(false);
  });

  it('refuses anything that is not an address', () => {
    expect(isRefusedAddress('example.com')).toBe(true);
  });
});

describe('createPinnedLookup', () => {
  it('answers with the validated addresses and never resolves again', async () => {
    const lookup = createPinnedLookup(['93.184.216.34', '2606:4700::1111']);

    const addresses = await new Promise<unknown>((resolve, reject) => {
      lookup('rebind.example', { all: true }, (error, value) =>
        error === null ? resolve(value) : reject(error),
      );
    });

    expect(addresses).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
  });

  it('answers a single-address lookup with the first validated address', async () => {
    const lookup = createPinnedLookup(['93.184.216.34']);

    const answer = await new Promise<unknown>((resolve, reject) => {
      lookup('rebind.example', {}, (error, address, family) =>
        error === null ? resolve({ address, family }) : reject(error),
      );
    });

    expect(answer).toEqual({ address: '93.184.216.34', family: 4 });
  });
});

describe('createExternalFetch - what may be requested', () => {
  it.each([
    'http://localhost/x',
    'http://intranet/x',
    'https://printer.local/x',
    'https://svc.internal/x',
    'http://127.0.0.1/x',
    'http://[::1]/x',
    'http://169.254.169.254/latest/meta-data',
  ])('refuses %s without making a request', async (url) => {
    const { external, fetchImpl } = setup(() => reply('x'));

    const outcome = await external(url, {}, undefined);

    expect(outcome).toEqual({ kind: 'blocked', reason: 'cross_origin' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a public-looking name that resolves to a private address', async () => {
    const { external, fetchImpl, resolveAddresses } = setup(() => reply('x'));
    resolveAddresses.mockResolvedValue(['93.184.216.34', '10.0.0.5']);

    const outcome = await external('https://rebind.example.com/', {}, undefined);

    expect(outcome).toEqual({ kind: 'blocked', reason: 'cross_origin' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a name that cannot be resolved, rather than leaving it to the request', async () => {
    const { external, fetchImpl, resolveAddresses } = setup(() => reply('x'));
    resolveAddresses.mockRejectedValue(new Error('ENOTFOUND'));

    expect(await external('https://example.com/', {}, undefined)).toEqual({
      kind: 'blocked',
      reason: 'cross_origin',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a name that resolves to no address at all', async () => {
    const { external, fetchImpl, resolveAddresses } = setup(() => reply('x'));
    resolveAddresses.mockResolvedValue([]);

    expect(await external('https://example.com/', {}, undefined)).toEqual({
      kind: 'blocked',
      reason: 'cross_origin',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('connects through a dispatcher pinned to the addresses it validated', async () => {
    const { external, fetchImpl, dispatchers } = setup(() => reply('x'));

    await external('https://example.com/', {}, undefined);

    expect(dispatchers.map((dispatcher) => dispatcher.addresses)).toEqual([PUBLIC]);
    expect(dispatcherOf(fetchImpl.mock.calls[0]?.[1])).toBe(dispatchers[0]);
  });

  it('examines only literals and internal names when a proxy resolves the address', async () => {
    const fetchImpl = vi.fn<AgentFetch>(() => Promise.resolve(reply('x')));
    const resolveAddresses = vi.fn(() => Promise.resolve(['10.0.0.5']));
    const createDispatcher = vi.fn();
    const external = createExternalFetch({
      getTransport: () => Promise.resolve({ fetch: fetchImpl, proxied: true }),
      resolveAddresses,
      createDispatcher,
    });

    await expect(external('https://example.com/', {}, undefined)).resolves.toMatchObject({
      kind: 'response',
    });
    await expect(external('http://127.0.0.1/', {}, undefined)).resolves.toMatchObject({
      kind: 'blocked',
    });
    expect(resolveAddresses).not.toHaveBeenCalled();
    expect(createDispatcher).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(['ftp://example.com/', 'file:///etc/passwd', 'not a url'])(
    'rejects %s as an invalid URL',
    async (url) => {
      const { external, fetchImpl } = setup(() => reply('x'));

      expect(await external(url, {}, undefined)).toEqual({
        kind: 'blocked',
        reason: 'invalid_url',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

describe('createExternalFetch - the request', () => {
  it('sends no credentials, never follows a redirect itself and never caches', async () => {
    const { external, fetchImpl } = setup(() => reply('x'));

    await external('https://example.com/', {}, undefined);

    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
    });
    expect(dispatcherOf(fetchImpl.mock.calls[0]?.[1])?.destroy).toHaveBeenCalled();
  });

  it("sends the caller's method and accept header", async () => {
    const { external, fetchImpl } = setup(() => reply('x'));

    await external('https://example.com/', { method: 'HEAD', accept: 'text/html' }, undefined);

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe('HEAD');
    expect(init?.headers).toEqual({
      Accept: 'text/html',
      'User-Agent': EXTERNAL_FETCH_USER_AGENT,
    });
  });

  it('returns status, content type and body', async () => {
    const { external } = setup(() => reply('hello', { status: 404 }));

    expect(await external('https://example.com/', {}, undefined)).toEqual({
      kind: 'response',
      status: 404,
      contentType: 'text/html',
      bodyText: 'hello',
    });
  });

  it('returns no body for HEAD', async () => {
    const { external } = setup(() => reply('would-be-body'));

    const outcome = await external('https://example.com/', { method: 'HEAD' }, undefined);

    expect(outcome).toMatchObject({ kind: 'response', bodyText: '' });
  });

  it('cuts a body at the byte cap and says so', async () => {
    const { external } = setup(() => reply('x'.repeat(500)), { maxBytes: 100 });

    const outcome = await external('https://example.com/', {}, undefined);

    expect(outcome).toMatchObject({ kind: 'response', truncated: true });
    if (outcome.kind === 'response') expect(outcome.bodyText).toHaveLength(100);
  });

  it('never offers more than the caller asked for', async () => {
    const { external } = setup(() => reply('x'.repeat(500)));

    const outcome = await external('https://example.com/', {}, undefined, 10);

    expect(outcome).toMatchObject({ kind: 'response', truncated: true });
    if (outcome.kind === 'response') expect(outcome.bodyText).toHaveLength(10);
  });

  it('refuses a declared body larger than the limit without reading it', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          controller.enqueue(new TextEncoder().encode('x'.repeat(10)));
        },
      },
      // Pull only when someone reads, so the count measures reads and not the
      // stream's own eager fill.
      { highWaterMark: 0 },
    );
    const { external } = setup(
      () => new Response(body, { headers: { 'content-length': '5000' } }),
      { maxBytes: 100 },
    );

    const outcome = await external('https://example.com/', {}, undefined);

    expect(outcome).toMatchObject({ kind: 'response', bodyText: '', truncated: true });
    expect(pulled).toBe(0);
  });

  it('stops reading a stream at the limit instead of draining it', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(10)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { external } = setup(() => new Response(body), { maxBytes: 25 });

    const outcome = await external('https://example.com/', {}, undefined);

    expect(outcome).toMatchObject({ kind: 'response', truncated: true });
    if (outcome.kind === 'response') expect(outcome.bodyText).toHaveLength(25);
    expect(cancelled).toBe(true);
  });

  it('does not call a body exactly at the limit truncated', async () => {
    const { external } = setup(() => reply('x'.repeat(10)), { maxBytes: 10 });

    const outcome = await external('https://example.com/', {}, undefined);

    expect(outcome).toMatchObject({ kind: 'response', bodyText: 'x'.repeat(10) });
    if (outcome.kind === 'response') expect(outcome.truncated).toBeUndefined();
  });
});

describe('createExternalFetch - redirects', () => {
  it('follows a redirect and checks the new target', async () => {
    const { external, fetchImpl } = setup((url) =>
      url.endsWith('/a') ? redirect('/b') : reply('final'),
    );

    const outcome = await external('https://example.com/a', {}, undefined);

    expect(outcome).toMatchObject({ kind: 'response', bodyText: 'final' });
    expect(fetchImpl.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('resolves and pins every hop separately', async () => {
    const { external, fetchImpl, resolveAddresses, dispatchers } = setup((url) =>
      url.endsWith('/a') ? redirect('/b') : reply('final'),
    );
    resolveAddresses.mockResolvedValueOnce(['93.184.216.34']);
    resolveAddresses.mockResolvedValueOnce(['1.1.1.1']);

    await external('https://example.com/a', {}, undefined);

    expect(resolveAddresses).toHaveBeenCalledTimes(2);
    expect(dispatchers.map((dispatcher) => dispatcher.addresses)).toEqual([
      ['93.184.216.34'],
      ['1.1.1.1'],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses a redirect to a private address', async () => {
    const { external, fetchImpl } = setup(() => redirect('http://169.254.169.254/latest'));

    const outcome = await external('https://example.com/a', {}, undefined);

    expect(outcome).toEqual({ kind: 'blocked', reason: 'cross_origin' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('gives up after too many redirects', async () => {
    const { external, fetchImpl } = setup(() => redirect('/again'), { maxRedirects: 2 });

    const outcome = await external('https://example.com/a', {}, undefined);

    expect(outcome).toEqual({ kind: 'blocked', reason: 'redirect_blocked' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns a 3xx with no Location as an ordinary response', async () => {
    const { external } = setup(() => new Response(null, { status: 304 }));

    expect(await external('https://example.com/', {}, undefined)).toMatchObject({
      kind: 'response',
      status: 304,
    });
  });
});

describe('createExternalFetch - failure and cancellation', () => {
  it('reports a network failure without relaying anything unbounded', async () => {
    const { external } = setup(() => {
      throw new Error('boom'.repeat(100));
    });

    const outcome = await external('https://example.com/', {}, undefined);

    expect(outcome.kind).toBe('network_error');
    if (outcome.kind === 'network_error') expect(outcome.message.length).toBeLessThanOrEqual(200);
  });

  it('reports a cancellation when the caller aborts', async () => {
    const controller = new AbortController();
    const { external } = setup((_url, init) => {
      controller.abort();
      throw (init?.signal as AbortSignal).reason;
    });

    expect(await external('https://example.com/', {}, controller.signal)).toEqual({
      kind: 'cancelled',
    });
  });

  it('reports a timeout when the deadline passes', async () => {
    const { external } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
      { timeoutMs: 20 },
    );

    expect(await external('https://example.com/', {}, undefined)).toEqual({ kind: 'timeout' });
  });
});

describe('createExternalFetch - concurrency', () => {
  it('runs no more requests at once than the limit', async () => {
    let active = 0;
    let peak = 0;
    const { external } = setup(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return reply('x');
      },
      { concurrency: 2 },
    );

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        external(`https://example.com/${String(i)}`, {}, undefined),
      ),
    );

    expect(peak).toBe(2);
  });

  it('drops a queued request whose caller aborts instead of running it later', async () => {
    let release: (() => void) | undefined;
    const { external, fetchImpl } = setup(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(reply('x'));
        }),
      { concurrency: 1 },
    );

    const first = external('https://example.com/1', {}, undefined);
    const controller = new AbortController();
    const queued = external('https://example.com/2', {}, controller.signal);
    controller.abort();

    expect(await queued).toEqual({ kind: 'cancelled' });
    release?.();
    await first;

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
