import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  fileUrlIn,
  platformKey,
  resolveFolderUrl,
  updateManifestSchema,
} from '../../../../src/main/updates/manifest';

const HASH = 'a'.repeat(128);

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0);
  });
});

describe('platformKey', () => {
  it('joins platform and arch', () => {
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
  });
});

describe('resolveFolderUrl', () => {
  it('rewrites a GitHub tree page to the raw-content host', () => {
    const url = resolveFolderUrl('https://github.com/acme/app/tree/master/updates');
    expect(url?.href).toBe('https://raw.githubusercontent.com/acme/app/master/updates/');
  });

  it('keeps other https folders and ends them with a slash', () => {
    expect(resolveFolderUrl('https://example.com/dist')?.href).toBe('https://example.com/dist/');
  });

  it.each(['http://example.com/dist', 'file:///C:/dist', 'not a url', ''])(
    'refuses %j',
    (value) => {
      expect(resolveFolderUrl(value)).toBeUndefined();
    },
  );

  it('drops a query and fragment', () => {
    expect(resolveFolderUrl('https://example.com/dist?token=1#x')?.href).toBe(
      'https://example.com/dist/',
    );
  });
});

describe('fileUrlIn', () => {
  it('resolves a file inside the folder and encodes its name', () => {
    const folder = new URL('https://example.com/dist/');
    expect(fileUrlIn(folder, 'a b.json').href).toBe('https://example.com/dist/a%20b.json');
  });
});

describe('updateManifestSchema', () => {
  const valid = {
    version: '1.2.3',
    files: { 'win32-x64': { name: 'app.asar', sha512: HASH, size: 10 } },
  };

  it('tolerates unknown fields', () => {
    const parsed = updateManifestSchema.parse({ ...valid, extra: true });
    expect(parsed.version).toBe('1.2.3');
  });

  it('carries the runtime layer an archive needs', () => {
    const parsed = updateManifestSchema.parse({
      ...valid,
      files: {
        'win32-x64': {
          name: 'app.asar',
          sha512: HASH,
          size: 10,
          runtime: { format: 1, electron: '44.9.3', payload: 'b'.repeat(32) },
        },
      },
    });
    expect(parsed.files['win32-x64']?.runtime).toEqual({
      format: 1,
      electron: '44.9.3',
      payload: 'b'.repeat(32),
    });
  });

  it('leaves the runtime absent when the archive names none', () => {
    expect(updateManifestSchema.parse(valid).files['win32-x64']?.runtime).toBeUndefined();
  });

  it.each([
    ['an unknown descriptor format', { format: 2, electron: '44.9.3', payload: 'b'.repeat(32) }],
    ['a truncated payload hash', { format: 1, electron: '44.9.3', payload: 'b' }],
    ['a payload that is not a hash', { format: 1, electron: '44.9.3', payload: 'z'.repeat(32) }],
    ['a non-version Electron', { format: 1, electron: 'latest', payload: 'b'.repeat(32) }],
    [
      'an unknown runtime key',
      { format: 1, electron: '44.9.3', payload: 'b'.repeat(32), extra: true },
    ],
  ])('rejects a runtime descriptor with %s', (_label, runtime) => {
    const manifest = {
      ...valid,
      files: { 'win32-x64': { name: 'app.asar', sha512: HASH, size: 10, runtime } },
    };
    expect(updateManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it.each([
    ['a non-numeric version', { ...valid, version: 'latest' }],
    [
      'a file name with a path',
      { ...valid, files: { k: { name: '../x', sha512: HASH, size: 1 } } },
    ],
    ['a short hash', { ...valid, files: { k: { name: 'a', sha512: 'abc', size: 1 } } }],
    ['an oversized archive', { ...valid, files: { k: { name: 'a', sha512: HASH, size: 1e12 } } }],
  ])('rejects %s', (_label, manifest) => {
    expect(updateManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
