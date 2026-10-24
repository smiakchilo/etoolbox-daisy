import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GENERIC_RULES_MAX_BYTES,
  PROJECT_RULES_MAX_BYTES,
  RULE_FILE_MAX_BYTES,
  type RuleRejection,
  createRuleStore,
} from '../../../../src/main/rules/ruleStore';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('rule-store', 'rules-');
afterEach(() => scratch.cleanup());

function makeRoot(files: Record<string, string>): string {
  const root = scratch.create();
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(root, name), content, 'utf8');
  }
  return root;
}

async function loadStore(files: Record<string, string>) {
  const rejections: RuleRejection[] = [];
  const store = createRuleStore({
    directory: makeRoot(files),
    onRejected: (rejection) => rejections.push(rejection),
  });
  await store.load();
  return { store, rejections };
}

const names = (rules: readonly { name: string }[]): string[] => rules.map((rule) => rule.name);

describe('createRuleStore', () => {
  it('is empty when the folder does not exist', async () => {
    const store = createRuleStore({ directory: path.join(scratch.create(), 'missing') });
    await store.load();
    expect(store.generic()).toEqual([]);
    expect(store.forProject('Acme')).toEqual([]);
    expect(store.rejections()).toEqual([]);
  });

  it('splits generic and project rules and sorts each by name', async () => {
    const { store } = await loadStore({
      'zeta.md': 'Z',
      'alpha.md': 'A',
      'scoped-b.md': '---\nproject: Acme\n---\nB',
      'scoped-a.md': '---\nproject: [Acme, Other]\n---\nA',
    });
    expect(names(store.generic())).toEqual(['alpha', 'zeta']);
    expect(names(store.forProject('Acme'))).toEqual(['scoped-a', 'scoped-b']);
    expect(names(store.forProject('Other'))).toEqual(['scoped-a']);
  });

  it('matches a project label trimmed and case-insensitively, and never a blank or unknown one', async () => {
    const { store } = await loadStore({ 'r.md': '---\nproject: Acme Site\n---\nBody' });
    expect(names(store.forProject('  ACME site '))).toEqual(['r']);
    expect(store.forProject('')).toEqual([]);
    expect(store.forProject('Acme')).toEqual([]);
  });

  it('keeps the file name without extension as the rule name', async () => {
    const { store } = await loadStore({ 'House Style.MD': 'Body' });
    expect(names(store.generic())).toEqual(['House Style']);
  });

  it('ignores other extensions, dot-files, folders and empty bodies silently', async () => {
    const root = makeRoot({
      'note.txt': 'x',
      '.hidden.md': 'x',
      'empty.md': '---\nproject: Acme\n---\n   \n',
      'kept.md': 'Kept',
    });
    mkdirSync(path.join(root, 'sub.md'));
    writeFileSync(path.join(root, 'sub.md', 'nested.md'), 'nested', 'utf8');
    const rejections: RuleRejection[] = [];
    const store = createRuleStore({ directory: root, onRejected: (r) => rejections.push(r) });
    await store.load();
    expect(names(store.generic())).toEqual(['kept']);
    expect(store.forProject('Acme')).toEqual([]);
    expect(rejections).toEqual([]);
  });

  it('rejects a rule with an unreadable scope instead of loading it', async () => {
    const { store, rejections } = await loadStore({ 'bad.md': '---\nproject: 5\n---\nBody' });
    expect(store.generic()).toEqual([]);
    expect(rejections).toHaveLength(1);
    expect(store.rejections()).toEqual(rejections);
  });

  it('rejects a file larger than the per-file limit', async () => {
    const { store, rejections } = await loadStore({
      'big.md': 'x'.repeat(RULE_FILE_MAX_BYTES + 1),
      'ok.md': 'ok',
    });
    expect(names(store.generic())).toEqual(['ok']);
    expect(rejections).toHaveLength(1);
  });

  it('rejects whole the rule that would overflow the generic budget', async () => {
    const chunk = 'x'.repeat(RULE_FILE_MAX_BYTES - 100);
    const files: Record<string, string> = {};
    const fitting = Math.floor(GENERIC_RULES_MAX_BYTES / chunk.length);
    for (let index = 0; index <= fitting; index += 1) files[`r${index}.md`] = chunk;
    const { store, rejections } = await loadStore(files);
    expect(store.generic()).toHaveLength(fitting);
    expect(rejections).toHaveLength(1);
  });

  it('budgets each project separately', async () => {
    const chunk = 'x'.repeat(PROJECT_RULES_MAX_BYTES - 10);
    const { store, rejections } = await loadStore({
      'a.md': `---\nproject: One\n---\n${chunk}`,
      'b.md': `---\nproject: One\n---\n${chunk}`,
      'c.md': `---\nproject: Two\n---\n${chunk}`,
    });
    expect(names(store.forProject('One'))).toEqual(['a']);
    expect(names(store.forProject('Two'))).toEqual(['c']);
    expect(rejections).toHaveLength(1);
  });

  it('shares one read between load() calls', async () => {
    const root = makeRoot({ 'a.md': 'A' });
    const store = createRuleStore({ directory: root });
    await store.load();
    writeFileSync(path.join(root, 'b.md'), 'B', 'utf8');
    await store.load();
    expect(names(store.generic())).toEqual(['a']);
  });

  it('reload() picks up added and removed files and reports the count', async () => {
    const root = makeRoot({ 'a.md': 'A' });
    const store = createRuleStore({ directory: root });
    await store.load();
    expect(store.count()).toBe(1);
    writeFileSync(path.join(root, 'b.md'), 'B', 'utf8');
    await store.reload();
    expect(names(store.generic())).toEqual(['a', 'b']);
    expect(store.count()).toBe(2);
    rmSync(path.join(root, 'a.md'));
    await store.reload();
    expect(names(store.generic())).toEqual(['b']);
  });

  it('reload() replaces earlier rejections instead of accumulating them', async () => {
    const root = makeRoot({ 'big.md': 'x'.repeat(RULE_FILE_MAX_BYTES + 1) });
    const store = createRuleStore({ directory: root });
    await store.load();
    expect(store.rejections()).toHaveLength(1);
    await store.reload();
    expect(store.rejections()).toHaveLength(1);
    rmSync(path.join(root, 'big.md'));
    await store.reload();
    expect(store.rejections()).toEqual([]);
  });

  it('does not follow a link to a file outside the folder', async () => {
    const outside = makeRoot({ 'evil.md': 'Evil' });
    const root = makeRoot({ 'good.md': 'Good' });
    try {
      symlinkSync(path.join(outside, 'evil.md'), path.join(root, 'linked.md'), 'file');
    } catch {
      // Creating a file symlink needs a privilege some Windows accounts lack.
      return;
    }
    const store = createRuleStore({ directory: root });
    await store.load();
    expect(names(store.generic())).toEqual(['good']);
  });
});
