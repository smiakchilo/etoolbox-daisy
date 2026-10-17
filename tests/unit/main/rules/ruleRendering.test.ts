import { describe, expect, it } from 'vitest';
import {
  PROJECT_PLACEHOLDER,
  RULES_PLACEHOLDER,
  renderGenericRules,
  renderProjectRules,
} from '../../../../src/main/rules/ruleRendering';
import { REAL_PROJECT_RULES_TEMPLATE, REAL_RULES_TEMPLATE } from '../../../support/promptResources';

const rule = (name: string, body: string) => ({ name, projects: [] as string[], body });

describe('renderGenericRules', () => {
  it('is empty when there are no rules', () => {
    expect(renderGenericRules(REAL_RULES_TEMPLATE, [])).toBe('');
  });

  it('puts every rule, named and in order, where the placeholder was', () => {
    const rendered = renderGenericRules(`Intro\n\n${RULES_PLACEHOLDER}\n\nOutro`, [
      rule('first', 'One'),
      rule('second', 'Two'),
    ]);
    expect(rendered).toBe('Intro\n\n### first\n\nOne\n\n### second\n\nTwo\n\nOutro');
  });

  it('leaves a rule body that looks like a placeholder or a replacement pattern as written', () => {
    const rendered = renderGenericRules(RULES_PLACEHOLDER, [rule('r', '$& {{rules}} $1')]);
    expect(rendered).toContain('$& {{rules}} $1');
  });

  it('renders with the real template', () => {
    const rendered = renderGenericRules(REAL_RULES_TEMPLATE, [rule('house', 'Be brief')]);
    expect(rendered).toContain('### house');
    expect(rendered).not.toContain(RULES_PLACEHOLDER);
  });

  it.each([
    ['no placeholder', 'Nothing here'],
    ['two placeholders', `${RULES_PLACEHOLDER} ${RULES_PLACEHOLDER}`],
  ])('throws for a template with %s, even when there are no rules', (_label, template) => {
    expect(() => renderGenericRules(template, [])).toThrow();
  });
});

describe('renderProjectRules', () => {
  it('is empty when the project has no rules', () => {
    expect(renderProjectRules(REAL_PROJECT_RULES_TEMPLATE, 'Acme', [])).toBe('');
  });

  it('names the project around the rules, never inside them', () => {
    const template = `For ${PROJECT_PLACEHOLDER}:\n\n${RULES_PLACEHOLDER}\n\nEnd`;
    const rendered = renderProjectRules(template, 'Acme', [rule('r', 'About {{project}}')]);
    expect(rendered).toBe('For Acme:\n\n### r\n\nAbout {{project}}\n\nEnd');
  });

  it('renders with the real template', () => {
    const rendered = renderProjectRules(REAL_PROJECT_RULES_TEMPLATE, 'Acme', [rule('r', 'Body')]);
    expect(rendered).toContain('Acme');
    expect(rendered).toContain('### r');
    expect(rendered).not.toContain(RULES_PLACEHOLDER);
  });

  it.each([
    ['no rules placeholder', PROJECT_PLACEHOLDER],
    ['no project placeholder', RULES_PLACEHOLDER],
  ])('throws for a template with %s', (_label, template) => {
    expect(() => renderProjectRules(template, 'Acme', [])).toThrow();
  });
});
