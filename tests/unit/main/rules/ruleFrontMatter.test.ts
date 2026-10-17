import { describe, expect, it } from 'vitest';
import {
  normalizeProjectLabel,
  parseRuleMarkdown,
} from '../../../../src/main/rules/ruleFrontMatter';

describe('normalizeProjectLabel', () => {
  it('trims and lower-cases', () => {
    expect(normalizeProjectLabel('  My Site  ')).toBe('my site');
  });
});

describe('parseRuleMarkdown', () => {
  it('treats a file with no front matter as a generic rule', () => {
    expect(parseRuleMarkdown('Always answer briefly.\n')).toEqual({
      ok: true,
      projects: [],
      body: 'Always answer briefly.',
    });
  });

  it('reads one project label, normalized', () => {
    expect(parseRuleMarkdown('---\nproject: " Acme Site "\n---\n\nBody\n')).toEqual({
      ok: true,
      projects: ['acme site'],
      body: 'Body',
    });
  });

  it('reads a list of labels, dropping duplicates', () => {
    const parsed = parseRuleMarkdown('---\nproject:\n  - Alpha\n  - alpha\n  - Beta\n---\nBody');
    expect(parsed).toEqual({ ok: true, projects: ['alpha', 'beta'], body: 'Body' });
  });

  it('is generic when the front matter names no project', () => {
    expect(parseRuleMarkdown('---\nother: 1\n---\nBody')).toEqual({
      ok: true,
      projects: [],
      body: 'Body',
    });
  });

  it('tolerates a byte-order mark and CRLF line endings', () => {
    const parsed = parseRuleMarkdown('\uFEFF---\r\nproject: Acme\r\n---\r\nBody\r\n');
    expect(parsed).toEqual({ ok: true, projects: ['acme'], body: 'Body' });
  });

  it.each([
    ['an unclosed front matter', '---\nproject: Acme\nBody'],
    ['invalid YAML', '---\nproject: [unclosed\n---\nBody'],
    ['a front matter that is not a mapping', '---\n- a\n- b\n---\nBody'],
    ['a numeric project', '---\nproject: 5\n---\nBody'],
    ['a blank project', '---\nproject: "  "\n---\nBody'],
    ['an empty project list', '---\nproject: []\n---\nBody'],
    ['a list holding a non-string', '---\nproject:\n  - Acme\n  - 5\n---\nBody'],
  ])('rejects %s rather than making the rule generic', (_label, markdown) => {
    expect(parseRuleMarkdown(markdown)).toMatchObject({ ok: false });
  });
});
