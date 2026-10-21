// Packs the in-app update for the platform this runs on, and merges the
// per-platform results into the one `update.json` the app reads. Run by the
// "Publish update" workflow (.github/workflows/publish-update.yml).
//
//   node scripts/package-update.mjs                    pack release/update/ for this platform
//   node scripts/package-update.mjs --merge <dir>      fold <dir>/update.*.json into <dir>/update.json
//
// `--notes <text>` (or the UPDATE_NOTES environment variable) sets the release notes.
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
  const partial = {
    version,
    files: {
      [key]: {
        name,
        sha512: createHash('sha512').update(bytes).digest('hex'),
        size: statSync(asar).size,
        minInstalled: packageJson.updates?.runtimeGeneration ?? 1,
      },
    },
  };
  writeFileSync(
    path.join(outDirectory, `update.${key}.json`),
    `${JSON.stringify(partial, null, 2)}\n`,
  );
  console.log(`Packed ${name} (${partial.files[key].size} bytes)`);
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
  const notes = process.env.UPDATE_NOTES;
  const manifest = { version, ...(notes ? { notes } : {}), files };
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
