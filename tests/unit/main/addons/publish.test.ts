import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addonCatalogSchema } from '../../../../src/main/addons/manifest';
import { createScratchDirs } from '../../../support/scratchDirs';

/**
 * The publish step's catalogue merge (`scripts/merge-addons.mjs`, run by
 * `.github/workflows/publish-update.yml`). What the workflow writes must be
 * readable by the build's own `addonCatalogSchema` - a mistake there would reach
 * installs as "the add-on could not be downloaded".
 */

const scratch = createScratchDirs('main-addons', 'publish-');
const script = path.resolve(__dirname, '../../../../scripts/merge-addons.mjs');

afterEach(() => scratch.cleanup());

function archive(id: string, identity: string): unknown {
  return { file: `${id}-${identity}.zip`, sha512: 'a'.repeat(128), size: 1024 };
}

function writePart(directory: string, key: string, addons: unknown): void {
  writeFileSync(path.join(directory, `addons.${key}.json`), JSON.stringify({ addons }));
}

const FIRST = '0123456789abcdef';
const SECOND = 'fedcba9876543210';

describe('merge-addons.mjs', () => {
  it('folds every platform and keeps an older published identity', () => {
    const directory = scratch.create();
    writePart(directory, 'win32-x64', {
      'page-audit': { [FIRST]: { platforms: { any: archive('page-audit', FIRST) } } },
      'another-addon': { [FIRST]: { platforms: { 'win32-x64': archive('another-addon', FIRST) } } },
    });
    writePart(directory, 'darwin-arm64', {
      'page-audit': { [FIRST]: { platforms: { any: archive('page-audit', FIRST) } } },
      'another-addon': {
        [FIRST]: { platforms: { 'darwin-arm64': archive('another-addon', FIRST) } },
        [SECOND]: { platforms: { 'darwin-arm64': archive('another-addon', SECOND) } },
      },
    });

    execFileSync(process.execPath, [script, directory], { stdio: 'pipe' });

    const merged = addonCatalogSchema.parse(
      JSON.parse(readFileSync(path.join(directory, 'addons.json'), 'utf8')),
    );
    expect(merged.addons['another-addon']?.[FIRST]?.platforms).toHaveProperty('win32-x64');
    expect(merged.addons['another-addon']?.[FIRST]?.platforms).toHaveProperty('darwin-arm64');
    expect(merged.addons['another-addon']?.[SECOND]?.platforms).toHaveProperty('darwin-arm64');
    expect(merged.addons['page-audit']?.[FIRST]?.platforms).toHaveProperty('any');
  });

  it('fails when there is no per-platform catalogue', () => {
    const directory = scratch.create();

    expect(() => execFileSync(process.execPath, [script, directory], { stdio: 'pipe' })).toThrow();
  });

  it('fails when two runners publish different bytes for the same platform', () => {
    const directory = scratch.create();
    writePart(directory, 'win32-x64', {
      'page-audit': { [FIRST]: { platforms: { any: archive('page-audit', FIRST) } } },
    });
    writePart(directory, 'darwin-arm64', {
      'page-audit': {
        [FIRST]: {
          platforms: {
            any: { file: 'page-audit-other.zip', sha512: 'b'.repeat(128), size: 2048 },
          },
        },
      },
    });

    expect(() => execFileSync(process.execPath, [script, directory], { stdio: 'pipe' })).toThrow();
  });
});
