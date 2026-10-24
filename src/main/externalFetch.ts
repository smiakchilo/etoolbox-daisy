import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  type AgentFetch,
  type BridgeRequestOptions,
  type BrokerOutcome,
  DEFAULT_REQUEST_CONCURRENCY,
} from '../shared';

/**
 * The anonymous fetch behind `http_fetch` for any host the browser pane is not
 * on: the application's own network stack (through the user's configured proxy),
 * with no cookies, no session and no credentials. It exists so a tool can check
 * a public URL without the model - or the page - being able to point the
 * application's network position at an internal service.
 *
 * Limits, all enforced here and never by the caller: http(s) only; local,
 * private, link-local and internal-looking addresses are refused at every hop;
 * redirects are followed by hand up to a small cap; one request has a deadline
 * and a body cap; at most `DEFAULT_REQUEST_CONCURRENCY` requests run at once.
 */

export const EXTERNAL_FETCH_TIMEOUT_MS = 30_000;
export const EXTERNAL_FETCH_MAX_REDIRECTS = 5;
/** One more than `http_fetch`'s largest body limit, so the tool can see a body was cut. */
export const EXTERNAL_FETCH_MAX_CHARS = 5_000_001;

const DEFAULT_ACCEPT = 'application/json, text/plain;q=0.9, */*;q=0.8';

export interface ExternalFetchOptions {
  /** Resolved per request, so a proxy change applies without a restart. */
  readonly getFetch: () => Promise<AgentFetch>;
  /** Every address a name resolves to; a failure means "let the request decide". */
  readonly resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxChars?: number;
  readonly concurrency?: number;
}

export type ExternalFetch = (
  url: string,
  options: BridgeRequestOptions,
  signal: AbortSignal | undefined,
) => Promise<BrokerOutcome>;

function ipv4Octets(address: string): readonly number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : undefined;
}

function isRefusedIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** True when `address` (an IP literal, no brackets) is not a public unicast address. */
export function isRefusedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = ipv4Octets(address);
    return octets === undefined || isRefusedIpv4(octets);
  }
  if (version !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) {
    const octets = ipv4Octets(mapped[1]);
    return octets === undefined || isRefusedIpv4(octets);
  }
  const first = lower.split(':')[0] ?? '';
  const leading = first === '' ? 0 : Number.parseInt(first, 16);
  return (
    lower === '::' ||
    lower === '::1' ||
    (leading >= 0xfc00 && leading <= 0xfdff) ||
    (leading >= 0xfe80 && leading <= 0xfebf) ||
    leading >= 0xff00
  );
}

function isInternalName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return (
    !name.includes('.') ||
    name === 'localhost' ||
    ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa'].some((suffix) =>
      name.endsWith(suffix),
    )
  );
}

export async function defaultResolve(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/**
 * Whether a URL may be requested; resolution failures are left to the request
 * itself. Shared with the page audit, which applies it to every request an
 * outside page makes.
 */
export async function isAllowedTarget(
  url: URL,
  resolveAddresses: (hostname: string) => Promise<readonly string[]>,
): Promise<boolean> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|]$/g, '');
  if (isIP(host) !== 0) return !isRefusedAddress(host);
  if (isInternalName(host)) return false;
  try {
    const addresses = await resolveAddresses(host);
    return !addresses.some((address) => isRefusedAddress(address));
  } catch {
    return true;
  }
}

async function readBodyText(response: Response, maxChars: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const chunk: { done: boolean; value?: Uint8Array } = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.length >= maxChars) {
        await reader.cancel();
        return text.slice(0, maxChars);
      }
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function createSemaphore(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export function createExternalFetch(options: ExternalFetchOptions): ExternalFetch {
  const resolveAddresses = options.resolveAddresses ?? defaultResolve;
  const timeoutMs = options.timeoutMs ?? EXTERNAL_FETCH_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? EXTERNAL_FETCH_MAX_REDIRECTS;
  const maxChars = options.maxChars ?? EXTERNAL_FETCH_MAX_CHARS;
  const run = createSemaphore(options.concurrency ?? DEFAULT_REQUEST_CONCURRENCY);

  async function perform(
    rawUrl: string,
    request: BridgeRequestOptions,
    signal: AbortSignal | undefined,
  ): Promise<BrokerOutcome> {
    let current: URL;
    try {
      current = new URL(rawUrl);
    } catch {
      return { kind: 'blocked', reason: 'invalid_url' };
    }
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      return { kind: 'blocked', reason: 'invalid_url' };
    }

    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    const fetchImpl = await options.getFetch();

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (!(await isAllowedTarget(current, resolveAddresses))) {
        return { kind: 'blocked', reason: 'cross_origin' };
      }
      let response: Response;
      try {
        response = await fetchImpl(current.href, {
          method: request.method ?? 'GET',
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
          headers: { Accept: request.accept ?? DEFAULT_ACCEPT },
          signal: combined,
        });
      } catch (error) {
        if (signal?.aborted === true) return { kind: 'cancelled' };
        if (deadline.aborted) return { kind: 'timeout' };
        return {
          kind: 'network_error',
          message: error instanceof Error ? error.message.slice(0, 200) : 'request failed',
        };
      }

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel();
        if (hop === maxRedirects) return { kind: 'blocked', reason: 'redirect_blocked' };
        try {
          current = new URL(location, current);
        } catch {
          return { kind: 'blocked', reason: 'invalid_url' };
        }
        continue;
      }

      try {
        const bodyText = request.method === 'HEAD' ? '' : await readBodyText(response, maxChars);
        return {
          kind: 'response',
          status: response.status,
          contentType: response.headers.get('content-type'),
          bodyText,
        };
      } catch (error) {
        if (signal?.aborted === true) return { kind: 'cancelled' };
        if (deadline.aborted) return { kind: 'timeout' };
        return {
          kind: 'network_error',
          message: error instanceof Error ? error.message.slice(0, 200) : 'request failed',
        };
      }
    }
    return { kind: 'blocked', reason: 'redirect_blocked' };
  }

  return (url, request, signal) => run(() => perform(url, request, signal));
}
