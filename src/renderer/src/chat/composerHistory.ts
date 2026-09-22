/**
 * Prompt-history recall for the chat composer: a bounded, ordered list of the
 * prompts the user has submitted, plus the cursor that walks it with the
 * Up/Down arrow keys - the behaviour most command harnesses share.
 *
 * The list is ordered oldest to newest. The cursor starts *past* the newest
 * entry, at the "draft" position that represents whatever the user is typing
 * now; the first Up press captures that text as the draft and steps back onto
 * the newest entry, and Down steps forward again until the draft is restored.
 *
 * This module is pure: it touches no DOM and no storage. `composer.ts` owns the
 * keydown wiring, and `lib/composerHistoryStore.ts` owns persistence - so the
 * walk itself can be exercised exhaustively without either.
 */

/** How many submitted prompts are remembered. Older entries are dropped. */
export const COMPOSER_HISTORY_LIMIT = 20;

/** Whether the caret sits at the very start / very end of the field's text. */
export interface CaretBounds {
  readonly atStart: boolean;
  readonly atEnd: boolean;
}

/**
 * Resolves the caret bounds that decide whether an arrow key recalls history or
 * moves the caret inside the (multiline) field.
 *
 * `selection` is `undefined` when the real textarea cannot be read - notably
 * under jsdom, where Spectrum's shadow tree does not exist. An empty field is
 * still treated as both bounds (there is nowhere for the caret to go), and a
 * non-empty one as "not at the start" so a plain Up never hijacks caret
 * movement there.
 */
export function resolveCaretBounds(
  value: string,
  selection: { readonly start: number; readonly end: number } | undefined,
): CaretBounds {
  if (selection === undefined) {
    return { atStart: value.length === 0, atEnd: true };
  }
  return {
    atStart: selection.start === 0 && selection.end === 0,
    atEnd: selection.start === value.length && selection.end === value.length,
  };
}

export interface ComposerHistoryNavigator {
  /** Records a just-submitted prompt as the newest entry and returns to the draft. */
  record(prompt: string): void;
  /**
   * Steps to the previous (older) entry, returning the text to show, or
   * `undefined` when there is nothing older to recall. `currentText` is
   * captured as the draft the first time the walk leaves the draft position.
   */
  previous(currentText: string): string | undefined;
  /**
   * Steps to the next (newer) entry, or back to the captured draft once past
   * the newest entry. Returns `undefined` when already at the draft, so the
   * caller lets the caret move normally.
   */
  next(): string | undefined;
  /** Returns to the draft position, discarding the captured draft text. */
  reset(): void;
  /** Whether the cursor is currently on a remembered entry rather than the draft. */
  isRecalling(): boolean;
  /** The remembered entries, oldest first. */
  entries(): readonly string[];
}

/**
 * Builds a navigator over `initial` (typically loaded from storage). The list
 * is capped to the newest {@link COMPOSER_HISTORY_LIMIT} entries and the cursor
 * starts at the draft position.
 */
export function createComposerHistoryNavigator(
  initial: readonly string[] = [],
): ComposerHistoryNavigator {
  let entries: readonly string[] = initial.slice(-COMPOSER_HISTORY_LIMIT);
  let cursor = entries.length;
  let draft = '';

  return {
    record(prompt) {
      const text = prompt.trim();
      if (text !== '') {
        // Collapse a repeat of the newest entry: hammering the same prompt
        // should not push everything else out of a 20-entry window.
        if (entries[entries.length - 1] !== text) {
          entries = [...entries, text].slice(-COMPOSER_HISTORY_LIMIT);
        }
      }
      cursor = entries.length;
      draft = '';
    },
    previous(currentText) {
      if (entries.length === 0) return undefined;
      if (cursor >= entries.length) {
        draft = currentText;
        cursor = entries.length - 1;
      } else if (cursor > 0) {
        cursor -= 1;
      } else {
        return undefined;
      }
      return entries[cursor];
    },
    next() {
      if (cursor >= entries.length) return undefined;
      cursor += 1;
      return cursor === entries.length ? draft : entries[cursor];
    },
    reset() {
      cursor = entries.length;
      draft = '';
    },
    isRecalling() {
      return cursor < entries.length;
    },
    entries() {
      return entries;
    },
  };
}
