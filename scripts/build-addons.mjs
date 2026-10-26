/**
 * Builds every add-on (`src/addons/<id>/`) into `out/addons/<id>/`, writes the
 * pins this build needs (`src/main/addons/pins.json`) and - with `--zip` - the
 * published archives and catalogue (`dist-addons/`).
 *
 * An add-on carries **no version of its own**. Its identity is derived from its
 * content here (a sha256 over its sources, as the first 16 hex characters), so
 * it changes exactly when the add-on changes: an unchanged add-on is never
 * re-published and never re-downloaded, and a changed one can never be served
 * under an identity an install already has.
 *
 * A JS add-on is bundled with esbuild into one ESM `index.js`, with its own
 * runtime dependencies left external, and its `node_modules` is linked beside
 * it so Node resolves them the ordinary way.
 *
 * `npm run build` and `npm run dev` run this without `--zip`: a build from this
 * repository carries its add-ons (`out/addons`) and never downloads one. Only
 * `npm run addons:zip` (used by the publish workflow) writes `dist-addons/`.
 *
 * Usage: node scripts/build-addons.mjs [--zip]
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const addonsSourceDir = join(root, 'src', 'addons');
const outDir = join(root, 'out', 'addons');
const distDir = join(root, 'dist-addons');
const pinsFile = join(root, 'src', 'main', 'addons', 'pins.json');
const withZip = process.argv.includes('--zip');

/** A JS add-on is platform-independent, so its archive has one platform key. */
const PLATFORM_ANY = 'any';

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Every add-on folder that carries a descriptor. */
function addonFolders() {
  if (!existsSync(addonsSourceDir)) return [];
  return readdirSync(addonsSourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(addonsSourceDir, entry.name))
    .filter((directory) => existsSync(join(directory, 'addon.json')))
    .sort();
}

/**
 * The add-on's own sources, as sorted relative paths. An installed dependency
 * tree and dot-entries are not sources; the lockfile is (it pins them).
 */
function sourceFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(relative(directory, full));
    }
  };
  visit(directory);
  return files.sort();
}

/**
 * An add-on's npm `version` follows the application's (a private package carries
 * the app version), so it must not participate in the identity: otherwise every
 * release would re-download an unchanged add-on. The version fields are removed
 * before hashing; everything else in the two manifests is content.
 */
