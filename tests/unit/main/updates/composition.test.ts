import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readUpdateBuildInfo, resolveTargetAsar } from '../../../../src/main/updates/composition';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('updates-composition', 'upd-comp-');

afterEach(() => {
  scratch.cleanup();
});

function appWith(packageJson: string | undefined): string {
  const directory = scratch.create();
  if (packageJson !== undefined) writeFileSync(path.join(directory, 'package.json'), packageJson);
  return directory;
}

describe('readUpdateBuildInfo', () => {
  it('reads the built-in sources and the runtime generation', () => {
    const appPath = appWith(
      JSON.stringify({
        updates: { urls: ['https://github.com/o/r/tree/main/updates'], runtimeGeneration: 3 },
      }),
    );
    expect(readUpdateBuildInfo(appPath)).toEqual({
      urls: ['https://github.com/o/r/tree/main/updates'],
      runtimeGeneration: 3,
    });
  });

  it('defaults the generation to 1 when only the sources are given', () => {
    const appPath = appWith(JSON.stringify({ updates: { urls: ['https://x.example/u'] } }));
    expect(readUpdateBuildInfo(appPath).runtimeGeneration).toBe(1);
  });

  it.each([
    ['a missing file', undefined],
    ['malformed JSON', '{nope'],
    ['no updates block', JSON.stringify({ name: 'x' })],
    ['a wrongly-typed block', JSON.stringify({ updates: { urls: 'x' } })],
  ])('means no built-in sources for %s', (_label, content) => {
    const info = readUpdateBuildInfo(appWith(content));
    expect(info).toEqual({ urls: [], runtimeGeneration: 1 });
  });
});

describe('resolveTargetAsar', () => {
  const asar = path.join('install', 'resources', 'app.asar');

  it('targets the running archive of a packaged app', () => {
    expect(resolveTargetAsar({ isPackaged: true, appPath: asar, sandbox: undefined })).toBe(asar);
  });

  it('refuses a packaged app that is not running from an archive', () => {
    expect(
      resolveTargetAsar({ isPackaged: true, appPath: 'install/app', sandbox: undefined }),
    ).toBeUndefined();
  });

  it('is not updatable when unpackaged without a sandbox', () => {
    expect(
      resolveTargetAsar({ isPackaged: false, appPath: 'src', sandbox: undefined }),
    ).toBeUndefined();
    expect(resolveTargetAsar({ isPackaged: false, appPath: 'src', sandbox: '' })).toBeUndefined();
  });

  it('targets the sandbox install when unpackaged with one', () => {
    expect(resolveTargetAsar({ isPackaged: false, appPath: 'src', sandbox: 'scratch' })).toBe(
      path.join('scratch', 'resources', 'app.asar'),
    );
  });

  it('ignores the sandbox for a packaged app', () => {
    expect(resolveTargetAsar({ isPackaged: true, appPath: asar, sandbox: 'scratch' })).toBe(asar);
  });
});
