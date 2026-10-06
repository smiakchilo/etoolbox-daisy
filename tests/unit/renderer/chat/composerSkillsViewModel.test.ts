import { describe, expect, it } from 'vitest';
import {
  EMPTY_SKILL_MENU,
  isSkillMenuOpen,
  moveSkillMenuSelection,
  readSkillFragment,
  refreshSkillMenu,
  resolveSkillMenuKey,
  skillAcceptValue,
  type SkillMenuState,
} from '../../../../src/renderer/src/chat/composerSkillsViewModel';
import type { AgentChatSkill } from '../../../../src/shared';

const SKILLS: readonly AgentChatSkill[] = [
  { name: 'search', description: 'Building a query.' },
  { name: 'query-results', description: 'Reading a query result.' },
  { name: 'semantic-search', description: 'Semantic search.' },
];

describe('readSkillFragment', () => {
  it('returns the text after a leading slash, including the empty fragment', () => {
    expect(readSkillFragment('/')).toBe('');
    expect(readSkillFragment('/search')).toBe('search');
  });

  it('returns undefined once whitespace ends the token, or for a non-leading slash', () => {
    expect(readSkillFragment('/search ')).toBeUndefined();
    expect(readSkillFragment('/search query')).toBeUndefined();
    expect(readSkillFragment('plain')).toBeUndefined();
    expect(readSkillFragment('use /s')).toBeUndefined();
    expect(readSkillFragment('')).toBeUndefined();
  });
});

describe('refreshSkillMenu', () => {
  it('closes for a non-reference or with no catalogue', () => {
    expect(refreshSkillMenu(EMPTY_SKILL_MENU, 'plain', SKILLS)).toBe(EMPTY_SKILL_MENU);
    expect(refreshSkillMenu(EMPTY_SKILL_MENU, '/search', [])).toBe(EMPTY_SKILL_MENU);
  });

  it('lists every skill on a lone slash, and filters by prefix', () => {
    expect(refreshSkillMenu(EMPTY_SKILL_MENU, '/', SKILLS).suggestions).toBe(SKILLS);
    expect(refreshSkillMenu(EMPTY_SKILL_MENU, '/s', SKILLS).suggestions.map((s) => s.name)).toEqual(
      ['search', 'semantic-search'],
    );
  });

  it('closes when nothing matches or the name is finished', () => {
    expect(refreshSkillMenu(EMPTY_SKILL_MENU, '/nope', SKILLS)).toBe(EMPTY_SKILL_MENU);
    expect(refreshSkillMenu(EMPTY_SKILL_MENU, '/search ', SKILLS)).toBe(EMPTY_SKILL_MENU);
  });

  it('keeps the highlight while it is still in range, else falls back to the first row', () => {
    const onThird: SkillMenuState = {
      ...refreshSkillMenu(EMPTY_SKILL_MENU, '/', SKILLS),
      selectedIndex: 2,
    };

    // Two matches now, index 2 is out of range - falls back to the first row.
    expect(refreshSkillMenu(onThird, '/s', SKILLS).selectedIndex).toBe(0);
    // Still three matches - the highlight is kept.
    expect(refreshSkillMenu(onThird, '/', SKILLS).selectedIndex).toBe(2);
  });
});

describe('isSkillMenuOpen', () => {
  it('is true only when there is something to suggest', () => {
    expect(isSkillMenuOpen(EMPTY_SKILL_MENU)).toBe(false);
    expect(isSkillMenuOpen(refreshSkillMenu(EMPTY_SKILL_MENU, '/', SKILLS))).toBe(true);
  });
});

describe('moveSkillMenuSelection', () => {
  const open = refreshSkillMenu(EMPTY_SKILL_MENU, '/', SKILLS);

  it('moves and wraps in both directions', () => {
    expect(moveSkillMenuSelection(open, 1).selectedIndex).toBe(1);
    expect(moveSkillMenuSelection(open, -1).selectedIndex).toBe(2);
  });

  it('is a no-op when nothing is suggested', () => {
    expect(moveSkillMenuSelection(EMPTY_SKILL_MENU, 1)).toBe(EMPTY_SKILL_MENU);
  });
});

describe('skillAcceptValue', () => {
  it('is the name, preceded by a slash and followed by a space', () => {
    expect(skillAcceptValue(SKILLS[0] as AgentChatSkill)).toBe('/search ');
  });
});

describe('resolveSkillMenuKey', () => {
  it('maps the navigation and dismissal keys', () => {
    expect(resolveSkillMenuKey('Escape', false)).toBe('dismiss');
    expect(resolveSkillMenuKey('ArrowDown', false)).toBe('next');
    expect(resolveSkillMenuKey('ArrowUp', false)).toBe('previous');
    expect(resolveSkillMenuKey('Tab', false)).toBe('accept');
  });

  it('never claims Enter, so it always submits; Shift+Tab is left alone', () => {
    expect(resolveSkillMenuKey('Enter', false)).toBe('ignore');
    expect(resolveSkillMenuKey('Tab', true)).toBe('ignore');
    expect(resolveSkillMenuKey('a', false)).toBe('ignore');
  });
});
