/**
 * Merges the per-platform add-on catalogues produced by a build matrix into the
 * one `addons.json` that is published beside `update.json`.
 *
 * Each job runs `npm run addons:zip` and copies its `dist-addons/addons.json` to
 * `addons.<platform>-<arch>.json`. This folds them into a single document,
 * keeping **every** published version (an older install still pins an older
 * version), and every platform entry within a version.
 *
 *   node scripts/merge-addons.mjs <directory>
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? '.');

if (!existsSync(directory)) {
  console.error(`\nNo such folder: ${directory}`);
  process.exit(1);
}

const partials = readdirSync(directory)
  .filter((file) => /^addons\..+\.json$/.test(file))
  .map((file) => ({ file, catalog: JSON.parse(readFileSync(path.join(directory, file), 'utf8')) }));

if (partials.length === 0) {
  console.error(`\nNo addons.<platform>.json in ${directory}`);
  process.exit(1);
}

const addons = {};
for (const { catalog } of partials) {
  for (const [id, versions] of Object.entries(catalog.addons ?? {})) {
    addons[id] ??= {};
    for (const [version, entry] of Object.entries(versions)) {
      addons[id][version] ??= { platforms: {} };
      for (const [platformKey, archive] of Object.entries(entry.platforms ?? {})) {
        const existing = addons[id][version].platforms[platformKey];
        // The same platform key must name the same bytes. A JS add-on is
        // published as `any` by every runner, so this is what catches two
        // matrices producing different archives under one catalogue entry.
        if (existing !== undefined && existing.sha512 !== archive.sha512) {
          console.error(
            `\n${id} ${version} ${platformKey}: two builds published different archives ` +
              `(${existing.sha512.slice(0, 12)}… vs ${archive.sha512.slice(0, 12)}…).`,
          );
          process.exit(1);
        }
        addons[id][version].platforms[platformKey] = archive;
      }
    }
  }
}

const merged = { addons };
writeFileSync(path.join(directory, 'addons.json'), `${JSON.stringify(merged, null, 2)}\n`);
console.log(
  `Wrote addons.json: ${Object.entries(addons)
    .map(([id, versions]) => `${id} (${Object.keys(versions).join(', ')})`)
    .join('; ')}`,
);
