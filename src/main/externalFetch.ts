import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, type Dispatcher } from 'undici';
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
 *
 * **Resolution fails closed.** A name that cannot be resolved, or that resolves
 * to no address at all, is refused - it is never left to the request to decide,
 * because "the resolver had a bad moment" must not become "connect anyway".
 *
 * **The checked address is the connected address.** A public-looking name is
 * resolved once per hop and every answer is validated; the request then connects
 * through a dispatcher whose own lookup returns only those validated addresses,
 * so a DNS server cannot answer "public" for our check and "loopback" for the
 * connection (DNS rebinding). The URL's host stays the Host header and the TLS
 * servername - only the address behind it is pinned.
 *
 * **A proxy changes who enforces the address policy.** When the transport is
 * reached through the user's configured proxy (`ExternalFetchTransport.proxied`),
 * the proxy resolves the name and opens the connection, so this module cannot
 * pin anything; only the literal-IP and internal-name checks still apply and
 * address policy is delegated to the proxy. That is a deliberate, documented
 * limit - see `ToolHost.externalFetch` and `docs/compatibility.md` §11.8.
 *
 * A 3xx with no `Location` is returned as an ordinary response: nothing can be
 * followed, and an empty redirect is still an answer.
 */

export const EXTERNAL_FETCH_TIMEOUT_MS = 30_000;
export const EXTERNAL_FETCH_MAX_REDIRECTS = 5;
/** One more byte than `http_fetch`'s largest body limit, so the tool can see a body was cut. */
export const EXTERNAL_FETCH_MAX_BYTES = 5_000_001;
/** A stable, truthful identifier; no version, so it never becomes a tracking signal of its own. */
export const EXTERNAL_FETCH_USER_AGENT = 'etoolbox-daisy';

const DEFAULT_ACCEPT = 'application/json, text/plain;q=0.9, */*;q=0.8';

/** What `getTransport` answers: the fetch to use, and whether a proxy resolves the address. */
export interface ExternalFetchTransport {
  readonly fetch: AgentFetch;
  /** True when `fetch` reaches the network through a proxy, so this module cannot pin the address. */
  readonly proxied: boolean;
}

export interface ExternalFetchOptions {
  /** Resolved per request, so a proxy change applies without a restart. */
  readonly getTransport: () => Promise<ExternalFetchTransport>;
  /** Every address a name resolves to; a failure or an empty answer means "refused". */
  readonly resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  /** Replaceable so a unit test can prove the pinned address without opening a socket. */
  readonly createDispatcher?: (addresses: readonly string[]) => Dispatcher;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
  readonly concurrency?: number;
}

export type ExternalFetch = (
  url: string,
  options: BridgeRequestOptions,
  signal: AbortSignal | undefined,
  /** The caller's own body ceiling in bytes; the smaller of this and `maxBytes` wins. */
  maxBytes?: number,
) => Promise<BrokerOutcome>;

/**
 * The IPv4 ranges that are never a public unicast destination: this network,
 * private use, shared address space, loopback, link-local, the documentation and
 * benchmark blocks, multicast and the reserved top quarter.
 */
const REFUSED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const REFUSED_IPV4 = new BlockList();
for (const [network, prefix] of REFUSED_IPV4_RANGES) {
  REFUSED_IPV4.addSubnet(network, prefix, 'ipv4');
}

function ipv4Octets(address: string): readonly number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : undefined;
}

/** One half of an IPv6 address, as 16-bit words; an empty half is `[]`. */
function parseIpv6Words(text: string): number[] | undefined {
  if (text === '') return [];
  const pieces = text.split(':');
  const words: number[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index] ?? '';
    if (index === pieces.length - 1 && piece.includes('.')) {
      const octets = ipv4Octets(piece);
      if (octets === undefined) return undefined;
      words.push(
        ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
        ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
      );
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
    words.push(Number.parseInt(piece, 16));
  }
  return words;
}

