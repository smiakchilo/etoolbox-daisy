/**
 * Installs the dependencies of every JS add-on (`src/addons/<id>/`).
 *
 * Add-ons are their own npm packages (not workspace members), because their
 * dependencies must NOT be in the application's `package.json`: electron-builder
 * packages the app's dependencies, and the whole point is that Lighthouse and
 * Puppeteer are downloaded on first use instead.
 *
 * Runs from `postinstall`, so a plain `npm install` / `npm ci` is enough. A
 * build that passes `--ignore-scripts` (the run-from-source scripts do) must call
 * `npm run addons:install` itself.
 *
 * Usage: node scripts/addons-install.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const addonsDir = join(root, 'src', 'addons');

/** The npm CLI to run: the one that invoked this script, else npm beside Node. */
function resolveNpmCli() {
  const execPath = process.env['npm_execpath'];
  if (execPath !== undefined && existsSync(execPath)) return execPath;
  const nodeDir = dirname(process.execPath);
  return [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((candidate) => existsSync(candidate));
}

const npmCli = resolveNpmCli();

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

if (npmCli === undefined) {
  fail(`npm was not found next to ${process.execPath}. Run this with the Node.js that ships npm.`);
}

if (!existsSync(addonsDir)) {
  console.log('No add-ons to install.');
  process.exit(0);
}

const ids = readdirSync(addonsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(addonsDir, name, 'package.json')))
  .sort();

if (ids.length === 0) {
  console.log('No add-ons to install.');
  process.exit(0);
}

const env = { ...process.env };
delete env['ELECTRON_RUN_AS_NODE'];

for (const id of ids) {
  const directory = join(addonsDir, id);
  const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (parsed.private !== true) {
    fail(`Add-on "${id}" must be a private package (src/addons/${id}/package.json).`);
  }
  const hasLock = existsSync(join(directory, 'package-lock.json'));
  const args = [
    npmCli,
    hasLock ? 'ci' : 'install',
    '--prefix',
    directory,
    '--no-audit',
    '--no-fund',
  ];
  console.log(`\n== Installing ${id} add-on dependencies`);
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) fail(`Could not install the ${id} add-on's dependencies.`);
}

console.log(`\nAdd-on dependencies installed (${ids.join(', ')}).`);
