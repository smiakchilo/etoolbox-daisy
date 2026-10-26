import { gzipSync } from 'fflate';

/**
 * A minimal ustar writer, for tests that must feed the resolver a real `.tgz`
 * (an npm platform package) without shipping a 120 MB fixture.
 *
 * The reader under test only accepts what npm and GitHub actually emit, so the
 * writer is the same shape: 512-byte headers, octal sizes, a zero-block
 * terminator. It deliberately does not implement PAX/long names - the tests
 * that need those build the header by hand.
 */

const BLOCK = 512;

function writeText(block: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length && offset + index < block.length; index += 1) {
    block[offset + index] = text.charCodeAt(index);
  }
}

function header(name: string, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeText(block, 0, name);
  writeText(block, 100, '0000644');
  writeText(block, 108, '0000000');
  writeText(block, 116, '0000000');
  writeText(block, 124, size.toString(8).padStart(11, '0'));
  writeText(block, 136, '00000000000');
  writeText(block, 148, '        ');
  block[156] = '0'.charCodeAt(0);
  writeText(block, 257, 'ustar');
  writeText(block, 263, '00');

  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeText(block, 148, checksum.toString(8).padStart(6, '0'));
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

function padded(bytes: Uint8Array): Uint8Array {
  const blocks = Math.ceil(bytes.byteLength / BLOCK);
  const out = new Uint8Array(blocks * BLOCK);
  out.set(bytes, 0);
  return out;
}

/** A gzip'd tar holding exactly `entries`, in the given order. */
export function tarGz(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    parts.push(header(name, bytes.byteLength), padded(bytes));
  }
  parts.push(new Uint8Array(BLOCK * 2));

  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.byteLength;
  }
  return gzipSync(tar);
}
