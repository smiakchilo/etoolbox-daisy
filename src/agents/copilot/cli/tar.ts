import { gunzipSync } from 'fflate';

/**
 * Reads one file out of an npm package tarball (`.tgz`).
 *
 * The Copilot CLI is published as a platform npm package whose whole point is
 * the executable at its root, so the resolver only ever needs one entry. That
 * keeps this small: no extraction to disk, no symlinks, no mode bits - the
 * bytes are returned and the caller writes them under a name it chose. An
 * archive entry therefore cannot steer a path; the only thing it can do is not
 * match.
 *
 * The tar reader is the ustar subset npm produces (plus GNU long names, which
 * some packers emit), and every declared size is checked against the caller's
 * ceiling before any byte is copied.
 */

const BLOCK = 512;
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const TYPE_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

/** Bounds a malformed or hostile archive: real packages hold a few thousand. */
const MAX_ENTRIES = 20_000;

function field(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  const text = new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
  return text.trim();
}

function octal(text: string): number | undefined {
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) return undefined;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The bytes of the first entry whose base name is `fileName`, or `undefined`.
 *
 * `maxBytes` is the caller's ceiling for that single file; an entry claiming
 * more is refused rather than read.
 */
export function readTarGzEntry(
  archive: Uint8Array,
  fileName: string,
  maxBytes: number,
): Uint8Array | undefined {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(archive);
  } catch {
    return undefined;
  }

  let offset = 0;
  let longName: string | undefined;
  for (let entry = 0; entry < MAX_ENTRIES && offset + BLOCK <= tar.byteLength; entry += 1) {
    const header = tar.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks end the archive; a single one is enough here.
    if (header.every((byte) => byte === 0)) return undefined;

    const size = octal(field(header, SIZE_OFFSET, SIZE_LENGTH));
    if (size === undefined) return undefined;
    const type = String.fromCharCode(header[TYPE_OFFSET] ?? 0).replace('\0', '') || '0';
    const name = field(header, NAME_OFFSET, NAME_LENGTH);
    const prefix = field(header, PREFIX_OFFSET, PREFIX_LENGTH);
    const dataOffset = offset + BLOCK;
    const nextOffset = dataOffset + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') {
      // GNU long name: the name is the entry's own payload, applied to the next.
      longName = new TextDecoder()
        .decode(tar.subarray(dataOffset, dataOffset + size))
        .replace(/\0+$/, '');
      offset = nextOffset;
      continue;
    }
    if (type === 'x') {
      // PAX extended header: `path=` is the only key we need.
      const body = new TextDecoder().decode(tar.subarray(dataOffset, dataOffset + size));
      const match = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(body);
      if (match?.[1] !== undefined) longName = match[1];
      offset = nextOffset;
      continue;
    }

    const fullName = longName ?? (prefix === '' ? name : `${prefix}/${name}`);
    longName = undefined;
    const isFile = type === '0' || type === '\0' || type === '' || type === '7';
    if (isFile && (fullName === `package/${fileName}` || fullName.split('/').at(-1) === fileName)) {
      if (size > maxBytes) return undefined;
      return tar.subarray(dataOffset, dataOffset + size);
    }
    offset = nextOffset;
  }
  return undefined;
}
