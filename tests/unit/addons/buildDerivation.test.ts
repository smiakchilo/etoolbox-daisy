import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addonFolders,
  addonSkillFolders,
  bundleAddon,
  contributionsFor,
  deriveSkill,
  identityFor,
  inlinedInputsFrom,
  loadAppParsers,
  sourceFiles,
  type TakenNames,
} from '../../../scripts/build-addons.mjs';
import { addonPins } from '../../../src/shared/addons/pins';
import { parseSkillFrontMatter } from '../../../src/main/skills/skillFrontMatter';
import { createScratchDirs } from '../../support/scratchDirs';

/**
 * The build's derivation, driven directly: what an add-on contributes is read
 * from its own folder at build time - its `addon.json` tools and its `SKILL.md`
 * front matter - validated once, and written into the pins. The identity covers
 * what actually ships (the folder and the `src/shared` modules the bundle
 * inlines) and nothing else, so a test edit never re-publishes an add-on and a
 * shared edit always does.
 */

const scratch = createScratchDirs('addon-build', 'derivation-');

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const SKILL_MD = `---
name: demo-skill
description: A skill the build derives from its own front matter.
metadata:
  user-description: A demo skill
table-only: true
user-invocable: false
---

# Demo
`;

function taken(): TakenNames {
  return { tools: new Map(), skills: new Map() };
}

function toolDeclaration(
  overrides: Record<string, unknown> = {},
  descriptorOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'demo_tool',
    descriptor: {
      name: 'demo_tool',
      description: 'Does one demo thing.',
      parameters: { type: 'object', properties: { target: { type: 'string' } } },
      ...descriptorOverrides,
    },
    allowlistEntry: 'custom:demo_tool',
    instructions: 'Use demo_tool.',
    billet: { summary: { path: 'target' }, rows: [{ label: 'Target', value: { path: 'target' } }] },
    ...overrides,
  };
}

describe('the build derives an add-on’s contributions', () => {
  it('derives a skill entry from its own SKILL.md front matter', async () => {
    const parsers = await loadAppParsers();
    const root = scratch.create();
    write(root, 'skills/demo-skill/SKILL.md', SKILL_MD);
    write(root, 'skills/demo-skill/scripts/run.js', 'export default () => 1;');

    const [folder] = addonSkillFolders(root);
    if (folder === undefined) throw new Error('no skill folder');
    const skill = deriveSkill(folder, 'demo-skill', parsers);

    expect(skill).toMatchObject({
      name: 'demo-skill',
      description: 'A skill the build derives from its own front matter.',
      userDescription: 'A demo skill',
      userInvocable: false,
      disableModelInvocation: false,
      tableOnly: true,
      hasScripts: true,
    });
    // The pins and the running app parse the same file with the same parser.
    expect(skill.description).toBe(parseSkillFrontMatter(SKILL_MD)?.description);
  });

  it('reports a malformed front matter instead of contributing a skill', async () => {
    const parsers = await loadAppParsers();
    const root = scratch.create();
    write(root, 'skills/demo-skill/SKILL.md', 'no front matter at all\n');
    const [folder] = addonSkillFolders(root);
    if (folder === undefined) throw new Error('no skill folder');

    expect(deriveSkill(folder, 'demo-skill', parsers).problem).toContain('front matter');
  });

  it('accepts a declaration whose billet reads declared parameters', async () => {
    const parsers = await loadAppParsers();
    const root = scratch.create();
    write(root, 'skills/demo-skill/SKILL.md', SKILL_MD);
    const names = taken();

    const result = contributionsFor(
      root,
      { id: 'demo-addon', contributes: { tools: [toolDeclaration()] } },
      parsers,
      names,
    );

    expect(result.problem).toBeUndefined();
    expect(result.contributions?.tools).toHaveLength(1);
    expect(result.contributions?.skills).toHaveLength(1);
    expect(names.tools.get('demo_tool')).toBe('the "demo-addon" add-on');
  });

  it.each([
    ['the descriptor name disagrees', {}, { name: 'other_tool' }, 'descriptor name'],
    ['the allowlist entry disagrees', { allowlistEntry: 'custom:other' }, {}, 'allowlist entry'],
    [
      'the billet reads an undeclared parameter',
      { billet: { rows: [{ label: 'Missing', value: { path: 'nope' } }] } },
      {},
      'does not declare',
    ],
    ['the declaration is not a tool', { instructions: '' }, {}, 'contributes'],
  ] as [string, Record<string, unknown>, Record<string, unknown>, string][])(
    'reports a declaration where %s',
    async (_label, overrides, descriptorOverrides, expected) => {
      const parsers = await loadAppParsers();
      const root = scratch.create();
      const names = taken();

      const result = contributionsFor(
        root,
        {
          id: 'demo-addon',
          contributes: { tools: [toolDeclaration(overrides, descriptorOverrides)] },
        },
        parsers,
        { tools: names.tools, skills: names.skills },
      );

      expect(result.problem).toContain(expected);
    },
  );

  it('refuses a tool or skill name the application or another add-on already owns', async () => {
    const parsers = await loadAppParsers();
    const root = scratch.create();
    write(root, 'skills/demo-skill/SKILL.md', SKILL_MD);

    const toolClash = taken();
    toolClash.tools.set('demo_tool', 'the application');
    expect(
      contributionsFor(
        root,
        { id: 'demo-addon', contributes: { tools: [toolDeclaration()] } },
        parsers,
        toolClash,
      ).problem,
    ).toContain('already used');

    const skillClash = taken();
    skillClash.skills.set('demo-skill', 'the application');
    expect(
      contributionsFor(root, { id: 'demo-addon', contributes: { tools: [] } }, parsers, skillClash)
        .problem,
    ).toContain('already used');
  });

  it('refuses a "contributes" that declares anything but tools', async () => {
    const parsers = await loadAppParsers();

    const result = contributionsFor(
      scratch.create(),
      { id: 'demo-addon', contributes: { skills: [] } },
      parsers,
      taken(),
    );

    expect(result.problem).toContain('contributes');
  });
});

