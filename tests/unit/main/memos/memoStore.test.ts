import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GENERIC_MEMOS_MAX_BYTES,
  createMemoStore,
  memoSlug,
  memoTimestamp,
} from '../../../../src/main/memos/memoStore';
import { MEMO_TEXT_MAX_BYTES, MEMO_TITLE_MAX_LENGTH } from '../../../../src/shared';
import { createScratchDirs } from '../../../support/scratchDirs';

const scratch = createScratchDirs('memo-store', 'memo-store-');
const FIXED = new Date(2026, 9, 18, 9, 5, 7);

afterEach(() => {
  scratch.cleanup();
});

function makeStore(options: { skills?: readonly string[] } = {}) {
  const directory = path.join(scratch.create(), 'memos');
  const skills = new Set(options.skills ?? ['search']);
  const store = createMemoStore({
    directory,
    isKnownSkill: (name) => skills.has(name),
    now: () => FIXED,
  });
  return { directory, store };
}

function writeRaw(directory: string, relative: string, content: string): void {
  const target = path.join(directory, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

describe('memoTimestamp and memoSlug', () => {
  it('formats the local clock as YYYYMMDD-HHMMSS', () => {
    expect(memoTimestamp(FIXED)).toBe('20261018-090507');
  });

  it('reduces a title to lower-case ASCII words joined by dashes', () => {
    expect(memoSlug('  Include BOTH paths, not one! ')).toBe('include-both-paths-not-one');
    expect(memoSlug('Ünïcödé')).toBe('unicode');
  });

  it('falls back when nothing of the title survives', () => {
    expect(memoSlug('???')).toBe('memo');
  });
});

describe('MemoStore.write', () => {
  it('writes a generic memo with front matter and returns its record', async () => {
    const { directory, store } = makeStore();

    const outcome = await store.write(
      { title: 'Tables  show both paths', text: 'Line one\r\nLine two\n', trigger: 'correction' },
      { chatId: 'chat-1' },
    );

    if (!outcome.ok) throw new Error(outcome.error.message);
    expect(outcome.value.skill).toBeUndefined();
    expect(outcome.value.title).toBe('Tables show both paths');
    expect(outcome.value.id).toBe(`generic/${outcome.value.fileName}`);
    const content = readFileSync(path.join(directory, 'generic', outcome.value.fileName), 'utf8');
    expect(content).toContain('trigger: correction');
    expect(content).toContain('chat: chat-1');
    expect(content).toContain(`created: ${FIXED.toISOString()}`);
    expect(content.endsWith('Line one\nLine two\n')).toBe(true);
  });

  it('writes a skill memo under its skill folder', async () => {
    const { directory, store } = makeStore();

    const outcome = await store.write({
      title: 'Search tip',
      text: 'Use roots',
      skill: 'search',
      trigger: 'request',
    });

    expect(outcome).toMatchObject({ ok: true, value: { skill: 'search' } });
    expect(readdirSync(path.join(directory, 'skills', 'search'))).toHaveLength(1);
  });

  it('suffixes a name that collides within the same second', async () => {
    const { directory, store } = makeStore();

    await store.write({ title: 'Same', text: 'first', trigger: 'request' });
    await store.write({ title: 'Same', text: 'second', trigger: 'request' });

    const names = readdirSync(path.join(directory, 'generic'));
    expect(new Set(names).size).toBe(2);
  });

  it.each([
    ['an empty title', { title: '   ', text: 'x' }],
    ['a long title', { title: 'x'.repeat(MEMO_TITLE_MAX_LENGTH + 1), text: 'x' }],
    ['an empty text', { title: 't', text: ' \n ' }],
    ['an oversized text', { title: 't', text: 'x'.repeat(MEMO_TEXT_MAX_BYTES + 1) }],
  ])('refuses %s', async (_label, fields) => {
    const { directory, store } = makeStore();

    const outcome = await store.write({ ...fields, trigger: 'request' });

    expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(existsSync(directory)).toBe(false);
  });

  it.each(['unknown', '../escape'])('refuses the skill %s', async (skill) => {
    const { store } = makeStore();

    const outcome = await store.write({ title: 't', text: 'x', skill, trigger: 'request' });

    expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });

  it('refuses an identical text in the same scope, but not in another', async () => {
    const { store } = makeStore();
    await store.write({ title: 'a', text: 'same lesson', trigger: 'request' });

    const again = await store.write({ title: 'b', text: ' same lesson ', trigger: 'request' });
    const elsewhere = await store.write({
      title: 'c',
      text: 'same lesson',
      skill: 'search',
      trigger: 'request',
    });

    expect(again).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(elsewhere.ok).toBe(true);
  });

  it('reports a storage failure when the folder cannot be created', async () => {
    const blocker = path.join(scratch.create(), 'memos');
    writeFileSync(blocker, 'a file where the folder should be');
    const store = createMemoStore({ directory: blocker, isKnownSkill: () => true });

    const outcome = await store.write({ title: 't', text: 'x', trigger: 'request' });

    expect(outcome).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
  });
});

describe('MemoStore loading', () => {
  it('returns no memos for a missing folder', async () => {
    const { store } = makeStore();
    expect(await store.generic()).toEqual({ memos: [], skipped: 0 });
    expect(await store.forSkill('search')).toEqual({ memos: [], skipped: 0 });
  });

  it('loads newest first and reads a hand-written file', async () => {
    const { directory, store } = makeStore();
    writeRaw(directory, 'generic/20260101-000000-old.md', '---\ntitle: Old one\n---\n\nold body');
    writeRaw(directory, 'generic/20260201-000000-new.md', 'no front matter at all');

    const loaded = await store.generic();

    expect(loaded.skipped).toBe(0);
    expect(loaded.memos).toEqual([
      {
        id: 'generic/20260201-000000-new.md',
        title: '20260201-000000-new',
        body: 'no front matter at all',
      },
      { id: 'generic/20260101-000000-old.md', title: 'Old one', body: 'old body' },
    ]);
  });

  it('keeps the body of a file whose front matter is broken', async () => {
    const { directory, store } = makeStore();
    writeRaw(directory, 'generic/a.md', '---\ntitle: [unclosed\n---\n\nstill a lesson');

    const loaded = await store.generic();

    expect(loaded.memos.map((memo) => memo.body)).toEqual(['still a lesson']);
  });

  it('skips empty, oversized and non-markdown files, counting the memo files', async () => {
    const { directory, store } = makeStore();
    writeRaw(directory, 'generic/empty.md', '---\ntitle: t\n---\n\n   ');
    writeRaw(directory, 'generic/huge.md', 'x'.repeat(MEMO_TEXT_MAX_BYTES + 10));
    writeRaw(directory, 'generic/notes.txt', 'ignored');
    writeRaw(directory, 'generic/.hidden.md', 'ignored');
    writeRaw(directory, 'generic/ok.md', 'kept');

    const loaded = await store.generic();

    expect(loaded.memos.map((memo) => memo.id)).toEqual(['generic/ok.md']);
    expect(loaded.skipped).toBe(2);
  });

  it('counts the memos that do not fit the scope budget', async () => {
    const { directory, store } = makeStore();
    const body = 'x'.repeat(MEMO_TEXT_MAX_BYTES - 100);
    const total = Math.ceil(GENERIC_MEMOS_MAX_BYTES / body.length) + 2;
    for (let index = 0; index < total; index += 1) {
      writeRaw(directory, `generic/${String(index).padStart(3, '0')}.md`, `${body}${index}`);
    }

    const loaded = await store.generic();

    expect(loaded.memos.length).toBeGreaterThan(0);
    expect(loaded.skipped).toBeGreaterThan(0);
    expect(loaded.memos.length + loaded.skipped).toBe(total);
    // Newest first: the highest-numbered files are the ones kept.
    expect(loaded.memos[0]?.id).toBe(`generic/${String(total - 1).padStart(3, '0')}.md`);
  });

  it('loads one skill and refuses a malformed skill name', async () => {
    const { store } = makeStore();
    await store.write({ title: 't', text: 'skill lesson', skill: 'search', trigger: 'request' });

    expect((await store.forSkill('search')).memos.map((memo) => memo.body)).toEqual([
      'skill lesson',
    ]);
    expect(await store.forSkill('../generic')).toEqual({ memos: [], skipped: 0 });
  });
});

describe('MemoStore.locate', () => {
  it('locates a written memo', async () => {
    const { store } = makeStore();
    const outcome = await store.write({ title: 't', text: 'x', trigger: 'request' });
    if (!outcome.ok) throw new Error(outcome.error.message);

    const located = await store.locate(outcome.value.id);
    expect(located !== undefined && existsSync(located)).toBe(true);
  });

  it.each(['generic/../../outside.md', '../outside.md', 'generic/a.txt', 'other/a.md'])(
    'refuses the id %s',
    async (id) => {
      const { directory, store } = makeStore();
      writeRaw(path.dirname(directory), 'outside.md', 'not a memo');

      expect(await store.locate(id)).toBeUndefined();
    },
  );
});
