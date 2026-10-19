import { describe, expect, it } from 'vitest';
import { memoFileRequestSchema, memoIdSchema, parseMemosIpcResult } from '../../../src/shared';

describe('memoIdSchema', () => {
  it('accepts a generic and a per-skill memo id', () => {
    expect(memoIdSchema.safeParse('generic/20261018-101530-include-both-paths.md').success).toBe(
      true,
    );
    expect(memoIdSchema.safeParse('skills/search/20261018-101530-2-page-titles.md').success).toBe(
      true,
    );
  });

  it('rejects a traversal, an absolute path, a backslash and a foreign extension', () => {
    for (const id of [
      '../generic/20261018-101530-x.md',
      'generic/../../settings.json',
      'C:/memos/generic/20261018-101530-x.md',
      'generic\\20261018-101530-x.md',
      'skills/../20261018-101530-x.md',
      'generic/20261018-101530-x.txt',
      'other/20261018-101530-x.md',
    ]) {
      expect(memoIdSchema.safeParse(id).success).toBe(false);
    }
  });
});

describe('memoFileRequestSchema', () => {
  it('accepts exactly an id', () => {
    const id = 'generic/20261018-101530-x.md';
    expect(memoFileRequestSchema.safeParse({ id }).success).toBe(true);
    expect(memoFileRequestSchema.safeParse({ id, extra: 1 }).success).toBe(false);
  });
});

describe('parseMemosIpcResult', () => {
  it('passes a well-formed result and refuses anything else', () => {
    expect(parseMemosIpcResult({ ok: true })).toEqual({ ok: true });
    expect(
      parseMemosIpcResult({ ok: false, error: { code: 'not_found', message: 'gone' } }).ok,
    ).toBe(false);
    expect(() => parseMemosIpcResult({ nope: 1 })).toThrow();
  });
});
