import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normaliseSkillRelativePath,
  resolveSkillPath,
} from '../../../../src/main/skills/skillFiles';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('skill-files', 'files-');
afterEach(() => scratch.cleanup());

function makeSkill(): { root: string; outside: string } {
  const base = scratch.create();
  const root = path.join(base, 'skill');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'references'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, 'SKILL.md'), 'x');
  writeFileSync(path.join(root, 'references', 'a.md'), 'a');
  writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  return { root, outside };
}

describe('normaliseSkillRelativePath', () => {
  it.each([
    ['', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['\\\\server\\share\\x', 'UNC'],
    ['C:\\Windows\\win.ini', 'drive letter'],
    ['references/a.md:stream', 'alternate data stream'],
    ['../outside/secret.txt', 'parent'],
    ['references/../../x', 'nested parent'],
    ['.git/config', 'dot segment'],
    ['references/.hidden', 'dot file'],
    ['con', 'device'],
    ['NUL.txt', 'device with extension'],
    ['references/a.md.', 'trailing dot'],
    ['bad|name', 'illegal character'],
    ['a\0b', 'NUL'],
    ['a'.repeat(300), 'too long'],
  ])('refuses %j (%s)', (requested) => {
    expect('reason' in normaliseSkillRelativePath(requested)).toBe(true);
  });

  it('normalises separators, dot and empty segments', () => {
    expect(normaliseSkillRelativePath('references\\.\\a.md')).toEqual({
      segments: ['references', 'a.md'],
    });
    expect(normaliseSkillRelativePath('./references//a.md')).toEqual({
      segments: ['references', 'a.md'],
    });
  });
});

describe('resolveSkillPath', () => {
  it('resolves a file and the folder itself inside the skill', async () => {
    const { root } = makeSkill();
    const file = await resolveSkillPath(root, 'references/a.md');
    expect(file).toMatchObject({ ok: true, value: { relative: 'references/a.md' } });
    const folder = await resolveSkillPath(root, '.');
    expect(folder).toMatchObject({ ok: true, value: { relative: '' } });
    const references = await resolveSkillPath(root, 'references');
    expect(references).toMatchObject({ ok: true, value: { relative: 'references' } });
  });

  it('reports a missing file as NOT_FOUND and a lexical violation as INVALID_ARGUMENT', async () => {
    const { root } = makeSkill();
    expect(await resolveSkillPath(root, 'references/none.md')).toMatchObject({
      ok: false,
      failure: { code: 'NOT_FOUND' },
    });
    expect(await resolveSkillPath(root, '../outside/secret.txt')).toMatchObject({
      ok: false,
      failure: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('reports a missing skill folder as NOT_FOUND', async () => {
    const { root } = makeSkill();
    expect(await resolveSkillPath(path.join(root, 'gone'), 'a.md')).toMatchObject({
      ok: false,
      failure: { code: 'NOT_FOUND' },
    });
  });

  it('refuses a link that leaves the skill folder', async () => {
    const { root, outside } = makeSkill();
    // A directory junction needs no privilege on Windows; elsewhere it is a symlink.
    symlinkSync(outside, path.join(root, 'escape'), 'junction');
    expect(await resolveSkillPath(root, 'escape/secret.txt')).toMatchObject({
      ok: false,
      failure: { code: 'ACCESS_DENIED' },
    });
    expect(await resolveSkillPath(root, 'escape')).toMatchObject({
      ok: false,
      failure: { code: 'ACCESS_DENIED' },
    });
  });

  it('refuses a file symlink that leaves the skill folder when the platform allows one', async () => {
    const { root, outside } = makeSkill();
    try {
      symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'), 'file');
    } catch {
      return;
    }
    expect(await resolveSkillPath(root, 'link.txt')).toMatchObject({
      ok: false,
      failure: { code: 'ACCESS_DENIED' },
    });
  });

  it('allows a link whose target stays inside the skill folder', async () => {
    const { root } = makeSkill();
    symlinkSync(path.join(root, 'references'), path.join(root, 'alias'), 'junction');
    expect(await resolveSkillPath(root, 'alias/a.md')).toMatchObject({
      ok: true,
      value: { relative: 'alias/a.md' },
    });
  });
});
