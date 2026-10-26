import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { readTarGzEntry } from '../../../../../src/agents/copilot/cli/tar';
import { tarGz } from '../../../../support/tarGz';

/**
 * The reader takes exactly one file out of an npm platform package and returns
 * its bytes. It never writes, so an archive entry cannot steer a path - the
 * only failure modes are "not there", "not a tarball" and "too big".
 */

describe('readTarGzEntry', () => {
  it('returns the requested file’s bytes', () => {
    const archive = tarGz({
      'package/package.json': '{"name":"@github/copilot-win32-x64"}',
      'package/copilot.exe': 'the binary',
    });

    expect(new TextDecoder().decode(readTarGzEntry(archive, 'copilot.exe', 1024))).toBe(
      'the binary',
    );
  });

  it('matches the file by name whatever directory the packer used', () => {
    const archive = tarGz({ 'some/other/prefix/copilot': 'mac binary' });

    expect(new TextDecoder().decode(readTarGzEntry(archive, 'copilot', 1024))).toBe('mac binary');
  });

  it('answers undefined when the file is absent', () => {
    const archive = tarGz({ 'package/index.js': 'export {};' });

    expect(readTarGzEntry(archive, 'copilot.exe', 1024)).toBeUndefined();
  });

  it('refuses an entry that claims more than the caller allows', () => {
    const archive = tarGz({ 'package/copilot.exe': strToU8('x'.repeat(2048)) });

    expect(readTarGzEntry(archive, 'copilot.exe', 1024)).toBeUndefined();
  });

  it('answers undefined for bytes that are not a gzip’d tar', () => {
    expect(readTarGzEntry(strToU8('not an archive'), 'copilot.exe', 1024)).toBeUndefined();
  });

  it('stops at the end-of-archive marker instead of reading on', () => {
    const archive = tarGz({ 'package/copilot.exe': 'binary' });

    // Truncating the gzip body makes it undecodable rather than making the
    // reader invent an entry.
    expect(
      readTarGzEntry(archive.subarray(0, archive.byteLength - 8), 'copilot.exe', 1024),
    ).toBeUndefined();
  });
});