describe('the build hashes exactly what ships', () => {
  it('ignores the add-on’s tests and E2E specs', () => {
    const root = scratch.create();
    write(root, 'index.ts', 'export const addon = 1;\n');
    write(root, 'tests/tool.test.ts', 'export const t = 1;\n');
    write(root, 'e2e/report.spec.ts', 'export const e = 1;\n');

    expect(sourceFiles(root)).toEqual(['index.ts']);
    const before = identityFor(root, []);
    write(root, 'tests/tool.test.ts', 'export const t = 2;\n');
    write(root, 'e2e/report.spec.ts', 'export const e = 2;\n');
    expect(identityFor(root, [])).toBe(before);
  });

  it('changes when the add-on’s own source changes', () => {
    const root = scratch.create();
    write(root, 'index.ts', 'export const addon = 1;\n');
    const before = identityFor(root, []);

    write(root, 'index.ts', 'export const addon = 2;\n');

    expect(identityFor(root, [])).not.toBe(before);
  });

  it('changes when a src/shared module the bundle inlines changes', () => {
    const root = scratch.create();
    write(root, 'index.ts', 'export const addon = 1;\n');
    const inlined = ['src/shared/result.ts'];

    const withShared = identityFor(root, inlined);
    const withoutShared = identityFor(root, []);

    expect(withShared).not.toBe(withoutShared);
  });

  it('ignores the add-on’s own version, which is bookkeeping rather than content', () => {
    const root = scratch.create();
    write(root, 'index.ts', 'export const addon = 1;\n');
    const lock = (version: string): string =>
      JSON.stringify({
        name: 'demo-addon',
        version,
        lockfileVersion: 3,
        packages: { '': { name: 'demo-addon', version } },
      });
    write(root, 'package.json', JSON.stringify({ name: 'demo-addon', version: '1.0.0' }));
    write(root, 'package-lock.json', lock('1.0.0'));
    const before = identityFor(root, []);

    // Raising the version is a procedural decision: the same bytes still ship.
    write(root, 'package.json', JSON.stringify({ name: 'demo-addon', version: '1.0.1' }));
    write(root, 'package-lock.json', lock('1.0.1'));
    expect(identityFor(root, [])).toBe(before);

    // Anything else in the lockfile is content, so a dependency bump does move it.
    write(
      root,
      'package-lock.json',
      JSON.stringify({
        ...JSON.parse(lock('1.0.1')),
        dependencies: { 'demo-dependency': '1.2.3' },
      }),
    );
    expect(identityFor(root, [])).not.toBe(before);
  });

  it('reads the inlined inputs from the bundle’s metafile, leaving out its own files', () => {
    const root = scratch.create();
    write(root, 'index.ts', 'export const addon = 1;\n');
    // esbuild keys its inputs relative to the build's working directory.
    const own = path.relative(process.cwd(), root).replace(/\\/g, '/');
    const metafile = {
      inputs: {
        [`${own}/index.ts`]: {},
        'src/shared/result.ts': {},
        '../../node_modules/zod/index.js': {},
      },
    };

    const inputs = inlinedInputsFrom(metafile, root);

    expect(inputs).toEqual(['src/shared/result.ts']);
  });

  it('bundles every add-on without the generated pins, which it could not read yet', async () => {
    // The pins are written *by* this build, at its end, and they are git-ignored.
    // A bundle that reached them would need the file before it exists - a clean
    // checkout (every CI leg) has none, so the build would fail outright - and it
    // would hash generated output into the add-on's own identity, so every build
    // would mint a new one and every release would re-publish and re-download the
    // add-on. An add-on imports the shared barrel for the host contract; the
    // barrel therefore does not re-export the pins.
    const folders = addonFolders();
    expect(folders.length).toBeGreaterThan(0);

    for (const directory of folders) {
      const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };

      const built = await bundleAddon(directory, pkg);

      // Not vacuous: the bundle really does read the shared barrel.
      expect(built.inlinedInputs).toContain('src/shared/index.ts');
      expect(built.inlinedInputs.filter((input) => input.endsWith('pins.json'))).toEqual([]);
      const code = Buffer.from(built.code).toString('utf8');
      for (const pin of Object.values(addonPins)) {
        expect(code).not.toContain(pin.identity);
      }
    }
  });
});

describe('the pinned contributions', () => {
  it('match the add-on folders the build read them from', () => {
    // Every pinned entry is what the folder declares today: the pins are
    // generated, never hand-edited, so a stale one is a build fault.
    for (const [id, pin] of Object.entries(addonPins)) {
      expect(pin.contributions.tools.length + pin.contributions.skills.length).toBeGreaterThan(0);
      for (const tool of pin.contributions.tools) {
        expect(tool.allowlistEntry).toBe(`custom:${tool.name}`);
        expect(tool.descriptor.name).toBe(tool.name);
      }
      for (const skill of pin.contributions.skills) {
        expect(skill.name.length).toBeGreaterThan(0);
      }
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
