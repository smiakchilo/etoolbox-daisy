import { createHash, timingSafeEqual } from 'node:crypto';

import type { AgentFetch } from '../../shared';

/**
 * The one verified download the application performs - for an in-app update and
 * for an add-on. Both are "an archive named by a manifest, checked against a
 * sha512 and a size before it is used", so the hashing rule lives here once.
 */

/** What a manifest promised about one archive. */
export interface ArchiveExpectation {
  /** Hex sha512 of the archive's bytes. */
  readonly sha512: string;
  /** Exact byte length. */
  readonly size: number;
}

export type ArchiveVerdict = 'ok' | 'hash' | 'size';

/** Compares downloaded bytes with the manifest's hash and size. Never throws. */
export function verifyArchive(bytes: Uint8Array, expected: ArchiveExpectation): ArchiveVerdict {
  if (bytes.byteLength !== expected.size) return 'size';
  const actual = createHash('sha512').update(bytes).digest();
  let claimed: Buffer;
  try {
    claimed = Buffer.from(expected.sha512, 'hex');
  } catch {
    return 'hash';
  }
  if (claimed.length !== actual.length || !timingSafeEqual(actual, claimed)) return 'hash';
  return 'ok';
}

export interface DownloadVerifiedOptions {
  readonly timeoutMs: number;
  /** Called with 0..1 as the body arrives; the caller renders it. */
  readonly onProgress?: (fraction: number) => void;
  /** The caller's cancellation. */
  readonly signal?: AbortSignal | undefined;
  /** A byte ceiling; a larger declared length is refused before reading. */
  readonly maxBytes?: number;
}

export class ArchiveDownloadError extends Error {
  constructor(
    readonly reason: 'refused' | 'hash' | 'size' | 'network' | 'cancelled',
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'ArchiveDownloadError';
  }
}

/**
 * Downloads one archive and returns its bytes only when they match the
 * manifest. A response that is not `https` is refused: an update or an add-on is
 * never fetched over plain HTTP, whatever a configured URL says.
 *
 * The body is read as a stream so progress can be reported; a null body (an
 * unusual fetch implementation or a test double) falls back to `arrayBuffer`.
 */
export async function downloadVerifiedArchive(
  fetchFn: AgentFetch,
  url: URL,
  expected: ArchiveExpectation,
  options: DownloadVerifiedOptions,
): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response: Response;
  try {
    response = await fetchFn(url, { signal });
  } catch (error) {
    if (options.signal?.aborted === true) throw new ArchiveDownloadError('cancelled');
    throw new ArchiveDownloadError(
      'network',
      error instanceof Error ? error.message.slice(0, 200) : undefined,
    );
  }
  if (!response.ok || !response.url.startsWith('https:')) {
    throw new ArchiveDownloadError('refused');
  }
  const declared = Number(response.headers.get('content-length'));
  if (options.maxBytes !== undefined && Number.isFinite(declared) && declared > options.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ArchiveDownloadError('size');
  }
  const bytes =
    response.body === null
      ? new Uint8Array(await response.arrayBuffer())
      : await readBodyWithProgress(response, expected.size, options);
  const verdict = verifyArchive(bytes, expected);
  if (verdict !== 'ok') throw new ArchiveDownloadError(verdict);
  return bytes;
}

async function readBodyWithProgress(
  response: Response,
  expectedSize: number,
  options: DownloadVerifiedOptions,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array(await response.arrayBuffer());
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const total = expectedSize > 0 ? expectedSize : undefined;
  let oversized = false;
  options.onProgress?.(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      received += value.byteLength;
      if (total !== undefined) {
        options.onProgress?.(Math.min(1, received / total));
      }
      if (options.maxBytes !== undefined && received > options.maxBytes) {
        oversized = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    if (options.signal?.aborted === true) throw new ArchiveDownloadError('cancelled');
    throw new ArchiveDownloadError(
      'network',
      error instanceof Error ? error.message.slice(0, 200) : undefined,
    );
  } finally {
    reader.releaseLock();
  }
  if (oversized) throw new ArchiveDownloadError('size');
  options.onProgress?.(1);
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
