import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { createAddonStore, readAddonDescriptor } from '../../../../src/main/addons/store';
import { createScratchDirs } from '../../../support/scratchDirs';

/**
 * The install store: one folder per id and version, installed atomically and
 * trimmed to the pinned version. Every rule below is about what is on disk after
 * a failure - a half-extracted add-on must never be loadable.
 */

const scratch = createScratchDirs('main-addons', 'store-');

afterEach(() => scratch.cleanup());

const PIN = { version: '1.0.0', apiVersion: 1 };

function archive(
  files: Record<string, string | Uint8Array>,
  descriptor = {
    id: 'page-audit',
    version: '1.0.0',
    kind: 'js' as const,
    apiVersion: 1,
    entry: 'index.js',
  },
): Uint8Array {
  return zipSync({
    'addon.json': strToU8(JSON.stringify(descriptor)),
    ...Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        name,
        typeof content === 'string' ? strToU8(content) : content,
      ]),
    ),
  });
}

function makeStore(): string {
  return path.join(scratch.create(), 'addons');
}

describe('createAddonStore', () => {
  it('installs an archive where the manager expects it, with its descriptor', () => {
    const root = makeStore();
    const store = createAddonStore({ root });

    const installed = store.installArchive(
      'page-audit',
      PIN,
      archive({ 'index.js': 'export {};' }),
    );

    expect(installed.dir).toBe(path.join(root, 'page-audit', '1.0.0'));
    expect(installed.descriptor).toMatchObject({ id: 'page-audit', version: '1.0.0' });
    expect(readFileSync(path.join(installed.dir, 'index.js'), 'utf8')).toBe('export {};');
    expect(store.readInstalled('page-audit', PIN)).toMatchObject({ dir: installed.dir });
  });

  it('keeps only the pinned version after a successful install', () => {
    const root = makeStore();
    const store = createAddonStore({ root });
    store.installArchive(
      'page-audit',
      { version: '0.9.0', apiVersion: 1 },
      archive(
        {},
        {
          id: 'page-audit',
          version: '0.9.0',
          kind: 'js',
          apiVersion: 1,
          entry: 'index.js',
        },
      ),
    );
    const stale = path.join(root, 'page-audit', '0.9.0');
    expect(existsSync(stale)).toBe(true);

    store.installArchive('page-audit', PIN, archive({ 'index.js': 'export {};' }));

    expect(existsSync(stale)).toBe(false);
    expect(store.readInstalled('page-audit', { version: '0.9.0', apiVersion: 1 })).toBeUndefined();
  });

  it('refuses an archive that is not a zip and leaves nothing installed', () => {
    const root = makeStore();
    const store = createAddonStore({ root });

    expect(() => store.installArchive('page-audit', PIN, strToU8('not a zip'))).toThrowError(
      /archive/,
    );
    expect(existsSync(path.join(root, 'page-audit', '1.0.0'))).toBe(false);
  });

  it.each([
    ['a different id', { id: 'another-addon' }, 'id'],
    ['a different version', { version: '2.0.0' }, 'version'],
    ['a different API version', { apiVersion: 2 }, 'apiVersion'],
  ])('refuses %s and leaves no partial folder', (_label, patch, reason) => {
    const root = makeStore();
    const store = createAddonStore({ root });
    const descriptor = {
      id: 'page-audit',
      version: '1.0.0',
      kind: 'js' as const,
      apiVersion: 1,
      entry: 'index.js',
      ...patch,
    };

    expect(() =>
      store.installArchive('page-audit', PIN, archive({ 'index.js': 'export {};' }, descriptor)),
    ).toThrowError(new RegExp(reason));
    expect(existsSync(path.join(root, 'page-audit', '1.0.0'))).toBe(false);
    expect(existsSync(path.join(root, 'page-audit', '1.0.0.partial'))).toBe(false);
  });

  it('refuses an entry that would escape the add-on folder', () => {
    const root = makeStore();
    const store = createAddonStore({ root });

    expect(() =>
      store.installArchive('page-audit', PIN, archive({ '../escape.js': 'x' })),
    ).toThrowError(/extract/);
    expect(existsSync(path.join(root, 'page-audit', '1.0.0'))).toBe(false);
  });

  it('does not treat a folder of another version as the pinned one', () => {
    const root = makeStore();
    const directory = path.join(root, 'page-audit', '2.0.0');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'addon.json'),
      JSON.stringify({
        id: 'page-audit',
        version: '2.0.0',
        kind: 'js',
        apiVersion: 1,
        entry: 'index.js',
      }),
    );

    expect(createAddonStore({ root }).readInstalled('page-audit', PIN)).toBeUndefined();
  });

  it('treats a malformed descriptor as "not an add-on folder"', () => {
    const directory = path.join(scratch.create(), 'broken');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'addon.json'), '{not json');

    expect(readAddonDescriptor(directory)).toBeUndefined();
  });
});
