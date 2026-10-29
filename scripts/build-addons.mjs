/**
 * Builds every add-on (`src/addons/<id>/`) into `out/addons/<id>/`, writes the
 * pins this build needs (`src/shared/addons/pins.json`) and - with `--zip` - the
 * published archives and catalogue (`dist-addons/`).
 *
 * An add-on's identity is derived from its content here (a sha256 over its
 * sources and the `src/shared` modules its bundle inlines, as the first 16 hex
 * characters), so it changes exactly when the add-on changes: an unchanged add-on
 * is never re-published and never re-downloaded, and a changed one can never be
 * served under an identity an install already has. Its `package.json` version is
 * bookkeeping - an add-on sits at its own value (`1.0.0`) until its owner raises
 * it for some procedural reason - and is excluded from that hash, so raising it
 * never re-publishes anything. Its tests are its own business and never part of
 * it.
 *
 * **Tools are declared; skills are derived.** `addon.json` declares each tool
 * completely, and each `skills/<name>/SKILL.md` is parsed with the application's
 * own front-matter parser to produce that skill's catalogue entry. Both are
 * validated here - one schema, one parser, shared with the app - and written into
 * the pins, which is the only run-time source: the application advertises an
 * add-on's tools and skills without ever downloading it. Nothing is downloaded
 * at startup, and a skill's body stays in the add-on.
 *
 * A JS add-on is bundled with esbuild into one ESM `index.js`, with its own
 * runtime dependencies left external, and its `node_modules` is linked beside
 * it so Node resolves them the ordinary way. Its `skills/` folder ships beside
 * it; its `tests/` and `e2e/` never do.
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
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const addonsSourceDir = join(root, 'src', 'addons');
const outDir = join(root, 'out', 'addons');
const parserDir = join(root, 'out', 'addons-build');
const distDir = join(root, 'dist-addons');
const pinsFile = join(root, 'src', 'shared', 'addons', 'pins.json');
const toolsSourceDir = join(root, 'src', 'tools');
const bundledSkillsDir = join(root, 'resources', 'skills');
const withZip = process.argv.includes('--zip');

/** Folders that are the add-on's own tests or tooling, never part of it. */
const NON_SHIPPED_FOLDERS = new Set(['node_modules', 'tests', 'e2e']);

/** A JS add-on is platform-independent, so its archive has one platform key. */
const PLATFORM_ANY = 'any';

const SKILL_FILE_NAME = 'SKILL.md';

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
 * The add-on's own shipped sources, as sorted relative paths. An installed
 * dependency tree, a dot-entry, and the add-on's `tests/` and `e2e/` folders are
 * not sources (a test is not content: editing one must not re-publish the
 * add-on).
 */
function sourceFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (NON_SHIPPED_FOLDERS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(relative(directory, full));
    }
  };
  visit(directory);
  return files.sort();
}

/**
 * An add-on's npm `version` is bookkeeping, not content: it is not compared with
 * the application's, and it must not participate in the identity, or raising it
 * for a procedural reason would re-publish and re-download the whole archive. The
 * version fields are removed before hashing; everything else in the two manifests
 * is content.
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
 * The add-on's content identity: what it is, not what someone called it. It
 * covers the folder's own shipped files **and** every repository file the bundle
 * inlines (`metafile.inputs` outside `node_modules`) - the `src/shared` modules
 * an add-on imports are content too, so a change to one must change the identity
 * of every add-on built against it. Two builds of the same sources always agree;
 * any edit - including a dependency bump in the lockfile - changes it, while a
 * version bump and an edit to a test do not.
 */
