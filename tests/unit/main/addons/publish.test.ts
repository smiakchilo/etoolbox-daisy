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

function archive(id: string, version: string): unknown {
  return { file: `${id}-${version}.zip`, sha512: 'a'.repeat(128), size: 1024 };
}

function writePart(directory: string, key: string, addons: unknown): void {
  writeFileSync(path.join(directory, `addons.${key}.json`), JSON.stringify({ addons }));
}

describe('merge-addons.mjs', () => {
  it('folds every platform and keeps an older published version', () => {
    const directory = scratch.create();
    writePart(directory, 'win32-x64', {
      'page-audit': { '1.0.0': { platforms: { any: archive('page-audit', '1.0.0') } } },
      'copilot-cli': { '1.0.83': { platforms: { 'win32-x64': archive('copilot-cli', '1.0.83') } } },
    });
    writePart(directory, 'darwin-arm64', {
      'page-audit': { '1.0.0': { platforms: { any: archive('page-audit', '1.0.0') } } },
      'copilot-cli': {
        '1.0.83': { platforms: { 'darwin-arm64': archive('copilot-cli', '1.0.83') } },
        '1.0.80': { platforms: { 'darwin-arm64': archive('copilot-cli', '1.0.80') } },
      },
    });

    execFileSync(process.execPath, [script, directory], { stdio: 'pipe' });

    const merged = addonCatalogSchema.parse(
      JSON.parse(readFileSync(path.join(directory, 'addons.json'), 'utf8')),
    );
    expect(merged.addons['copilot-cli']?.['1.0.83']?.platforms).toHaveProperty('win32-x64');
    expect(merged.addons['copilot-cli']?.['1.0.83']?.platforms).toHaveProperty('darwin-arm64');
    expect(merged.addons['copilot-cli']?.['1.0.80']?.platforms).toHaveProperty('darwin-arm64');
    expect(merged.addons['page-audit']?.['1.0.0']?.platforms).toHaveProperty('any');
  });

  it('fails when there is no per-platform catalogue', () => {
    const directory = scratch.create();

    expect(() => execFileSync(process.execPath, [script, directory], { stdio: 'pipe' })).toThrow();
  });
});
