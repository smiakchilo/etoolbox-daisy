import { describe, expect, it } from 'vitest';
import {
  type SkillActivation,
  SKILL_TOOL_NAME,
  filterSkillsByName,
  readLeadingSkillToken,
  renderSkillActivation,
  renderSkillAlreadyLoadedNote,
  renderSkillCatalogue,
  resolveSkillPrompt,
} from '../../../src/shared';
import { REAL_SKILLS_TEMPLATE } from '../../support/ruleResources';

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
  const activations = new Map<string, SkillActivation>([
    ['search', { name: 'search', body: 'SEARCH-BODY', files: [] }],
    ['query-results', { name: 'query-results', body: 'RESULTS-BODY', files: [] }],
  ]);
  const lookup = (name: string): SkillActivation | undefined => activations.get(name);

  it('inlines the activation, the already-loaded note and the framed input', () => {
    const resolution = resolveSkillPrompt('/search what tool?', lookup);
    const search = activations.get('search') as SkillActivation;
    expect(resolution.activatedSkill).toBe('search');
    expect(resolution.modelPrompt).toContain(renderSkillActivation(search));
    expect(resolution.modelPrompt).toContain(renderSkillAlreadyLoadedNote('search'));
    expect(resolution.modelPrompt.trimEnd().endsWith('what tool?')).toBe(true);
  });

  it('leaves an unknown leading reference untouched', () => {
    expect(resolveSkillPrompt('/content/wknd/us/en', lookup)).toEqual({
      modelPrompt: '/content/wknd/us/en',
    });
  });

  it('carries a bare search term through as this skill input (the /search Waldo case)', () => {
    const { modelPrompt } = resolveSkillPrompt('/search Waldo', lookup);
    expect(modelPrompt.trimEnd().endsWith('Waldo')).toBe(true);
    // The literal token is consumed, never shown to the model as a path to read.
    expect(modelPrompt).not.toContain('/search');
  });

  it('adds no input frame when the user typed only the name', () => {
    const { modelPrompt, activatedSkill } = resolveSkillPrompt('/query-results', lookup);
    expect(activatedSkill).toBe('query-results');
    expect(modelPrompt.trimEnd().endsWith(renderSkillAlreadyLoadedNote('query-results'))).toBe(
      true,
    );
  });

  it('leaves ordinary text untouched', () => {
    expect(resolveSkillPrompt('what is on this page?', lookup)).toEqual({
      modelPrompt: 'what is on this page?',
    });
  });

  it('leaves a known-looking reference untouched when the skill cannot be loaded', () => {
    expect(resolveSkillPrompt('/search hi', () => undefined)).toEqual({
      modelPrompt: '/search hi',
    });
  });

  it('carries the skill memos inside the activation, after the body', () => {
    const { modelPrompt } = resolveSkillPrompt('/search Waldo', lookup, '  SKILL-MEMOS  ');
    const body = modelPrompt.indexOf('SEARCH-BODY');
    const memos = modelPrompt.indexOf('SKILL-MEMOS');
    expect(body).toBeGreaterThanOrEqual(0);
    expect(memos).toBeGreaterThan(body);
    expect(memos).toBeLessThan(modelPrompt.indexOf('</skill>'));
  });
});

describe('renderSkillActivation', () => {
  const search: SkillActivation = { name: 'search', body: 'SEARCH-BODY', files: [] };

  it('is unchanged by empty memos', () => {
    expect(renderSkillActivation(search, '   ')).toBe(renderSkillActivation(search));
  });
});
