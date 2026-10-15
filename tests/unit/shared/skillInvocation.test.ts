import { describe, expect, it } from 'vitest';
import {
  SKILL_TOOL_NAME,
  filterSkillsByName,
  readLeadingSkillToken,
  renderSkillCatalogue,
  renderSkillInvocationDirective,
  resolveSkillPrompt,
} from '../../../src/shared';
import { REAL_SKILLS_TEMPLATE } from '../../support/instructionResources';

describe('readLeadingSkillToken', () => {
  it('reads the name and the trimmed remainder', () => {
    expect(readLeadingSkillToken('/aem-tool-selection find the title')).toEqual({
      name: 'aem-tool-selection',
      rest: 'find the title',
    });
  });

  it('reads a bare name with no remainder', () => {
    expect(readLeadingSkillToken('/query-results')).toEqual({
      name: 'query-results',
      rest: '',
    });
  });

  it('keeps a slash-bearing token intact (the caller decides if it names a skill)', () => {
    expect(readLeadingSkillToken('/content/wknd/us/en')).toEqual({
      name: 'content/wknd/us/en',
      rest: '',
    });
  });

  it('rejects a lone slash, an empty value, and leading whitespace', () => {
    expect(readLeadingSkillToken('/')).toBeUndefined();
    expect(readLeadingSkillToken('')).toBeUndefined();
    expect(readLeadingSkillToken(' /aem-tool-selection')).toBeUndefined();
  });

  it('ignores a slash that is not the very first character', () => {
    expect(readLeadingSkillToken('use /aem-tool-selection')).toBeUndefined();
  });

  it('treats a tab after the name as the end of the token', () => {
    expect(readLeadingSkillToken('/query-results\trest')).toEqual({
      name: 'query-results',
      rest: 'rest',
    });
  });
});

describe('filterSkillsByName', () => {
  const skills = [{ name: 'search' }, { name: 'semantic-search' }, { name: 'z-other' }];

  it('matches a case-insensitive prefix, preserving order', () => {
    expect(filterSkillsByName(skills, 'S')).toEqual([
      { name: 'search' },
      { name: 'semantic-search' },
    ]);
  });

  it('matches everything for an empty fragment', () => {
    expect(filterSkillsByName(skills, '')).toBe(skills);
  });

  it('matches nothing for an unknown fragment', () => {
    expect(filterSkillsByName(skills, 'nope')).toEqual([]);
  });
});

describe('renderSkillInvocationDirective', () => {
  it('names the skill when there is no remainder', () => {
    const directive = renderSkillInvocationDirective('aem-tool-selection', '');
    expect(directive).toContain('aem-tool-selection');
    expect(directive).not.toContain('\n\n');
  });

  it('appends the trailing text as the skill input after the plain directive', () => {
    const directive = renderSkillInvocationDirective('query-results', 'why zero rows?');
    expect(directive.startsWith(renderSkillInvocationDirective('query-results', ''))).toBe(true);
    expect(directive.endsWith('why zero rows?')).toBe(true);
  });
});

describe('renderSkillCatalogue', () => {
  const skill = { name: 'search', description: 'Find pages.' };

  it('returns an empty string for an empty catalogue, so no heading is added', () => {
    expect(renderSkillCatalogue(REAL_SKILLS_TEMPLATE, [])).toBe('');
  });

  it('lists every skill name and its model-facing description', () => {
    const block = renderSkillCatalogue(REAL_SKILLS_TEMPLATE, [
      { name: 'search', description: 'Find pages by content.' },
      { name: 'query-results', description: 'Read a query result correctly.' },
    ]);
    expect(block).toContain('- search: Find pages by content.');
    expect(block).toContain('- query-results: Read a query result correctly.');
  });

  it('leaves no placeholder behind and puts the skills last', () => {
    const block = renderSkillCatalogue(REAL_SKILLS_TEMPLATE, [skill]);
    expect(block).not.toContain('{{');
    expect(block.endsWith('- search: Find pages.')).toBe(true);
  });

  it('replaces the skill-tool placeholder everywhere it appears', () => {
    const block = renderSkillCatalogue('{{skillTool}} and {{skillTool}}\n{{catalogue}}', [skill]);
    expect(block).toBe(`${SKILL_TOOL_NAME} and ${SKILL_TOOL_NAME}\n- search: Find pages.`);
  });

  it.each([
    ['no catalogue placeholder', 'Just prose'],
    ['two catalogue placeholders', '{{catalogue}} and {{catalogue}}'],
  ])('throws for a template with %s, even for an empty catalogue', (_name, template) => {
    expect(() => renderSkillCatalogue(template, [skill])).toThrow();
    expect(() => renderSkillCatalogue(template, [])).toThrow();
  });
});

describe('resolveSkillPrompt', () => {
  const known = ['aem-tool-selection', 'query-results'];

  it('rewrites a known leading reference into the directive plus the request', () => {
    expect(resolveSkillPrompt('/aem-tool-selection what tool?', known)).toBe(
      `${renderSkillInvocationDirective('aem-tool-selection', 'what tool?')}`,
    );
  });

  it('leaves an unknown leading reference untouched', () => {
    expect(resolveSkillPrompt('/content/wknd/us/en', known)).toBe('/content/wknd/us/en');
  });

  it('carries a bare search term through as this skill input (the /search Waldo case)', () => {
    const prompt = resolveSkillPrompt('/search Waldo', ['search', 'semantic-search']);
    expect(prompt).toContain('search');
    expect(prompt.trimEnd().endsWith('Waldo')).toBe(true);
    // The literal token is consumed, never shown to the model as a path to read.
    expect(prompt).not.toContain('/search');
  });

  it('leaves ordinary text untouched', () => {
    expect(resolveSkillPrompt('what is on this page?', known)).toBe('what is on this page?');
  });

  it('leaves a known reference untouched when the catalogue is empty', () => {
    expect(resolveSkillPrompt('/aem-tool-selection hi', [])).toBe('/aem-tool-selection hi');
  });
});
