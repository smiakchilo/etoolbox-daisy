/**
 * Builds every add-on (`src/addons/<id>/`) into `out/addons/<id>/`. The
 * application, built from the same source, carries them (`resources/addons`) and
 * reads them in place; nothing is published or downloaded.
 *
 * **Tools are declared; skills are derived.** `addon.json` declares each tool
 * completely, and each `skills/<name>/SKILL.md` is parsed with the application's
 * own front-matter parser to produce that skill's catalogue entry. Both are
 * validated here - one schema, one parser, shared with the app - and written into
 * the built `addon.json`, which the application reads at startup to advertise an
 * add-on's tools and skills before the add-on's code has been loaded. A skill's
 * body stays in the add-on.
 *
 * A JS add-on is bundled with esbuild into one ESM `index.js`, with its own
 * runtime dependencies left external. Its `package.json` and lock file ship
 * beside the bundle, and so does its `skills/` folder; its `tests/` and `e2e/`
 * never do. A developer build also links the add-on's `node_modules` beside the
 * bundle so Node resolves them the ordinary way; with
 * `EDAISY_ADDONS_SOURCE_ONLY=1` (the install build) nothing is linked, and the
 * application installs the dependencies itself on the add-on's first call
 * (`src/main/addons/builder.ts`).
 *
 * Usage: node scripts/build-addons.mjs
 */
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
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const addonsSourceDir = join(root, 'src', 'addons');
const outDir = join(root, 'out', 'addons');
const parserDir = join(root, 'out', 'addons-build');
const toolsSourceDir = join(root, 'src', 'tools');
const bundledSkillsDir = join(root, 'resources', 'skills');

const SKILL_FILE_NAME = 'SKILL.md';

/**
 * The install build ships an add-on without its dependencies: the application
 * installs them on the add-on's first call. A developer build links them.
 */
const sourceOnly = process.env['EDAISY_ADDONS_SOURCE_ONLY'] === '1';

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
 * application's parser - so the built descriptor and the application can never
 * disagree about what a skill is.
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

/** Bundles a JS add-on's `index.ts` with its own dependencies external. */
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
    logLevel: 'silent',
  });
  const output = result.outputFiles?.[0];
  if (output === undefined)
    fail(`Could not bundle ${relative(root, join(directory, 'index.ts'))}.`);
  return { code: output.contents };
}

/** Writes the built add-on into `out/addons/<id>/`, replacing what was there. */
function writeAddon(
  directory,
  descriptor,
  built,
  contributions,
  { outputDir = outDir, shipSourceOnly = sourceOnly } = {},
) {
  const id = descriptor.id;
  const target = join(outputDir, id);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  writeFileSync(join(target, 'index.js'), built.code);
  writeFileSync(
    join(target, 'addon.json'),
    `${JSON.stringify(
      {
        id,
        apiVersion: descriptor.apiVersion,
        entry: descriptor.entry,
        contributes: { tools: contributions.tools, skills: contributions.skills },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  copyFileSync(join(directory, 'package.json'), join(target, 'package.json'));

  // A skill's body and files ship beside the bundle, because the application
  // reads them in place from the add-on's folder the first time one is used.
  const skills = join(directory, 'skills');
  if (existsSync(skills)) cpSync(skills, join(target, 'skills'), { recursive: true });

  // The lock file ships so the application can install exactly these
  // dependencies on the add-on's first call.
  const lock = join(directory, 'package-lock.json');
  if (existsSync(lock)) copyFileSync(lock, join(target, 'package-lock.json'));

  if (shipSourceOnly) return;
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

async function main() {
  const folders = addonFolders();

  const parsers = await loadAppParsers();
  // What the application already owns: a contributed name may not collide with
  // an application tool or a bundled skill, and no two add-ons may collide.
  const taken = {
    tools: new Map(appToolNames().map((name) => [name, 'the application'])),
    skills: new Map(bundledSkillNames().map((name) => [name, 'the application'])),
  };

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
    const validated = contributionsFor(directory, descriptor, parsers, taken);
    if (validated.problem !== undefined) fail(validated.problem);
    const built = await bundleAddon(directory, pkg);
    entries.push({ directory, descriptor, contributions: validated.contributions, built });
  }

  mkdirSync(outDir, { recursive: true });
  for (const { directory, descriptor, contributions, built } of entries) {
    writeAddon(directory, descriptor, built, contributions);
    console.log(
      `Built add-on ${descriptor.id} into ${relative(root, join(outDir, descriptor.id))}`,
    );
  }

  // A folder whose add-on no longer exists must not linger: the application
  // scans this directory at startup, so a stale build would keep advertising a
  // removed add-on's tools (or log it as rejected) long after its source is gone.
  const current = new Set(entries.map((entry) => entry.descriptor.id));
  for (const name of readdirSync(outDir)) {
    if (!current.has(name)) rmSync(join(outDir, name), { recursive: true, force: true });
  }
}

export {
  addonFolders,
  addonSkillFolders,
  appToolNames,
  bundleAddon,
  bundledSkillNames,
  contributionsFor,
  deriveSkill,
  loadAppParsers,
  writeAddon,
};

// Running it builds; importing it (a test) only exposes the parts above.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
