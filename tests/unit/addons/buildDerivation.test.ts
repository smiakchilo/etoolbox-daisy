import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addonSkillFolders,
  contributionsFor,
  deriveSkill,
  loadAppParsers,
  type TakenNames,
} from '../../../scripts/build-addons.mjs';
import { parseSkillFrontMatter } from '../../../src/main/skills/skillFrontMatter';
import { builtAddonContributions } from '../../support/addonContributions';
import { createScratchDirs } from '../../support/scratchDirs';

/**
 * The build's derivation, driven directly: what an add-on contributes is read
 * from its own folder at build time - its `addon.json` tools and its `SKILL.md`
 * front matter - validated once, and written into the built add-on's
 * `addon.json`, which the running app reads back.
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
    // The build and the running app parse the same file with the same parser.
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

describe('the built contributions', () => {
  it('derive from every add-on folder the build reads', async () => {
    const entries = await builtAddonContributions();

    expect(entries.length).toBeGreaterThan(0);
    for (const { id, contributions } of entries) {
      expect(contributions.tools.length + contributions.skills.length).toBeGreaterThan(0);
      for (const tool of contributions.tools) {
        expect(tool.allowlistEntry).toBe(`custom:${tool.name}`);
        expect(tool.descriptor.name).toBe(tool.name);
      }
      for (const skill of contributions.skills) {
        expect(skill.name.length).toBeGreaterThan(0);
      }
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