/** An IPv6 address as 16 bytes, or `undefined` when it does not parse. */
function ipv6Bytes(address: string): readonly number[] | undefined {
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const head = parseIpv6Words(halves[0] ?? '');
  if (head === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = parseIpv6Words(halves[1] ?? '');
  if (tail === undefined) return undefined;
  if (head.length + tail.length > 8) return undefined;
  const words = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  return words.flatMap((word) => [(word >> 8) & 0xff, word & 0xff]);
}

function isRefusedIpv4Octets(octets: readonly [number, number, number, number]): boolean {
  return REFUSED_IPV4.check(octets.join('.'), 'ipv4');
}

function embeddedIpv4(bytes: readonly number[], offset: number): [number, number, number, number] {
  return [
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  ];
}

function allZero(bytes: readonly number[], start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function isRefusedIpv6(bytes: readonly number[]): boolean {
  const [first = 0, second = 0, third = 0, fourth = 0] = bytes;
  if (allZero(bytes, 0, 16)) return true; // `::` (unspecified)
  // `::a.b.c.d` (IPv4-compatible), `::ffff:a.b.c.d` (IPv4-mapped, decimal or hex
  // words) and `::1` all live here: the low 32 bits are an IPv4 address.
  if (allZero(bytes, 0, 10)) return isRefusedIpv4Octets(embeddedIpv4(bytes, 12));
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  if ((first & 0xfe) === 0xfc) return true;
  if (first === 0xfe && (second & 0xc0) === 0x80) return true;
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true;
  if (first === 0xff) return true;
  // 2001:db8::/32 documentation.
  if (first === 0x20 && second === 0x01 && third === 0x0d && fourth === 0xb8) return true;
  // 2001:0000::/32 Teredo: its client address is obfuscated, so the whole block goes.
  if (first === 0x20 && second === 0x01 && third === 0x00 && fourth === 0x00) return true;
  // 6to4 2002::/16 embeds the IPv4 destination in bytes 2-5.
  if (first === 0x20 && second === 0x02) return isRefusedIpv4Octets(embeddedIpv4(bytes, 2));
  // NAT64 64:ff9b::/96 embeds the IPv4 destination in the low 32 bits.
  if (
    first === 0x00 &&
    second === 0x64 &&
    third === 0xff &&
    fourth === 0x9b &&
    allZero(bytes, 4, 12)
  ) {
    return isRefusedIpv4Octets(embeddedIpv4(bytes, 12));
  }
  return false;
}

/** True when `address` (an IP literal, no brackets) is not a public unicast address. */
export function isRefusedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = ipv4Octets(address);
    if (octets === undefined) return true;
    return isRefusedIpv4Octets([octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0]);
  }
  if (version !== 6) return true;
  const bytes = ipv6Bytes(address);
  return bytes === undefined || isRefusedIpv6(bytes);
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

/** What `inspectTarget` decided, including the addresses a name was resolved to. */
export interface TargetInspection {
  readonly allowed: boolean;
  /** The validated addresses, present only when a name had to be resolved. */
  readonly addresses?: readonly string[];
}

/**
 * Whether a URL may be requested, resolved once so the caller can connect to the
 * very addresses that were checked. With no resolver the address policy is
 * delegated to a proxy: only literal addresses and internal-looking names are
 * still examined. Shared with the page audit, which applies it to every request
 * an outside page makes (there Chromium resolves the name itself, so it can only
 * be a best-effort check).
 */
export async function inspectTarget(
  url: URL,
  resolveAddresses: ((hostname: string) => Promise<readonly string[]>) | undefined,
): Promise<TargetInspection> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { allowed: false };
  const host = url.hostname.replace(/^\[|]$/g, '');
  if (isIP(host) !== 0) return { allowed: !isRefusedAddress(host) };
  if (isInternalName(host)) return { allowed: false };
  if (resolveAddresses === undefined) return { allowed: true };
  let addresses: readonly string[];
  try {
    addresses = await resolveAddresses(host);
  } catch {
    return { allowed: false };
  }
  if (addresses.length === 0) return { allowed: false };
  if (addresses.some((address) => isRefusedAddress(address))) return { allowed: false };
  return { allowed: true, addresses };
}

/** Whether a URL may be requested; a resolution failure is a refusal. */
export async function isAllowedTarget(
  url: URL,
  resolveAddresses: (hostname: string) => Promise<readonly string[]>,
): Promise<boolean> {
  return (await inspectTarget(url, resolveAddresses)).allowed;
}

/**
 * A `net.connect`/`tls.connect` lookup that answers with the addresses already
 * validated for this hop and never performs a resolution of its own - which is
 * what makes the check and the connection the same answer.
 *
 * Exported so a unit test can prove the property directly: a second resolver
 * answer can never reach the socket because there is no second resolution.
 */
export function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  const pinned = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, pinned);
      return;
    }
    const first = pinned[0];
    if (first === undefined) {
      callback(new Error('No validated address'), '');
      return;
    }
    callback(null, first.address, first.family);
  };
}

interface BodyRead {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Reads the response body up to `maxBytes` **of decoded bytes** - a compressed
 * stream expands before it arrives here, so the cap has to be at this end - and
 * stops the transfer at the limit instead of draining a body nobody will read.
 * A declared `Content-Length` above the limit refuses the read outright.
 */
async function readBodyText(response: Response, maxBytes: number): Promise<BodyRead> {
  if (response.body === null) return { text: '', truncated: false };
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    return { text: '', truncated: true };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const chunk: { done: boolean; value?: Uint8Array } = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (value === undefined) continue;
      const room = maxBytes - bytes;
      if (value.byteLength > room) {
        text += decoder.decode(value.subarray(0, room), { stream: true });
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= maxBytes) {
        // One more read distinguishes "exactly at the cap" from "more to come".
        const next = await reader.read();
        if (!next.done) {
          truncated = true;
          await reader.cancel().catch(() => undefined);
        }
        break;
      }
    }
    if (!truncated) text += decoder.decode();
    return { text, truncated };
  } finally {
    reader.releaseLock();
  }
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

