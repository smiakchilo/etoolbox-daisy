import { describe, expect, it } from 'vitest';
import {
  filterSkillsByName,
  readLeadingSkillToken,
  renderSkillInvocationDirective,
  resolveSkillPrompt,
} from '../../../src/shared';

describe('readLeadingSkillToken', () => {
  it('reads the name and the trimmed remainder', () => {
    expect(readLeadingSkillToken('/aem-tool-selection find the title')).toEqual({
      name: 'aem-tool-selection',
      rest: 'find the title',
    });
  });

  it('reads a bare name with no remainder', () => {
    expect(readLeadingSkillToken('/aem-query-results')).toEqual({
      name: 'aem-query-results',
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
    expect(readLeadingSkillToken('/aem-query-results\trest')).toEqual({
      name: 'aem-query-results',
      rest: 'rest',
    });
  });
});

describe('filterSkillsByName', () => {
  const skills = [
    { name: 'aem-tool-selection' },
    { name: 'aem-query-results' },
    { name: 'z-other' },
  ];

  it('matches a case-insensitive prefix, preserving order', () => {
    expect(filterSkillsByName(skills, 'AEM')).toEqual([
      { name: 'aem-tool-selection' },
      { name: 'aem-query-results' },
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
  it('names the skill and the skill tool when there is no remainder', () => {
    const directive = renderSkillInvocationDirective('aem-tool-selection', '');
    expect(directive).toContain('"aem-tool-selection"');
    expect(directive).toContain('`skill` tool');
    expect(directive).toContain('{"skill":"aem-tool-selection"}');
    expect(directive).not.toContain('\n\n');
  });

  it('appends the user request after a blank line', () => {
    expect(renderSkillInvocationDirective('aem-query-results', 'why zero rows?')).toBe(
      `${renderSkillInvocationDirective('aem-query-results', '')}\n\nwhy zero rows?`,
    );
  });
});

describe('resolveSkillPrompt', () => {
  const known = ['aem-tool-selection', 'aem-query-results'];

  it('rewrites a known leading reference into the directive plus the request', () => {
    expect(resolveSkillPrompt('/aem-tool-selection what tool?', known)).toBe(
      `${renderSkillInvocationDirective('aem-tool-selection', 'what tool?')}`,
    );
  });

  it('leaves an unknown leading reference untouched', () => {
    expect(resolveSkillPrompt('/content/wknd/us/en', known)).toBe('/content/wknd/us/en');
  });

  it('leaves ordinary text untouched', () => {
    expect(resolveSkillPrompt('what is on this page?', known)).toBe('what is on this page?');
  });

  it('leaves a known reference untouched when the catalogue is empty', () => {
    expect(resolveSkillPrompt('/aem-tool-selection hi', [])).toBe('/aem-tool-selection hi');
  });
});
