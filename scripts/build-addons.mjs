/**
 * Builds every add-on (`src/addons/<id>/`) into `out/addons/<id>/`, writes the
 * pins this build needs (`src/main/addons/pins.json`) and - with `--zip` - the
 * published archives and catalogue (`dist-addons/`).
 *
 * A JS add-on is bundled with esbuild into one ESM `index.js`, with its own
 * runtime dependencies left external, and its `node_modules` is linked beside
 * it so Node resolves them the ordinary way. A binary add-on is the platform
 * package's executable, copied into its own folder.
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

/** The expected package name of a platform-specific Copilot payload. */
function copilotCliPackage(platform, arch) {
  return `@github/copilot-${platform}-${arch}`;
}

function copilotVersion() {
  const pkg = readJson(join(root, 'node_modules', '@github', 'copilot', 'package.json'));
  return pkg?.version;
}

/**
 * Bundles a JS add-on's `index.ts` into `out/addons/<id>/index.js` with its own
 * dependencies external, and links its installed `node_modules` beside it.
 */
async function buildJsAddon(directory, descriptor, pkg) {
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

  copyFileSync(join(directory, 'addon.json'), join(target, 'addon.json'));
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

/** Copies, into `target`, the files a binary add-on consists of. */
function buildBinaryAddon(directory, descriptor, version, target) {
  const pkg = readJson(join(directory, 'package.json'));
  const platform = process.platform;
  const arch = process.arch;
  const payloadPackage = copilotCliPackage(platform, arch);
  const payloadDirectory = join(root, 'node_modules', ...payloadPackage.split('/'));
  if (!existsSync(payloadDirectory)) {
    fail(`The binary add-on "${descriptor.id}" needs ${payloadPackage}, which is not installed.`);
  }
  // The payload executable has no `.exe` outside Windows; the descriptor in the
  // source tree is written for Windows.
  const files = Object.fromEntries(
    Object.entries(descriptor.files ?? {}).map(([name, relativePath]) => [
      name,
      platform === 'win32' ? String(relativePath) : String(relativePath).replace(/\.exe$/, ''),
    ]),
  );
  for (const [name, relativePath] of Object.entries(files)) {
    const source = join(payloadDirectory, ...String(relativePath).split('/'));
    if (!existsSync(source)) {
      fail(`The binary add-on "${descriptor.id}" is missing its "${name}" file (${source}).`);
    }
    const destination = join(target, ...String(relativePath).split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  // The descriptor's version is the payload package's, so a bumped dependency
  // can never leave a folder claiming an older version than its pins.
  writeFileSync(
    join(target, 'addon.json'),
    `${JSON.stringify({ ...descriptor, version, files }, null, 2)}\n`,
    'utf8',
  );
  if (pkg !== undefined)
    copyFileSync(join(directory, 'package.json'), join(target, 'package.json'));
}

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('hex');
}

/** Collects a folder into the shape `zipSync` takes. */
function collectFiles(directory, prefix = '') {
  const entries = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
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

/** A real production install for the published archive (never a junction). */
function stageJsAddon(directory, descriptor, staging) {
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  copyFileSync(join(outDir, descriptor.id, 'index.js'), join(staging, 'index.js'));
  copyFileSync(join(directory, 'addon.json'), join(staging, 'addon.json'));
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

/** Merges one archive into `dist-addons/addons.json`, keeping older versions. */
function publishArchive(id, version, platformKey, file) {
  mkdirSync(distDir, { recursive: true });
  const catalogFile = join(distDir, 'addons.json');
  const catalog = readJson(catalogFile) ?? { addons: {} };
  catalog.addons ??= {};
  catalog.addons[id] ??= {};
  catalog.addons[id][version] ??= { platforms: {} };
  catalog.addons[id][version].platforms[platformKey] = file;
  writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}

async function main() {
  const folders = addonFolders();
  if (folders.length === 0) fail('No add-on folder (src/addons/<id>/addon.json) was found.');

  const pins = {};
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
    if (descriptor.kind === 'binary') {
      const version = copilotVersion();
      if (version === undefined) {
        fail(`The "${descriptor.id}" binary add-on needs @github/copilot in node_modules.`);
      }
      pins[descriptor.id] = { version, apiVersion: descriptor.apiVersion };
    } else {
      if (pkg === undefined) fail(`src/addons/${folderName}/package.json is missing.`);
      if (pkg.version !== descriptor.version) {
        fail(
          `The "${descriptor.id}" add-on's addon.json version (${descriptor.version}) does not match its package.json version (${pkg.version}).`,
        );
      }
      pins[descriptor.id] = { version: descriptor.version, apiVersion: descriptor.apiVersion };
    }
  }

  mkdirSync(outDir, { recursive: true });
  for (const directory of folders) {
    const descriptor = readJson(join(directory, 'addon.json'));
    const pkg = readJson(join(directory, 'package.json'));
    const target = join(outDir, descriptor.id);
    if (descriptor.kind === 'js') {
      if (pkg === undefined) fail(`src/addons/${descriptor.id}/package.json is missing.`);
      await buildJsAddon(directory, descriptor, pkg);
    } else {
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      buildBinaryAddon(directory, descriptor, pins[descriptor.id].version, target);
    }
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
    const pin = pins[descriptor.id];
    const staging =
      descriptor.kind === 'js' ? join(outDir, `${descriptor.id}-zip`) : join(outDir, descriptor.id);
    if (descriptor.kind === 'js') stageJsAddon(directory, descriptor, staging);
    const platformKey = descriptor.kind === 'js' ? 'any' : `${process.platform}-${process.arch}`;
    const fileName = `${descriptor.id}-${pin.version}-${platformKey}.zip`;
    const zipped = zipSync(collectFiles(staging), { level: 6 });
    writeFileSync(join(distDir, fileName), zipped);
    publishArchive(descriptor.id, pin.version, platformKey, {
      file: fileName,
      sha512: sha512(zipped),
      size: zipped.byteLength,
    });
    if (descriptor.kind === 'js') rmSync(staging, { recursive: true, force: true });
    console.log(`Packaged ${fileName} (${(zipped.byteLength / 1024 / 1024).toFixed(1)} MB)`);
  }
  console.log(`Wrote ${relative(root, join(distDir, 'addons.json'))}`);
}

await main();