/**
 * A FIFO limiter. A slot is taken synchronously (before any `await`), so two
 * callers can never both see a free slot; a waiter whose signal aborts leaves
 * the queue instead of holding a place nobody will use.
 */
function createSemaphore(
  limit: number,
): <T>(task: () => Promise<T>, signal: AbortSignal) => Promise<T> {
  let active = 0;
  const waiting: Waiter[] = [];

  function release(): void {
    const next = waiting.shift();
    if (next === undefined) {
      active -= 1;
      return;
    }
    // The slot is handed over as-is: `active` stays the same and the waiter
    // resumes inside `run`, never returning to the queue.
    next.signal.removeEventListener('abort', next.onAbort);
    next.resolve();
  }

  return async (task, signal) => {
    if (signal.aborted) throw signal.reason;
    if (active < limit) {
      active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          signal,
          onAbort: () => {
            const index = waiting.indexOf(waiter);
            if (index !== -1) waiting.splice(index, 1);
            // The reason is never read: the caller maps an abort to a
            // `cancelled`/`timeout` outcome, and `signal.reason` can be `any`.
            reject(new Error('The request was cancelled while it waited'));
          },
        };
        waiting.push(waiter);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      });
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function requestInit(
  request: BridgeRequestOptions,
  combined: AbortSignal,
  dispatcher: Dispatcher | undefined,
): RequestInit {
  const init: RequestInit = {
    method: request.method ?? 'GET',
    redirect: 'manual',
    // Node's fetch has no cookie jar, so `omit` changes nothing; it stays to
    // state the intent next to `cache`, on a request that must carry no session.
    credentials: 'omit',
    cache: 'no-store',
    headers: {
      Accept: request.accept ?? DEFAULT_ACCEPT,
      'User-Agent': EXTERNAL_FETCH_USER_AGENT,
    },
    signal: combined,
  };
  if (dispatcher === undefined) return init;
  // `dispatcher` is Node's (undici) extension to `RequestInit`, not a DOM field.
  return { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher };
}

export function createExternalFetch(options: ExternalFetchOptions): ExternalFetch {
  const resolveAddresses = options.resolveAddresses ?? defaultResolve;
  const timeoutMs = options.timeoutMs ?? EXTERNAL_FETCH_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? EXTERNAL_FETCH_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? EXTERNAL_FETCH_MAX_BYTES;
  const createDispatcher =
    options.createDispatcher ??
    ((addresses: readonly string[]): Dispatcher =>
      new Agent({ connect: { lookup: createPinnedLookup(addresses) } }));
  const run = createSemaphore(options.concurrency ?? DEFAULT_REQUEST_CONCURRENCY);

  async function perform(
    rawUrl: string,
    request: BridgeRequestOptions,
    callerSignal: AbortSignal | undefined,
    deadline: AbortSignal,
    combined: AbortSignal,
    bodyLimit: number,
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

    const transport = await options.getTransport();
    // A proxy resolves the name, so this module can only examine literals and
    // internal-looking names; the proxy's own policy decides the rest.
    const resolver = transport.proxied ? undefined : resolveAddresses;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const target = await inspectTarget(current, resolver);
      if (!target.allowed) {
        return { kind: 'blocked', reason: 'cross_origin' };
      }
      const dispatcher =
        target.addresses === undefined ? undefined : createDispatcher(target.addresses);
      try {
        let response: Response;
        try {
          response = await transport.fetch(
            current.href,
            requestInit(request, combined, dispatcher),
          );
        } catch (error) {
          if (callerSignal?.aborted === true) return { kind: 'cancelled' };
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
          const body =
            request.method === 'HEAD'
              ? { text: '', truncated: false }
              : await readBodyText(response, bodyLimit);
          return {
            kind: 'response',
            status: response.status,
            contentType: response.headers.get('content-type'),
            bodyText: body.text,
            ...(body.truncated ? { truncated: true } : {}),
          };
        } catch (error) {
          if (callerSignal?.aborted === true) return { kind: 'cancelled' };
          if (deadline.aborted) return { kind: 'timeout' };
          return {
            kind: 'network_error',
            message: error instanceof Error ? error.message.slice(0, 200) : 'request failed',
          };
        }
      } finally {
        // The body has been read (or abandoned) by now; the pinned connection
        // is not reused across hops, because each hop has its own addresses.
        void dispatcher?.destroy();
      }
    }
    return { kind: 'blocked', reason: 'redirect_blocked' };
  }

  return async (url, request, signal, callerMaxBytes) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    const bodyLimit = Math.min(maxBytes, callerMaxBytes ?? maxBytes);
    try {
      return await run(
        () => perform(url, request, signal, deadline, combined, bodyLimit),
        combined,
      );
    } catch {
      // Only the semaphore rejects - a waiter whose signal aborted while queued.
      if (signal?.aborted === true) return { kind: 'cancelled' };
      return { kind: 'timeout' };
    }
  };
}
