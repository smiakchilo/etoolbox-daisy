/**
 * Packages the working tree into a folder that can update itself.
 *
 * `electron-builder --dir` alone writes `resources/app.asar` and the unpacked
 * agent runtime. It does not write the two things the in-app updater needs:
 *
 * - `resources/install/<script>`, which `src/main/updates/composition.ts`
 *   spawns in `--update` mode (a build without it says it "has no update
 *   script, so it cannot update itself");
 * - `resources/addons`, which is imported from real files by the add-on loader.
 *
 * A real install gets both from `scripts/app-build.mjs`, which copies them after
 * packaging. This script is that same pipeline with `--skip-install`: it does
 * not run `npm ci` and does not download the source, so it packages exactly the
 * working tree, with the add-ons built source-only (their dependencies are
 * installed on first use - `src/main/addons/builder.ts`).
 *
 * Usage: npm run package:dir -- <folder>
 *        node scripts/package-unpacked.mjs --out <folder>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..'));

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const outArg =
  outIndex === -1 ? argv.find((argument) => !argument.startsWith('--')) : argv[outIndex + 1];
if (!outArg) {
  fail(
    'Usage: npm run package:dir -- <folder>\n       node scripts/package-unpacked.mjs --out <folder>',
  );
}

const packageDir = join(root, 'release');
const existed = existsSync(outArg);
mkdirSync(outArg, { recursive: true });
const outDir = realpathSync.native(outArg);
if (outDir === packageDir || outDir.startsWith(`${packageDir}${sep}`)) {
  // Leave nothing behind for a folder this script refused.
  if (!existed) rmSync(outArg, { recursive: true, force: true });
  fail(`Choose a folder outside ${packageDir}: the build is packaged into it.`);
}

const result = spawnSync(
  process.execPath,
  [join(root, 'scripts', 'app-build.mjs'), '--out', outDir, '--skip-install'],
  { cwd: root, env: process.env, stdio: 'inherit' },
);
if (result.status !== 0) fail('The build did not finish.');

console.log(`\n== The application is in ${outDir}`);
console.log('This folder carries its update script, so it can update itself.');
