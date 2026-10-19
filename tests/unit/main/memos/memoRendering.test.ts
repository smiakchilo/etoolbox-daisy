import { describe, expect, it } from 'vitest';
import {
  MEMOS_PLACEHOLDER,
  SIGNALS_PLACEHOLDER,
  renderGenericMemos,
  renderReflectionPrompt,
  renderSkillMemos,
} from '../../../../src/main/memos/memoRendering';
import {
  REAL_MEMOS_TEMPLATE,
  REAL_REFLECTION_TEMPLATE,
  REAL_SKILL_MEMOS_TEMPLATE,
} from '../../../support/ruleResources';

const first = { id: 'generic/a.md', title: 'First', body: 'Body one.' };
const second = { id: 'generic/b.md', title: 'Second', body: 'Body $& two.' };

describe('renderGenericMemos', () => {
  it('keeps the guidance even with no memos', () => {
    const rendered = renderGenericMemos(REAL_MEMOS_TEMPLATE, []);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain(MEMOS_PLACEHOLDER);
  });

  it('lists every memo in the given order, a `$&` kept as written', () => {
    const rendered = renderGenericMemos(REAL_MEMOS_TEMPLATE, [first, second]);
    expect(rendered.indexOf('### First')).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf('### First')).toBeLessThan(rendered.indexOf('### Second'));
    expect(rendered).toContain('Body $& two.');
    expect(rendered).not.toMatch(/\n{3,}/);
  });
});

describe('renderSkillMemos', () => {
  it('renders nothing for a skill with no memos', () => {
    expect(renderSkillMemos(REAL_SKILL_MEMOS_TEMPLATE, [])).toBe('');
  });

  it('frames the memos with the template', () => {
    const rendered = renderSkillMemos(REAL_SKILL_MEMOS_TEMPLATE, [first]);
    expect(rendered).toContain('### First\n\nBody one.');
    expect(rendered).not.toContain(MEMOS_PLACEHOLDER);
  });
});

describe('renderReflectionPrompt', () => {
  it('lists one bullet per signal', () => {
    const rendered = renderReflectionPrompt(REAL_REFLECTION_TEMPLATE, ['tool failed', 'loop']);
    expect(rendered).toContain('- tool failed\n- loop');
    expect(rendered).not.toContain(SIGNALS_PLACEHOLDER);
  });
});

describe('memo templates', () => {
  it.each([
    ['generic', (t: string) => renderGenericMemos(t, []), MEMOS_PLACEHOLDER],
    ['skill', (t: string) => renderSkillMemos(t, []), MEMOS_PLACEHOLDER],
    ['reflection', (t: string) => renderReflectionPrompt(t, []), SIGNALS_PLACEHOLDER],
  ])('throw for a %s template without exactly one placeholder', (_kind, render, placeholder) => {
    expect(() => render('no placeholder')).toThrow();
    expect(() => render(`${placeholder} ${placeholder}`)).toThrow();
  });
});
