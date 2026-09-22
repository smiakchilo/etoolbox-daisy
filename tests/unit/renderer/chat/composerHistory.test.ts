import { describe, expect, it } from 'vitest';
import {
  COMPOSER_HISTORY_LIMIT,
  createComposerHistoryNavigator,
  resolveCaretBounds,
} from '../../../../src/renderer/src/chat/composerHistory';

describe('resolveCaretBounds', () => {
  it('treats an unreadable selection on an empty field as both bounds', () => {
    expect(resolveCaretBounds('', undefined)).toEqual({ atStart: true, atEnd: true });
  });

  it('treats an unreadable selection on a non-empty field as only the end', () => {
    expect(resolveCaretBounds('typed', undefined)).toEqual({ atStart: false, atEnd: true });
  });

  it('reports the start only when the caret is collapsed at offset 0', () => {
    expect(resolveCaretBounds('abc', { start: 0, end: 0 })).toEqual({
      atStart: true,
      atEnd: false,
    });
  });

  it('reports the end only when the caret is collapsed at the last offset', () => {
    expect(resolveCaretBounds('abc', { start: 3, end: 3 })).toEqual({
      atStart: false,
      atEnd: true,
    });
  });

  it('reports neither bound for a caret in the middle or an active selection', () => {
    expect(resolveCaretBounds('abc', { start: 1, end: 1 })).toEqual({
      atStart: false,
      atEnd: false,
    });
    expect(resolveCaretBounds('abc', { start: 0, end: 3 })).toEqual({
      atStart: false,
      atEnd: false,
    });
  });
});

describe('createComposerHistoryNavigator', () => {
  it('starts at the draft position, not recalling, over the stored entries', () => {
    const history = createComposerHistoryNavigator(['a', 'b']);
    expect(history.entries()).toEqual(['a', 'b']);
    expect(history.isRecalling()).toBe(false);
    expect(history.next()).toBeUndefined();
  });

  it('returns undefined for previous when there is nothing stored', () => {
    expect(createComposerHistoryNavigator().previous('draft')).toBeUndefined();
  });

  it('walks older on repeated previous and stops at the oldest entry', () => {
    const history = createComposerHistoryNavigator(['a', 'b', 'c']);

    expect(history.previous('draft')).toBe('c');
    expect(history.isRecalling()).toBe(true);
    expect(history.previous('draft')).toBe('b');
    expect(history.previous('draft')).toBe('a');
    // Already on the oldest entry: nothing to consume.
    expect(history.previous('draft')).toBeUndefined();
  });

  it('walks newer on next and restores the captured draft past the newest entry', () => {
    const history = createComposerHistoryNavigator(['a', 'b', 'c']);

    history.previous('my draft');
    history.previous('my draft');
    expect(history.isRecalling()).toBe(true);

    expect(history.next()).toBe('c');
    expect(history.next()).toBe('my draft');
    expect(history.isRecalling()).toBe(false);
    // Back at the draft: a further next is not consumed.
    expect(history.next()).toBeUndefined();
  });

  it('captures an empty draft and restores it too', () => {
    const history = createComposerHistoryNavigator(['only']);
    expect(history.previous('')).toBe('only');
    expect(history.next()).toBe('');
  });

  it('records a submitted prompt as the newest entry and returns to the draft', () => {
    const history = createComposerHistoryNavigator(['old']);
    history.previous('draft');
    expect(history.isRecalling()).toBe(true);

    history.record('fresh');

    expect(history.entries()).toEqual(['old', 'fresh']);
    expect(history.isRecalling()).toBe(false);
    expect(history.next()).toBeUndefined();
  });

  it('trims and ignores a blank submission', () => {
    const history = createComposerHistoryNavigator();
    history.record('   ');
    expect(history.entries()).toEqual([]);
  });

  it('collapses a repeat of the newest entry', () => {
    const history = createComposerHistoryNavigator();
    history.record('same');
    history.record('same');
    expect(history.entries()).toEqual(['same']);
  });

  it('keeps only the newest entries up to the limit', () => {
    const history = createComposerHistoryNavigator();
    for (let index = 0; index < COMPOSER_HISTORY_LIMIT + 5; index += 1) {
      history.record(`prompt ${String(index)}`);
    }

    const entries = history.entries();
    expect(entries).toHaveLength(COMPOSER_HISTORY_LIMIT);
    expect(entries[0]).toBe('prompt 5');
    expect(entries[entries.length - 1]).toBe(`prompt ${String(COMPOSER_HISTORY_LIMIT + 4)}`);
  });

  it('caps an over-long initial list to the newest window', () => {
    const initial = Array.from({ length: COMPOSER_HISTORY_LIMIT + 3 }, (_, index) => `p${index}`);
    const history = createComposerHistoryNavigator(initial);
    expect(history.entries()).toHaveLength(COMPOSER_HISTORY_LIMIT);
    expect(history.entries()[0]).toBe('p3');
  });

  it('reset abandons a walk in progress', () => {
    const history = createComposerHistoryNavigator(['a', 'b']);
    history.previous('draft');
    history.reset();

    expect(history.isRecalling()).toBe(false);
    expect(history.next()).toBeUndefined();
    // The next walk captures a fresh draft rather than the abandoned one.
    expect(history.previous('new draft')).toBe('b');
    expect(history.next()).toBe('new draft');
  });
});
