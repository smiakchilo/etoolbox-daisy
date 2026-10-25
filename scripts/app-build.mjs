/**
 * Builds the application from this source tree into a ready-to-run copy.
 *
 * Called by `install.cmd` / `install.command` with the Node.js they downloaded,
 * from the root of the source they downloaded. The only executables involved are
 * Node.js, the npm packages pinned by `package-lock.json` (npm verifies their
 * integrity hashes) and the Electron binary (verified against its published
 * checksums), so the source is all that has to be trusted. Dependency install
 * scripts are NOT run.
 *
 * The result is the application exactly as the zip packages carry it - on
 * Windows the contents of the unpacked app (`EToolbox Daisy.exe` and its files)
 * written directly into `--out`, on macOS `EToolbox Daisy.app` inside `--out` -
 * so it runs without this script. A file built on this machine carries no
 * download mark (Windows "Mark of the Web", macOS quarantine), which is what
 * SmartScreen and Gatekeeper act on, so neither shows a warning.
 *
 * Usage: node install/build.mjs --out <folder>
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The native realpath expands Windows 8.3 short names (a %TEMP% under a long user
// name is often one); the build tools resolve long names and choke on a mix.
const root = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..'));
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

const outIndex = process.argv.indexOf('--out');
const outArg = outIndex === -1 ? undefined : process.argv[outIndex + 1];
if (!outArg) {
  fail('Usage: node install/build.mjs --out <folder>');
}
if (!isWindows && !isMac) {
  fail(`Unsupported platform: ${process.platform}. Windows and macOS only.`);
}
const outDir = realpathSync.native(outArg);
const packageDir = join(root, 'release');

// Child processes (npm scripts call `node`) must find the Node running this script.
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
const env = {
  ...process.env,
  [pathKey]: `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ''}`,
  // No signing identity is looked for or used: the result is for this machine.
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};
delete env.ELECTRON_RUN_AS_NODE;

const nodeDir = dirname(process.execPath);
const npmCli = [
  join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((candidate) => existsSync(candidate));
if (npmCli === undefined) {
  fail(`npm was not found next to ${process.execPath}. Run this with the Node.js that ships npm.`);
}

function run(label, command, args) {
  console.log(`\n== ${label}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`Step failed: ${label}`);
  }
}

const node = (label, args) => run(label, process.execPath, args);

/**
 * Copies the add-ons built from this repository beside the packaged
 * application (`<out>/resources/addons`), where `src/main/addons/devSource.ts`
 * finds them. The packaged asar deliberately carries none: a release downloads
 * the add-on it pins, while a build-from-source installation uses the copies
 * made here and never downloads one.
 *
 * The built JS add-on's `node_modules` is a junction into `src/addons/<id>/`, so
 * the copy must dereference it - the source tree is deleted with the temporary
 * work folder, and a junction pointing into it would dangle.
 */
function copyAddons(target) {
  const built = join(root, 'out', 'addons');
  if (!existsSync(built)) {
    fail(`No add-ons were built: ${built} does not exist.`);
  }
  cpSync(built, target, { recursive: true, force: true, dereference: true });
}

node('Installing dependencies (install scripts disabled)', [
  npmCli,
  'ci',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
]);
// `--ignore-scripts` skipped the root `postinstall`, so the add-ons' own
// dependencies are installed explicitly. They are separate npm packages
// (src/addons/<id>/), and the build below needs them.
node('Installing add-on dependencies', [npmCli, 'run', 'addons:install']);
node('Building', [npmCli, 'run', 'build']);

const platformFlags = isWindows
  ? ['--win', '--x64']
  : ['--mac', process.arch === 'arm64' ? '--arm64' : '--x64'];
node('Packaging the application', [
  join(root, 'node_modules', 'electron-builder', 'cli.js'),
  '--dir',
  ...platformFlags,
  `-c.directories.output=${packageDir}`,
]);

console.log(`\n== Writing the application to ${outDir}`);
mkdirSync(outDir, { recursive: true });

if (isWindows) {
  const unpacked = join(packageDir, 'win-unpacked');
  if (!existsSync(join(unpacked, 'EToolbox Daisy.exe'))) {
    fail(`The build did not produce ${join(unpacked, 'EToolbox Daisy.exe')}.`);
  }
  try {
    cpSync(unpacked, outDir, { recursive: true, force: true });
  } catch (error) {
    fail(
      `Could not write to ${outDir}: ${error.message}\nIs EToolbox Daisy running from there? Close it and try again.`,
    );
  }
  copyAddons(join(outDir, 'resources', 'addons'));
} else {
  const bundleName = 'EToolbox Daisy.app';
  const built = readdirSync(packageDir)
    .filter((name) => name.startsWith('mac'))
    .map((name) => join(packageDir, name, bundleName))
    .find((path) => existsSync(path));
  if (built === undefined) {
    fail(`The build did not produce ${bundleName} under ${packageDir}.`);
  }
  const target = join(outDir, bundleName);
  // ditto keeps the bundle's symlinks, permissions and signatures intact.
  const steps = [
    ['rm', ['-rf', target]],
    ['ditto', [built, target]],
  ];
  const addonsInBundle = () => copyAddons(join(target, 'Contents', 'Resources', 'addons'));
  steps.push(
    // Apple Silicon refuses unsigned code: seal the bundle with an ad-hoc signature (no identity).
    ['codesign', ['--force', '--deep', '--sign', '-', target]],
    ['xattr', ['-cr', target]],
  );
  let copied = false;
  for (const [command, args] of steps) {
    // The add-ons go in after the copy and before the signature, so the seal
    // covers them.
    if (command === 'codesign' && !copied) {
      addonsInBundle();
      copied = true;
    }
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.status !== 0) {
      fail(`Step failed: ${command} ${args.join(' ')}`);
    }
  }
}

console.log('\nDone.');
