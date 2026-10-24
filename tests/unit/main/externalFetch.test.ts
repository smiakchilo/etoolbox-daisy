import { describe, expect, it, vi } from 'vitest';
import type { AgentFetch } from '../../../src/shared';
import { createExternalFetch, isRefusedAddress } from '../../../src/main/externalFetch';

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

function setup(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response,
  options: Partial<Parameters<typeof createExternalFetch>[0]> = {},
) {
  const fetchImpl = vi.fn<AgentFetch>((input, init) =>
    Promise.resolve(handler(requestUrl(input), init)),
  );
  const resolveAddresses = vi.fn(() => Promise.resolve(PUBLIC));
  const external = createExternalFetch({
    getFetch: () => Promise.resolve(fetchImpl),
    resolveAddresses,
    ...options,
  });
  return { external, fetchImpl, resolveAddresses };
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
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
  ])('refuses %s', (address) => {
    expect(isRefusedAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2606:4700::1111'])(
    'allows the public address %s',
    (address) => {
      expect(isRefusedAddress(address)).toBe(false);
    },
  );

  it('refuses anything that is not an address', () => {
    expect(isRefusedAddress('example.com')).toBe(true);
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

  it('lets the request decide when a name cannot be resolved', async () => {
    const { external, fetchImpl, resolveAddresses } = setup(() => reply('x'));
    resolveAddresses.mockRejectedValue(new Error('ENOTFOUND'));

    const outcome = await external('https://example.com/', {}, undefined);

    expect(outcome).toMatchObject({ kind: 'response', status: 200 });
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
  });

  it("sends the caller's method and accept header", async () => {
    const { external, fetchImpl } = setup(() => reply('x'));

    await external('https://example.com/', { method: 'HEAD', accept: 'text/html' }, undefined);

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe('HEAD');
    expect(init?.headers).toEqual({ Accept: 'text/html' });
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

  it('cuts a body at the character cap', async () => {
    const { external } = setup(() => reply('x'.repeat(500)), { maxChars: 100 });

    const outcome = await external('https://example.com/', {}, undefined);

    expect(outcome).toMatchObject({ kind: 'response' });
    if (outcome.kind === 'response') expect(outcome.bodyText).toHaveLength(100);
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
});
