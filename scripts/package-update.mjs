// Packs the in-app update for the platform this runs on, and merges the
// per-platform results into the one `update.json` the app reads. Run by the
// "Publish update" workflow (.github/workflows/publish-update.yml).
//
//   node scripts/package-update.mjs                    pack release/update/ for this platform
//   node scripts/package-update.mjs --merge <dir>      fold <dir>/update.*.json into <dir>/update.json
//
// `--notes <text>` (or the UPDATE_NOTES environment variable) sets the release notes.
//
// `update.json` also names the add-on identities the published asar pins
// (`"addons": { "<id>": "<identity>" }`). That map is bookkeeping: the same pins
// travel inside `app.asar`, and the published folder keeps only the add-on
// archives the current catalogue names, so this is the one record of what a
// released version needed.
//
// Packing expects `electron-builder --dir` to have produced an unpacked app under
// `release/`. Only `app.asar` is published: the updater swaps that one file and
// never touches the rest of the install.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { describeRuntime, readElectronVersion } from './runtime-descriptor.mjs';

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

function findAsar(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      const found = findAsar(full);
      if (found !== undefined) return found;
    } else if (entry.name === 'app.asar') {
      return full;
    }
  }
  return undefined;
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The add-on identities the packaged asar pins, read from the generated pins the
 * build wrote beside it. Published as `update.json`'s `addons` node, because the
 * folder keeps only the archives the current catalogue names and so has no older
 * pin record of its own.
 */
function readAddonPins() {
  const file = path.join(root, 'src', 'shared', 'addons', 'pins.json');
  let pins;
  try {
    pins = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Could not read ${file} - run "npm run build" before packaging the update.`);
  }
  const identities = {};
  for (const id of Object.keys(pins).sort()) {
    const identity = pins[id]?.identity;
    if (typeof identity !== 'string') throw new Error(`The "${id}" pin has no identity.`);
    identities[id] = identity;
  }
  return identities;
}

function pack(outDirectory) {
  const asar = findAsar(path.join(root, 'release'));
  if (asar === undefined)
    throw new Error('No app.asar under release/ - run electron-builder --dir first');
  const key = `${process.platform}-${process.arch}`;
  const version = packageJson.version;
  const name = `app-${version}-${key}.asar`;
  mkdirSync(outDirectory, { recursive: true });
  copyFileSync(asar, path.join(outDirectory, name));
  const bytes = readFileSync(asar);
  // The runtime layer this archive needs: the Electron it was packaged against
  // and the unpacked payload beside it. The installed app describes its own and
  // refuses the swap when they differ (src/main/updates/runtime.ts).
  const runtime = describeRuntime({
    unpackedDirectory: `${asar}.unpacked`,
    electronVersion: readElectronVersion(root),
  });
  const partial = {
    version,
    addons: readAddonPins(),
    files: {
      [key]: {
        name,
        sha512: createHash('sha512').update(bytes).digest('hex'),
        size: statSync(asar).size,
        runtime,
      },
    },
  };
  writeFileSync(
    path.join(outDirectory, `update.${key}.json`),
    `${JSON.stringify(partial, null, 2)}\n`,
  );
  console.log(
    `Packed ${name} (${partial.files[key].size} bytes, runtime ${runtime.electron}/${runtime.payload})`,
  );
}

function merge(directory) {
  const partials = readdirSync(directory)
    .filter((file) => /^update\..+\.json$/.test(file))
    .map((file) => JSON.parse(readFileSync(path.join(directory, file), 'utf8')));
  if (partials.length === 0) throw new Error(`No update.<platform>.json in ${directory}`);
  const version = partials
    .map((partial) => partial.version)
    .sort(compareVersions)
    .at(-1);
  const files = {};
  // A platform built for an older version is not offered: only the newest version's archives.
  for (const partial of partials) {
    if (partial.version === version) Object.assign(files, partial.files);
  }
  // Every leg built the same sources, so the add-ons this version pins must
  // agree; two answers mean one leg packaged something else.
  const pinned = [
    ...new Set(
      partials
        .filter((partial) => partial.version === version)
        .map((partial) => JSON.stringify(partial.addons ?? {})),
    ),
  ];
  if (pinned.length > 1) {
    throw new Error(`The ${version} builds pin different add-ons:\n${pinned.join('\n')}`);
  }
  const addons = JSON.parse(pinned[0] ?? '{}');
  const notes = process.env.UPDATE_NOTES;
  const manifest = { version, ...(notes ? { notes } : {}), addons, files };
  writeFileSync(path.join(directory, 'update.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote update.json for ${version}: ${Object.keys(files).join(', ')}`);
  return manifest;
}

const args = process.argv.slice(2);
const notesIndex = args.indexOf('--notes');
if (notesIndex !== -1) process.env.UPDATE_NOTES = args[notesIndex + 1] ?? '';

if (args[0] === '--merge') {
  merge(path.resolve(args[1] ?? path.join(root, 'release', 'update')));
} else {
  pack(path.join(root, 'release', 'update'));
}
