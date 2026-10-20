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

  it('defaults minInstalled and tolerates unknown fields', () => {
    const parsed = updateManifestSchema.parse({ ...valid, extra: true });
    expect(parsed.files['win32-x64']?.minInstalled).toBe(0);
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
