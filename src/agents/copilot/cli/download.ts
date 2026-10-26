import { createHash, timingSafeEqual } from 'node:crypto';
import type { AgentFetch } from '../../../shared';

/**
 * The agent's own verified download of GitHub's release asset.
 *
 * Deliberately inside the agent rather than reusing the application's updater
 * helper: the CLI is this agent's third-party dependency, and an agent folder
 * may import nothing from `src/main` (AGENTS §7 rule 2). The verification rules
 * are the same shape as the application's - https only, a byte ceiling, a
 * digest compared in constant time, progress streamed - and the digest is the
 * one *GitHub* published for that asset, not one of ours.
 */

export interface CliArchiveDigest {
  /** Hex sha256, as the release API publishes it. */
  readonly sha256: string;
  /** Exact byte length. */
  readonly size: number;
}

export type CliDownloadFailure = 'refused' | 'hash' | 'size' | 'network' | 'cancelled';

export class CliDownloadError extends Error {
  constructor(
    readonly reason: CliDownloadFailure,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'CliDownloadError';
  }
}

export interface CliDownloadOptions {
  readonly timeoutMs: number;
  /** A byte ceiling; a larger declared length is refused before reading. */
  readonly maxBytes: number;
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal | undefined;
}

/** Downloads `url` and returns its bytes only when they match `expected`. */
export async function downloadVerifiedCliFile(
  fetchFn: AgentFetch,
  url: URL,
  expected: CliArchiveDigest,
  options: CliDownloadOptions,
): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response: Response;
  try {
    response = await fetchFn(url, { signal });
  } catch (error) {
    if (options.signal?.aborted === true) throw new CliDownloadError('cancelled');
    throw new CliDownloadError(
      'network',
      error instanceof Error ? error.message.slice(0, 200) : undefined,
    );
  }
  if (!response.ok || !response.url.startsWith('https:')) {
    throw new CliDownloadError('refused');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new CliDownloadError('size');
  }

  const bytes = await readBody(response, expected.size, options);
  if (bytes.byteLength !== expected.size) throw new CliDownloadError('size');
  if (!matches(bytes, expected.sha256)) throw new CliDownloadError('hash');
  return bytes;
}

function matches(bytes: Uint8Array, expectedHex: string): boolean {
  let claimed: Buffer;
  try {
    claimed = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  const actual = createHash('sha256').update(bytes).digest();
  return claimed.length === actual.length && timingSafeEqual(actual, claimed);
}

async function readBody(
  response: Response,
  expectedSize: number,
  options: CliDownloadOptions,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array(await response.arrayBuffer());
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let oversized = false;
  options.onProgress?.(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      received += value.byteLength;
      if (expectedSize > 0) options.onProgress?.(Math.min(1, received / expectedSize));
      if (received > options.maxBytes) {
        oversized = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    if (options.signal?.aborted === true) throw new CliDownloadError('cancelled');
    throw new CliDownloadError(
      'network',
      error instanceof Error ? error.message.slice(0, 200) : undefined,
    );
  } finally {
    reader.releaseLock();
  }
  if (oversized) throw new CliDownloadError('size');
  options.onProgress?.(1);
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
