import { describe, expect, it } from 'vitest';
import { parseSkillsOpenFolderResult } from '../../../src/shared';

describe('parseSkillsOpenFolderResult', () => {
  it('accepts success and a coded failure', () => {
    expect(parseSkillsOpenFolderResult({ ok: true })).toEqual({ ok: true });
    const failure = { ok: false, error: { code: 'open_failed', message: 'no' } };
    expect(parseSkillsOpenFolderResult(failure)).toEqual(failure);
  });

  it('rejects an unknown code, an extra key and an oversized message', () => {
    expect(() =>
      parseSkillsOpenFolderResult({ ok: false, error: { code: 'nope', message: 'x' } }),
    ).toThrow();
    expect(() => parseSkillsOpenFolderResult({ ok: true, extra: 1 })).toThrow();
    expect(() =>
      parseSkillsOpenFolderResult({
        ok: false,
        error: { code: 'open_failed', message: 'x'.repeat(501) },
      }),
    ).toThrow();
  });
});