function identityFor(directory, inlinedInputs) {
  const hash = createHash('sha256');
  for (const file of sourceFiles(directory)) {
    hash.update(file.replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(withoutVersionMetadata(file, readFileSync(join(directory, file))));
    hash.update('\0');
  }
  for (const input of inlinedInputs) {
    hash.update(input);
    hash.update('\0');
    hash.update(readFileSync(join(root, input)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * The repository files an esbuild bundle inlines: everything it read that is not
 * an externed dependency, and not one of the add-on's own files (those are
 * already hashed above). Sorted, so every runner agrees.
 */
function inlinedInputsFrom(metafile, directory) {
  const ownDirectory = `${resolve(directory).replace(/\\/g, '/')}/`;
  return (
    Object.keys(metafile?.inputs ?? {})
      .map((input) => input.replace(/\\/g, '/').replace(/^\.\//, ''))
      .filter((input) => !input.includes('node_modules/'))
      // Its own files are already hashed from the folder, tests included in that
      // exclusion only through `sourceFiles`.
      .filter((input) => !resolve(root, input).replace(/\\/g, '/').startsWith(ownDirectory))
      .sort()
  );
}

/**
 * The application's own parsers, bundled in memory and imported, so the build
 * and the running application validate an add-on's contributions identically -
 * one schema, one front-matter parser, never a second copy.
 */
async function loadAppParsers() {
  mkdirSync(parserDir, { recursive: true });
  const targets = [
    { name: 'contribution', entry: 'src/shared/addons/contribution.ts', external: ['zod'] },
    { name: 'skillFrontMatter', entry: 'src/main/skills/skillFrontMatter.ts', external: ['yaml'] },
  ];
  const modules = {};
  for (const { name, entry, external } of targets) {
    const outfile = join(parserDir, `${name}.mjs`);
    await build({
      entryPoints: [join(root, entry)],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      external,
      logLevel: 'silent',
    });
    modules[name] = await import(pathToFileURL(outfile).href);
  }
  return { contribution: modules['contribution'], frontMatter: modules['skillFrontMatter'] };
}

/** Every skill folder under `<addon>/skills` that carries a `SKILL.md`, sorted by path. */
function addonSkillFolders(directory) {
  const skillsDir = join(directory, 'skills');
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(skillsDir, entry.name))
    .filter((folder) => existsSync(join(folder, SKILL_FILE_NAME)))
    .sort();
}

/** Every file a skill folder carries, relative to it, with `/` separators. */
function skillFilePaths(directory) {
  const files = [];
  const visit = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full, name);
      else if (entry.isFile()) files.push(name);
    }
  };
  visit(directory, '');
  return files.sort();
}

/**
 * Derives one skill's catalogue entry from its own `SKILL.md`, using the
 * application's parser - so the pins and the application can never disagree
 * about what a skill is.
 */
function deriveSkill(folder, name, parsers) {
  const markdown = readFileSync(join(folder, SKILL_FILE_NAME), 'utf8');
  const parsed = parsers.frontMatter.parseSkillFrontMatter(markdown);
  if (parsed === undefined) {
    return {
      problem: `${relative(root, folder)}/${SKILL_FILE_NAME} has no valid front matter with a name.`,
    };
  }
  if (parsed.name !== name) {
    return {
      problem: `The skill "${name}" declares the name "${parsed.name}" in its front matter.`,
    };
  }
  if (parsed.description === '') return { problem: `The skill "${name}" has no description.` };
  return {
    name,
    description: parsed.description,
    userDescription: parsed.userDescription,
    userInvocable: parsed.userInvocable,
    disableModelInvocation: parsed.disableModelInvocation,
    tableOnly: parsed.tableOnly,
    hasScripts: parsers.contribution.hasRunnableScript(skillFilePaths(folder)),
  };
}

/** Every tool name a folder under `src/tools/` owns (its folder name, snake-cased). */
function appToolNames() {
  if (!existsSync(toolsSourceDir)) return [];
  return readdirSync(toolsSourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.replace(/-/g, '_'));
}

/** Every skill name `resources/skills/` owns. */
function bundledSkillNames() {
  if (!existsSync(bundledSkillsDir)) return [];
  return readdirSync(bundledSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

/**
 * Validates one add-on's declaration and derives what it contributes, or answers
 * why it cannot. Every problem is a build fault: a name the application or
 * another add-on already owns, a descriptor that disagrees with its tool, or a
 * billet that reads a parameter the descriptor does not declare.
 *
 * It answers the problem instead of exiting so each one can be driven by a test
 * (`tests/unit/addons/buildDerivation.test.ts`); `main` is what stops the build.
 */
function contributionsFor(directory, descriptor, parsers, taken) {
  const id = descriptor.id;
  const declared = descriptor.contributes ?? {};
  const parsedDeclaration =
    parsers.contribution.addonContributionDeclarationSchema.safeParse(declared);
  if (!parsedDeclaration.success) {
    return {
      problem: `The "${id}" add-on's addon.json "contributes" is invalid: ${parsedDeclaration.error.message}`,
    };
  }

  const tools = [];
  for (const tool of parsedDeclaration.data.tools) {
    if (tool.descriptor.name !== tool.name) {
      return {
        problem: `The "${id}" add-on's tool "${tool.name}" declares the descriptor name "${tool.descriptor.name}".`,
      };
    }
    if (tool.allowlistEntry !== `custom:${tool.name}`) {
      return {
        problem: `The "${id}" add-on's tool "${tool.name}" must carry the allowlist entry "custom:${tool.name}".`,
      };
    }
    const existing = taken.tools.get(tool.name);
    if (existing !== undefined) {
      return { problem: `The tool name "${tool.name}" is already used by ${existing}.` };
    }
    const billet = tool.billet;
    if (billet !== undefined) {
      const properties = tool.descriptor.parameters['properties'];
      if (typeof properties !== 'object' || properties === null) {
        return {
          problem: `The "${id}" add-on's tool "${tool.name}" declares no parameters for its billet.`,
        };
      }
      const names = Object.keys(properties);
      const paths = [
        ...(billet.summary === undefined ? [] : [billet.summary.path]),
        ...billet.rows.map((row) => row.value.path),
      ];
      for (const path of paths) {
        if (!names.includes(path)) {
          return {
            problem: `The "${id}" add-on's tool "${tool.name}" billet reads "${path}", which its descriptor does not declare.`,
          };
        }
      }
    }
    taken.tools.set(tool.name, `the "${id}" add-on`);
    tools.push(tool);
  }

  const skills = [];
  for (const folder of addonSkillFolders(directory)) {
    const name = folder.replace(/\\/g, '/').split('/').at(-1);
    const existing = taken.skills.get(name);
    if (existing !== undefined) {
      return { problem: `The skill name "${name}" is already used by ${existing}.` };
    }
    const skill = deriveSkill(folder, name, parsers);
    if (typeof skill === 'object' && skill !== null && 'problem' in skill)
      return { problem: skill.problem };
    taken.skills.set(name, `the "${id}" add-on`);
    skills.push(skill);
  }

  return { contributions: { tools, skills } };
}

/**
 * Bundles a JS add-on's `index.ts` with its own dependencies external, and
 * answers the built code plus the identity of exactly what went into it.
 */
async function bundleAddon(directory, pkg) {
  const external = ['electron', ...Object.keys(pkg.dependencies ?? {})];
  const result = await build({
    entryPoints: [join(directory, 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const output = result.outputFiles?.[0];
  if (output === undefined)
    fail(`Could not bundle ${relative(root, join(directory, 'index.ts'))}.`);
  const inlinedInputs = inlinedInputsFrom(result.metafile, directory);
  const identity = identityFor(directory, inlinedInputs);
  return { code: output.contents, identity, inlinedInputs };
}

/** Writes the built add-on into `out/addons/<id>/`, replacing what was there. */
function writeAddon(directory, descriptor, pkg, built, contributions) {
  const id = descriptor.id;
  const target = join(outDir, id);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  writeFileSync(join(target, 'index.js'), built.code);
  writeFileSync(
    join(target, 'addon.json'),
    `${JSON.stringify(
      {
        id,
        identity: built.identity,
        apiVersion: descriptor.apiVersion,
        entry: descriptor.entry,
        contributes: { tools: contributions.tools },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  copyFileSync(join(directory, 'package.json'), join(target, 'package.json'));

  // A skill's body and files ship beside the bundle, because the application
  // reads them in place from the installed folder the first time one is used.
  const skills = join(directory, 'skills');
  if (existsSync(skills)) cpSync(skills, join(target, 'skills'), { recursive: true });

  const modules = join(directory, 'node_modules');
  if (!existsSync(modules)) {
    fail(`The ${id} add-on's dependencies are not installed. Run "npm run addons:install" first.`);
  }
  // A junction/symlink keeps the developer's install single-copy: copying the
  // dependency tree into out/ on every build would cost a minute per build.
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
    // `npm ci` writes a `.bin` shim directory whose contents are
    // platform-specific (regular-file `.cmd`/`.ps1` shims on Windows, symlinks
    // elsewhere). It is never used at run time - the add-on is loaded by
    // `import()`, which resolves through `node_modules`, not through `.bin` - so
    // drop it to keep the `any` archive byte-for-byte identical on every runner.
    if (entry.name === '.bin') continue;
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
  // An add-on's own skills ship with it, never installed from npm.
  const skills = join(outDir, descriptor.id, 'skills');
  if (existsSync(skills)) cpSync(skills, join(staging, 'skills'), { recursive: true });
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

  const parsers = await loadAppParsers();
  // What the application already owns: a contributed name may not collide with
  // an application tool or a bundled skill, and no two add-ons may collide.
  const taken = {
    tools: new Map(appToolNames().map((name) => [name, 'the application'])),
    skills: new Map(bundledSkillNames().map((name) => [name, 'the application'])),
  };

  const pins = {};
  const entries = [];
  for (const directory of folders) {
    const descriptor = readJson(join(directory, 'addon.json'));
    const pkg = readJson(join(directory, 'package.json'));
    const folderName = directory.replace(/\\/g, '/').split('/').at(-1);
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
    // The package version is bookkeeping and deliberately not compared with the
    // application's: an add-on sits at its own value until its owner raises it. It
    // is excluded from the identity, so raising it changes nothing that ships.
    const validated = contributionsFor(directory, descriptor, parsers, taken);
    if (validated.problem !== undefined) fail(validated.problem);
    const contributions = validated.contributions;
    const built = await bundleAddon(directory, pkg);
    entries.push({ directory, descriptor, pkg, contributions, built });
    pins[descriptor.id] = {
      identity: built.identity,
      apiVersion: descriptor.apiVersion,
      contributions,
    };
  }

  mkdirSync(outDir, { recursive: true });
  for (const { directory, descriptor, pkg, contributions, built } of entries) {
    const target = join(outDir, descriptor.id);
    const installed = readJson(join(target, 'addon.json'));
    if (withZip && installed?.identity === built.identity && existsSync(join(target, 'index.js'))) {
      console.log(`Reusing ${relative(root, target)}`);
      continue;
    }
    writeAddon(directory, descriptor, pkg, built, contributions);
    console.log(`Built add-on ${descriptor.id} into ${relative(root, target)}`);
  }

  mkdirSync(dirname(pinsFile), { recursive: true });
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
  if (entries.length === 0) fail('No add-on folder (src/addons/<id>/addon.json) was found.');

  mkdirSync(distDir, { recursive: true });
  for (const { directory, descriptor, built } of entries) {
    const identity = built.identity;
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

export {
  addonFolders,
  addonSkillFolders,
  bundleAddon,
  contributionsFor,
  deriveSkill,
  identityFor,
  inlinedInputsFrom,
  loadAppParsers,
  sourceFiles,
};

// Running it builds; importing it (a test) only exposes the parts above.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
