import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SKILL_MAX_DEPTH,
  SKILL_MAX_FILES,
  SKILL_MD_MAX_BYTES,
  type SkillRejection,
  createSkillStore,
} from '../../../../src/main/skills/skillStore';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('skill-store', 'store-');
afterEach(() => scratch.cleanup());

interface SkillSpec {
  readonly front?: string;
  readonly body?: string;
  readonly files?: Record<string, string>;
}

function skillMd(name: string, description = `About ${name}.`, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}${extra}\n---\n\n# ${name}\n`;
}

function makeRoot(skills: Record<string, SkillSpec | string | null>): string {
  const root = scratch.create();
  for (const [folder, spec] of Object.entries(skills)) {
    const directory = path.join(root, folder);
    mkdirSync(directory, { recursive: true });
    if (spec === null) continue;
    if (typeof spec === 'string') {
      writeFileSync(path.join(directory, 'SKILL.md'), spec, 'utf8');
      continue;
    }
    writeFileSync(path.join(directory, 'SKILL.md'), spec.front ?? skillMd(folder), 'utf8');
    for (const [relative, content] of Object.entries(spec.files ?? {})) {
      const target = path.join(directory, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }
  }
  return root;
}

async function loadStore(
  bundled: Record<string, SkillSpec | string | null>,
  user?: Record<string, SkillSpec | string | null>,
) {
  const rejections: SkillRejection[] = [];
  const store = createSkillStore({
    bundledDirectory: makeRoot(bundled),
    ...(user === undefined ? {} : { userDirectory: makeRoot(user) }),
    onRejected: (rejection) => rejections.push(rejection),
  });
  await store.load();
  return { store, rejections };
}

describe('createSkillStore', () => {
  it('starts empty, shares one read and exposes the result synchronously', async () => {
    const store = createSkillStore({ bundledDirectory: makeRoot({ only: {} }) });
    expect(store.list()).toEqual([]);
    const [first, second] = await Promise.all([store.load(), store.load()]);
    expect(second).toBe(first);
    expect(store.list().map((skill) => skill.name)).toEqual(['only']);
  });

  it('does not re-read the disk on a later load', async () => {
    const bundled = makeRoot({ only: {} });
    const store = createSkillStore({ bundledDirectory: bundled });
    const first = await store.load();
    writeFileSync(path.join(bundled, 'only', 'SKILL.md'), skillMd('only', 'Changed.'));
    expect(await store.load()).toBe(first);
  });

  it('reads the body without its front matter and indexes the other files', async () => {
    const script = 'export default () => 1;';
    const { store } = await loadStore({
      s: {
        files: { 'references/a.md': 'aaa', 'scripts/run.js': script },
      },
    });
    const skill = store.get('s');
    expect(skill?.body).toBe('# s\n');
    expect(skill?.files).toEqual([
      { path: 'references/a.md', size: 3 },
      { path: 'scripts/run.js', size: script.length },
    ]);
    expect(skill?.summary).toMatchObject({ source: 'bundled', hasScripts: true });
  });

  it('marks a skill without a runnable script as having none', async () => {
    const { store } = await loadStore({ s: { files: { 'scripts/run.py': 'print(1)' } } });
    expect(store.get('s')?.summary.hasScripts).toBe(false);
  });

  it('lets a user skill win over a bundled skill of the same name', async () => {
    const { store } = await loadStore(
      { search: { front: skillMd('search', 'Bundled.') }, other: {} },
      { search: { front: skillMd('search', 'Mine.') }, extra: {} },
    );
    expect(store.get('search')?.summary).toMatchObject({ description: 'Mine.', source: 'user' });
    expect(store.list().map((skill) => skill.name)).toEqual(['extra', 'other', 'search']);
  });

  it('keeps the bundled skill when the user skill of that name is rejected', async () => {
    const { store, rejections } = await loadStore(
      { search: { front: skillMd('search', 'Bundled.') } },
      { search: skillMd('wrong-name') },
    );
    expect(store.get('search')?.summary.source).toBe('bundled');
    expect(rejections).toEqual([expect.objectContaining({ folder: 'search', source: 'user' })]);
  });

  it('works without a user folder and with one that does not exist', async () => {
    const bundled = makeRoot({ a: {} });
    const store = createSkillStore({
      bundledDirectory: bundled,
      userDirectory: path.join(bundled, 'missing'),
    });
    await store.load();
    expect(store.list().map((skill) => skill.name)).toEqual(['a']);
    expect(store.rejections()).toEqual([]);
  });

  it('is empty for a missing bundled folder', async () => {
    const store = createSkillStore({ bundledDirectory: path.join(scratch.create(), 'none') });
    expect(await store.load()).toEqual([]);
  });

  it('builds the composer list and the model catalogue from different descriptions', async () => {
    const { store } = await loadStore({
      search: {
        front: skillMd('search', 'Technical.', '\nmetadata:\n  user-description: Friendly.'),
      },
      aux: { front: skillMd('aux', 'Auxiliary.', '\nuser-invocable: false') },
      hidden: { front: skillMd('hidden', 'Hidden.', '\ndisable-model-invocation: true') },
    });
    expect(store.invocable()).toEqual([
      { name: 'hidden', description: 'Hidden.' },
      { name: 'search', description: 'Friendly.' },
    ]);
    expect(store.modelCatalogue()).toEqual([
      { name: 'aux', description: 'Auxiliary.' },
      { name: 'search', description: 'Technical.' },
    ]);
  });

  describe('validation', () => {
    it('rejects the invalid skills and keeps the valid ones', async () => {
      const { store, rejections } = await loadStore({
        good: {},
        'Bad Name': skillMd('Bad Name'),
        mismatch: skillMd('other'),
        'no-desc': '---\nname: no-desc\n---\n',
        'long-desc': skillMd('long-desc', 'x'.repeat(1025)),
        'no-front': 'just text',
        'broken-yaml': '---\nname: [oops\n---\n',
        'not-a-skill': null,
      });
      expect(store.list().map((skill) => skill.name)).toEqual(['good']);
      expect(rejections.map((rejection) => rejection.folder).sort()).toEqual([
        'Bad Name',
        'broken-yaml',
        'long-desc',
        'mismatch',
        'no-desc',
        'no-front',
      ]);
      expect(store.rejections()).toEqual(rejections);
    });

    it('accepts a description of exactly 1024 characters', async () => {
      const { store } = await loadStore({ s: { front: skillMd('s', 'x'.repeat(1024)) } });
      expect(store.get('s')).toBeDefined();
    });

    it('rejects an oversized SKILL.md', async () => {
      const { store, rejections } = await loadStore({
        big: { front: skillMd('big') + 'x'.repeat(SKILL_MD_MAX_BYTES) },
      });
      expect(store.get('big')).toBeUndefined();
      expect(rejections).toHaveLength(1);
    });

    it('rejects a skill with too many files', async () => {
      const files: Record<string, string> = {};
      for (let index = 0; index < SKILL_MAX_FILES; index += 1) files[`f${index}.md`] = 'x';
      const { store } = await loadStore({ many: { files } });
      expect(store.get('many')).toBeUndefined();
    });

    it('accepts the file-count limit exactly, SKILL.md included', async () => {
      const files: Record<string, string> = {};
      for (let index = 0; index < SKILL_MAX_FILES - 1; index += 1) files[`f${index}.md`] = 'x';
      const { store } = await loadStore({ many: { files } });
      expect(store.get('many')).toBeDefined();
    });

    it('rejects a skill nested too deeply and accepts the maximum depth', async () => {
      const deepest = Array.from({ length: SKILL_MAX_DEPTH }, () => 'd').join('/');
      const { store } = await loadStore({
        ok: { files: { [`${deepest}/f.md`]: 'x' } },
        deep: { files: { [`${deepest}/d/f.md`]: 'x' } },
      });
      expect(store.get('ok')).toBeDefined();
      expect(store.get('deep')).toBeUndefined();
    });

    it('rejects a skill larger than the total size limit', async () => {
      const chunk = 'x'.repeat(1024 * 1024);
      const { store } = await loadStore({
        heavy: {
          files: { 'a.md': chunk, 'b.md': chunk, 'c.md': chunk, 'd.md': chunk, 'e.md': chunk },
        },
      });
      expect(store.get('heavy')).toBeUndefined();
    });

    it('does not index dot-entries', async () => {
      const { store } = await loadStore({ s: { files: { '.hidden/x.md': 'x', 'a.md': 'a' } } });
      expect(store.get('s')?.files.map((file) => file.path)).toEqual(['a.md']);
    });

    it('rejects a skill folder that is a link to a folder outside the root', async () => {
      const outside = makeRoot({ evil: {} });
      const root = makeRoot({ good: {} });
      symlinkSync(path.join(outside, 'evil'), path.join(root, 'evil'), 'junction');
      const rejections: SkillRejection[] = [];
      const store = createSkillStore({
        bundledDirectory: root,
        onRejected: (rejection) => rejections.push(rejection),
      });
      await store.load();
      expect(store.list().map((skill) => skill.name)).toEqual(['good']);
      expect(rejections).toEqual([expect.objectContaining({ folder: 'evil' })]);
    });

    it('rejects a SKILL.md that is a link to a file outside the skill', async () => {
      const outside = makeRoot({ evil: {} });
      const root = makeRoot({ linked: null });
      try {
        symlinkSync(
          path.join(outside, 'evil', 'SKILL.md'),
          path.join(root, 'linked', 'SKILL.md'),
          'file',
        );
      } catch {
        // Creating a file symlink needs a privilege some Windows accounts lack.
        return;
      }
      const rejections: SkillRejection[] = [];
      const store = createSkillStore({
        bundledDirectory: root,
        onRejected: (rejection) => rejections.push(rejection),
      });
      await store.load();
      expect(store.get('linked')).toBeUndefined();
      expect(rejections).toEqual([expect.objectContaining({ folder: 'linked' })]);
    });

    it('does not index a linked folder inside a skill', async () => {
      const outside = makeRoot({ other: { files: { 'x.md': 'x' } } });
      const root = makeRoot({ s: { files: { 'a.md': 'a' } } });
      symlinkSync(path.join(outside, 'other'), path.join(root, 's', 'ref'), 'junction');
      const store = createSkillStore({ bundledDirectory: root });
      await store.load();
      expect(store.get('s')?.files.map((file) => file.path)).toEqual(['a.md']);
    });

    it('reports each rejection once through the callback', async () => {
      const onRejected = vi.fn();
      const store = createSkillStore({
        bundledDirectory: makeRoot({ bad: 'nothing' }),
        onRejected,
      });
      await store.load();
      await store.load();
      expect(onRejected).toHaveBeenCalledTimes(1);
    });
  });
});
