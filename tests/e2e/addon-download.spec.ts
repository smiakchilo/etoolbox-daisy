import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { type ElectronApp, launchApp } from '../support/e2e/app';
import { ensureAddon } from '../support/e2e/addons';
import { createScratchDirs, type ScratchDirs } from '../support/e2e/profile';

/**
 * Add-ons against the BUILT app: a feature that needs one downloads the pinned
 * identity from the catalogue and installs it atomically; a corrupted archive
 * installs nothing; and a build from this repository uses its own copy instead
 * of downloading at all.
 *
 * The probe drives the real manager in main (`tests/support/e2e/addons.ts`).
 * The fake agent scripts a tool call's outcome and never runs a real executor,
 * so a chat turn cannot reach an installed add-on - a real Lighthouse audit
 * needs the live suite. What is proven here is the download path itself, which
 * is where the failure modes are: the hash, the folder, the atomic rename.
 *
 * Run against the BUILT app:
 *   npm run build
 *   npx playwright test tests/e2e/addon-download.spec.ts
 */

const scratchBase = path.resolve(__dirname, '../../test-results', 'addon-download-scratch');
const fixtureRoot = path.resolve(__dirname, '../../test-results', 'addon-download-fixture');

const PAGE_AUDIT = 'page-audit';

/**
 * The identity the built app pins - read from the generated file, never typed
 * here: a fixture that invented one could not be installed, and one that
 * hard-coded today's would fail on the next legitimate add-on change.
 */
function pinnedIdentity(id: string): string {
  const pins = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../src/main/addons/pins.json'), 'utf8'),
  ) as Record<string, { readonly identity: string }>;
  const identity = pins[id]?.identity;
  if (identity === undefined) throw new Error(`pins.json names no ${id} identity`);
  return identity;
}

const IDENTITY = pinnedIdentity(PAGE_AUDIT);

/**
 * Writes a catalogue and one archive for the page-audit add-on: the files the
 * build produced (declared by the caller) plus a matching `addon.json`.
 */
function publish(options: { readonly corrupt?: boolean } = {}): string {
  mkdirSync(fixtureRoot, { recursive: true });
  const files: Record<string, Uint8Array> = {
    'addon.json': strToU8(
      JSON.stringify({
        id: PAGE_AUDIT,
        identity: IDENTITY,
        apiVersion: 1,
        entry: 'index.js',
      }),
    ),
    'index.js': strToU8(
      'export function createPageAuditRunner() { return () => Promise.resolve({ kind: "no_page" }); }',
    ),
  };
  const file = `${PAGE_AUDIT}-${IDENTITY}-any.zip`;
  const bytes = zipSync(files);
  // A corrupt download: the catalogue's hash is the good archive's, the file on
  // disk is not - exactly what a truncated or tampered transfer looks like.
  writeFileSync(
    path.join(fixtureRoot, file),
    options.corrupt === true ? strToU8('this is not a zip file') : bytes,
  );
  writeFileSync(
    path.join(fixtureRoot, 'addons.json'),
    JSON.stringify({
      addons: {
        [PAGE_AUDIT]: {
          [IDENTITY]: {
            platforms: {
              any: {
                file,
                sha512: createHash('sha512').update(bytes).digest('hex'),
                size: bytes.byteLength,
              },
            },
          },
        },
      },
    }),
  );
  return fixtureRoot;
}

async function launch(
  env: Readonly<Record<string, string>>,
): Promise<{ app: ElectronApp; dirs: ScratchDirs }> {
  const dirs = createScratchDirs(scratchBase);
  const app = await launchApp(dirs, { fakeAgent: true, env });
  return { app, dirs };
}

test.describe('add-ons', () => {
  test('a local catalogue installs the pinned add-on under LOCALAPPDATA', async () => {
    test.setTimeout(120_000);
    const source = publish();
    const { app, dirs } = await launch({ EDAISY_ADDON_SOURCE: source });
    try {
      const result = await ensureAddon(app, PAGE_AUDIT);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.dir).toBe(
        path.join(dirs.localAppData, 'etoolbox-daisy', 'addons', PAGE_AUDIT, IDENTITY),
      );
      expect(result.identity).toBe(IDENTITY);
      expect(result.apiVersion).toBe(1);
      // The download reported its progress, ending at "done".
      expect(result.progress.length).toBeGreaterThan(0);
      expect(result.progress.at(-1)).toBe(1);
      expect(existsSync(path.join(result.dir, 'addon.json'))).toBe(true);
      expect(readFileSync(path.join(result.dir, 'index.js'), 'utf8')).toContain(
        'createPageAuditRunner',
      );
    } finally {
      await app.close();
    }
  });

  test('a corrupted archive installs nothing', async () => {
    test.setTimeout(120_000);
    const source = publish({ corrupt: true });
    const { app, dirs } = await launch({ EDAISY_ADDON_SOURCE: source });
    try {
      const result = await ensureAddon(app, PAGE_AUDIT);

      expect(result).toMatchObject({ ok: false, reason: 'hash' });
      expect(
        existsSync(path.join(dirs.localAppData, 'etoolbox-daisy', 'addons', PAGE_AUDIT, IDENTITY)),
      ).toBe(false);
    } finally {
      await app.close();
    }
  });

  test("a development build uses the repository's own add-on and never downloads", async () => {
    test.setTimeout(120_000);
    const { app, dirs } = await launch({});
    try {
      const result = await ensureAddon(app, PAGE_AUDIT);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // `out/addons/page-audit` - the copy `npm run build` produced, not
      // anything under the scratch technical folder.
      expect(result.dir).toBe(path.resolve(__dirname, '../../out', 'addons', PAGE_AUDIT));
      expect(existsSync(path.join(dirs.localAppData, 'etoolbox-daisy', 'addons', PAGE_AUDIT))).toBe(
        false,
      );
    } finally {
      await app.close();
    }
  });
});
