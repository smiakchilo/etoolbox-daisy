import { filterSkillsByName, type AgentChatSkill } from '../../../shared';

/**
 * The composer's `/` autocomplete state - the suggestions currently matching
 * the typed token, and which one is highlighted - as pure, DOM-free logic.
 *
 * Splitting it out follows the chat folder's view-model/view separation
 * (`composerViewModel.ts`, `transcriptViewModel.ts`): the state transitions can
 * be exercised exhaustively without a renderer, while the Spectrum popup that
 * draws them lives in `skillPopover.ts`.
 */

export interface SkillMenuState {
  readonly suggestions: readonly AgentChatSkill[];
  readonly selectedIndex: number;
}

/** Nothing to suggest and nothing highlighted. */
export const EMPTY_SKILL_MENU: SkillMenuState = { suggestions: [], selectedIndex: 0 };

/**
 * The fragment of a skill name being typed, or `undefined` when the field is
 * not a bare `/name` reference. A leading `/` on its own yields `''` (every
 * skill is a match); once any whitespace appears the name is complete, so only
 * a leading, space-free token is ever treated as a name.
 */
export function readSkillFragment(value: string): string | undefined {
  if (!value.startsWith('/')) return undefined;
  const fragment = value.slice(1);
  return /\s/.test(fragment) ? undefined : fragment;
}

/**
 * Recomputes the suggestions for `value`, keeping the highlight where it was
 * when it is still in range (and falling back to the first row when the
 * filtered list has shrunk past it). Returns {@link EMPTY_SKILL_MENU} when the
 * field is not a `/name` reference or nothing matches, which closes the menu.
 */
export function refreshSkillMenu(
  state: SkillMenuState,
  value: string,
  skills: readonly AgentChatSkill[],
): SkillMenuState {
  const fragment = readSkillFragment(value);
  if (fragment === undefined || skills.length === 0) return EMPTY_SKILL_MENU;
  const suggestions = filterSkillsByName(skills, fragment);
  if (suggestions.length === 0) return EMPTY_SKILL_MENU;
  const selectedIndex = state.selectedIndex < suggestions.length ? state.selectedIndex : 0;
  return { suggestions, selectedIndex };
}

/** Whether `state` has anything to draw. */
export function isSkillMenuOpen(state: SkillMenuState): boolean {
  return state.suggestions.length > 0;
}

/** Moves the highlight by `delta`, wrapping; a no-op when nothing is suggested. */
export function moveSkillMenuSelection(state: SkillMenuState, delta: number): SkillMenuState {
  const count = state.suggestions.length;
  if (count === 0) return state;
  const selectedIndex = (state.selectedIndex + delta + count) % count;
  return { suggestions: state.suggestions, selectedIndex };
}

/** The field value accepting `skill` produces: the name, preceded by `/` and followed by a space. */
export function skillAcceptValue(skill: AgentChatSkill): string {
  return `/${skill.name} `;
}

/** What an open menu should do with a keydown. */
export type SkillMenuKeyIntent = 'dismiss' | 'next' | 'previous' | 'accept' | 'ignore';

/**
 * Maps a key to its effect on the open menu. Enter is deliberately `ignore` -
 * it must submit, exactly as it does with the menu closed; Tab (without Shift)
 * accepts the highlighted suggestion.
 */
export function resolveSkillMenuKey(key: string, shiftKey: boolean): SkillMenuKeyIntent {
  switch (key) {
    case 'Escape':
      return 'dismiss';
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'previous';
    case 'Tab':
      return shiftKey ? 'ignore' : 'accept';
    default:
      return 'ignore';
  }
}
