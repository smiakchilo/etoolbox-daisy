// The runtime layer an `app.asar` swap cannot replace, as the release side sees
// it: Electron's version plus the unpacked payload's identity. `update.json`
// carries the result, and the installed app compares it with the layer it is
// actually running on (`src/main/updates/runtime.ts`, which implements the same
// algorithm - `tests/unit/main/updates/runtimeDescriptorScript.test.ts` holds the
// two together).
//
// Derived, never declared: bumping Electron, changing `asarUnpack`, or shipping
// a new Copilot runtime changes this value because the files changed. There is
// no counter to forget.
//
//   node scripts/runtime-descriptor.mjs --describe <app.asar.unpacked> --electron <version>
//
// prints the descriptor as JSON; without arguments it is importable.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const RUNTIME_DESCRIPTOR_FORMAT = 1;

const MAX_PAYLOAD_FILES = 5000;
const PAYLOAD_HASH_LENGTH = 32;

/** Every path of the payload with its size, sorted by code unit (never by locale). */
export function runtimePayloadHash(entries) {
  const canonical = entries
    .map((entry) => `${entry.path}:${entry.size}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, PAYLOAD_HASH_LENGTH);
}

/** Lists the payload's files; a missing directory is an empty payload. */
export function describeRuntimePayloadFiles(root) {
  const files = [];
  const walk = (directory, relative) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(path.join(directory, entry.name), entryRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_PAYLOAD_FILES) {
        throw new Error(`The runtime payload has more than ${MAX_PAYLOAD_FILES} files.`);
      }
      files.push({ path: entryRelative, size: lstatSync(path.join(directory, entry.name)).size });
    }
  };
  walk(root, '');
  return files;
}

export function describeRuntime({ unpackedDirectory, electronVersion }) {
  return {
    format: RUNTIME_DESCRIPTOR_FORMAT,
    electron: electronVersion,
    payload: runtimePayloadHash(describeRuntimePayloadFiles(unpackedDirectory)),
  };
}

/** The Electron version `npm ci` pinned - exactly what electron-builder packaged. */
export function readElectronVersion(root) {
  const manifest = path.join(root, 'node_modules', 'electron', 'package.json');
  return JSON.parse(readFileSync(manifest, 'utf8')).version;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const unpackedDirectory = arg('--describe');
  if (unpackedDirectory === undefined) {
    console.error(
      'Usage: node scripts/runtime-descriptor.mjs --describe <app.asar.unpacked> --electron <version>',
    );
    process.exit(1);
  }
  const electronVersion =
    arg('--electron') ?? readElectronVersion(path.resolve(import.meta.dirname, '..'));
  console.log(JSON.stringify(describeRuntime({ unpackedDirectory, electronVersion })));
}