function withoutVersionMetadata(file, bytes) {
  if (file !== 'package.json' && file !== 'package-lock.json') return bytes;
  const parsed = JSON.parse(bytes.toString('utf8'));
  delete parsed.version;
  if (file === 'package-lock.json' && parsed.packages?.[''] !== undefined) {
    delete parsed.packages[''].version;
  }
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

/**
 * The add-on's content identity: what it is, not what someone called it. Two
 * builds of the same sources always agree; any edit - including a dependency
 * bump in the lockfile - changes it, while an app version bump does not.
 */
function identityFor(directory) {
  const hash = createHash('sha256');
  for (const file of sourceFiles(directory)) {
    hash.update(file.replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(withoutVersionMetadata(file, readFileSync(join(directory, file))));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Whether `--zip` can reuse what `out/addons/<id>` already holds instead of
 * building the add-on a second time. The identity answers that exactly: the
 * release workflow zips straight after `npm run build`, so those artifacts are
 * what a rebuild would produce.
 */
function isBuildFresh(directory, descriptor) {
  const target = join(outDir, descriptor.id);
  const built = readJson(join(target, 'addon.json'));
  return built?.identity === identityFor(directory) && existsSync(join(target, 'index.js'));
}

/**
 * Bundles a JS add-on's `index.ts` into `out/addons/<id>/index.js` with its own
 * dependencies external, links its installed `node_modules` beside it, and
 * writes the descriptor carrying the identity.
 */
async function buildJsAddon(directory, descriptor, pkg, identity) {
  const id = descriptor.id;
  const target = join(outDir, id);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const external = ['electron', ...Object.keys(pkg.dependencies ?? {})];
  await build({
    entryPoints: [join(directory, 'index.ts')],
    outfile: join(target, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external,
    logLevel: 'silent',
  });

  writeFileSync(
    join(target, 'addon.json'),
    `${JSON.stringify(
      {
        id,
        identity,
        apiVersion: descriptor.apiVersion,
        entry: descriptor.entry,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  copyFileSync(join(directory, 'package.json'), join(target, 'package.json'));

  const modules = join(directory, 'node_modules');
  if (!existsSync(modules)) {
    fail(`The ${id} add-on's dependencies are not installed. Run "npm run addons:install" first.`);
  }
  // A junction/symlink keeps the developer's install single-copy: copying the
  // Lighthouse tree into out/ on every build would cost a minute per build.
  symlinkSync(
    modules,
    join(target, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('hex');
}

/**
 * Collects a folder into the shape `zipSync` takes, in sorted order so the
 * archive is byte-for-byte reproducible (three release runners build the same
 * platform-independent add-on, and the catalogue publishes one sha512).
 */
function collectFiles(directory, prefix = '') {
  const entries = {};
  const children = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of children) {
    const full = join(directory, entry.name);
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(entries, collectFiles(full, name));
    } else if (entry.isFile()) {
      entries[name] = new Uint8Array(readFileSync(full));
    }
  }
  return entries;
}

/**
 * A fixed timestamp for every entry. A zip otherwise records "now" per file,
 * which would make the same add-on produce a different sha512 on every runner.
 */
const ZIP_TIMESTAMP = new Date('1980-01-01T00:00:00Z');

/** A real production install for the published archive (never a junction). */
function stageJsAddon(directory, descriptor, staging) {
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  copyFileSync(join(outDir, descriptor.id, 'index.js'), join(staging, 'index.js'));
  // The built descriptor carries the identity; the source one does not.
  copyFileSync(join(outDir, descriptor.id, 'addon.json'), join(staging, 'addon.json'));
  copyFileSync(join(directory, 'package.json'), join(staging, 'package.json'));
  const lock = join(directory, 'package-lock.json');
  if (existsSync(lock)) copyFileSync(lock, join(staging, 'package-lock.json'));
  const npmCli = resolveNpmCli();
  if (npmCli === undefined) fail('npm was not found next to the running Node.js.');
  const env = { ...process.env };
  delete env['ELECTRON_RUN_AS_NODE'];
  const result = spawnSync(
    process.execPath,
    [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'],
    { cwd: staging, env, stdio: 'inherit' },
  );
  if (result.status !== 0) fail(`Could not install the ${descriptor.id} add-on for packaging.`);
}

function resolveNpmCli() {
  const execPath = process.env['npm_execpath'];
  if (execPath !== undefined && existsSync(execPath)) return execPath;
  const nodeDir = dirname(process.execPath);
  return [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((candidate) => existsSync(candidate));
}

/** Merges one archive into `dist-addons/addons.json`, keeping older identities. */
function publishArchive(id, identity, platformKey, file) {
  mkdirSync(distDir, { recursive: true });
  const catalogFile = join(distDir, 'addons.json');
  const catalog = readJson(catalogFile) ?? { addons: {} };
  catalog.addons ??= {};
  catalog.addons[id] ??= {};
  catalog.addons[id][identity] ??= { platforms: {} };
  catalog.addons[id][identity].platforms[platformKey] = file;
  writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}

async function main() {
  const folders = addonFolders();
  if (folders.length === 0) fail('No add-on folder (src/addons/<id>/addon.json) was found.');
  const appVersion = readJson(join(root, 'package.json'))?.version;
  if (typeof appVersion !== 'string') fail('The application package.json has no version.');

  const pins = {};
  const identities = new Map();
  const packages = new Map();
  for (const directory of folders) {
    const descriptor = readJson(join(directory, 'addon.json'));
    const pkg = readJson(join(directory, 'package.json'));
    const folderName = directory.split(/[\\/]/).at(-1);
    if (descriptor === undefined) fail(`src/addons/${folderName}/addon.json is not valid JSON.`);
    if (descriptor.id !== folderName) {
      fail(`src/addons/${folderName}/addon.json names the add-on "${descriptor.id}".`);
    }
    if (typeof descriptor.apiVersion !== 'number') {
      fail(`The "${descriptor.id}" add-on has no apiVersion.`);
    }
    if (typeof descriptor.entry !== 'string' || descriptor.entry === '') {
      fail(`The "${descriptor.id}" add-on has no entry.`);
    }
    if (pkg === undefined) fail(`src/addons/${folderName}/package.json is missing.`);
    // A private package carries the application's version - one rule for every
    // private package in the repository, so an add-on never drifts from the
    // build that ships it. The add-on's *identity* is separate and derived.
    if (pkg.version !== appVersion) {
      fail(
        `The "${descriptor.id}" add-on's package.json version (${pkg.version}) must match the ` +
          `application's (${appVersion}). Run "npm install --prefix src/addons/${descriptor.id}" ` +
          'after changing it, so its lockfile agrees.',
      );
    }
    const identity = identityFor(directory);
    identities.set(directory, identity);
    packages.set(directory, pkg);
    pins[descriptor.id] = { identity, apiVersion: descriptor.apiVersion };
  }

  mkdirSync(outDir, { recursive: true });
  for (const directory of folders) {
    const descriptor = readJson(join(directory, 'addon.json'));
    const target = join(outDir, descriptor.id);
    if (withZip && isBuildFresh(directory, descriptor)) {
      console.log(`Reusing ${relative(root, target)}`);
      continue;
    }
    await buildJsAddon(directory, descriptor, packages.get(directory), identities.get(directory));
    console.log(`Built add-on ${descriptor.id} into ${relative(root, target)}`);
  }

  writeFileSync(
    pinsFile,
    `${JSON.stringify(
      Object.fromEntries(Object.entries(pins).sort(([a], [b]) => a.localeCompare(b))),
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`Wrote ${relative(root, pinsFile)}`);

  if (!withZip) return;

  mkdirSync(distDir, { recursive: true });
  for (const directory of folders) {
    const descriptor = readJson(join(directory, 'addon.json'));
    const identity = identities.get(directory);
    const staging = join(outDir, `${descriptor.id}-zip`);
    stageJsAddon(directory, descriptor, staging);
    const fileName = `${descriptor.id}-${identity}-${PLATFORM_ANY}.zip`;
    const zipped = zipSync(collectFiles(staging), { level: 6, mtime: ZIP_TIMESTAMP });
    writeFileSync(join(distDir, fileName), zipped);
    publishArchive(descriptor.id, identity, PLATFORM_ANY, {
      file: fileName,
      sha512: sha512(zipped),
      size: zipped.byteLength,
    });
    rmSync(staging, { recursive: true, force: true });
    console.log(`Packaged ${fileName} (${(zipped.byteLength / 1024 / 1024).toFixed(1)} MB)`);
  }
  console.log(`Wrote ${relative(root, join(distDir, 'addons.json'))}`);
}

await main();
