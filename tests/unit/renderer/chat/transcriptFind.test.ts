import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectFindMatches,
  createTranscriptFindController,
} from '../../../../src/renderer/src/chat/transcriptFind';
import type { FindState } from '../../../../src/renderer/src/shell/findController';
import { installJsdomGlobals } from '../../../support/jsdomGlobals';

/**
 * The chat transcript's own find (`chat/transcriptFind.ts`).
 *
 * Chromium's `findInPage` cannot be scoped, so the chat seeks matches in the
 * transcript subtree directly. The pure collector is fully tested here; the
 * controller is driven with a fake Custom Highlight API (jsdom has none) to
 * assert the ranges it registers and the count it reports.
 */

class FakeHighlight extends Set<Range> {}

let restoreGlobals: () => void;
let highlights: Map<string, FakeHighlight>;

beforeEach(() => {
  highlights = new Map();
  ({ restore: restoreGlobals } = installJsdomGlobals({
    extraGlobals: {
      Highlight: FakeHighlight,
      CSS: { highlights },
    },
  }));
});

afterEach(() => {
  restoreGlobals();
});

/** A transcript-shaped root: two messages, the second with a hidden detail. */
function buildRoot(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML =
    '<div class="msg">Cinnamon roll</div>' +
    '<div class="msg"><span>cinnamon</span> and <b>cinnamon</b></div>' +
    '<div class="msg" hidden>hidden cinnamon</div>';
  return root;
}

describe('collectFindMatches', () => {
  it('returns nothing for an empty query', () => {
    expect(collectFindMatches(buildRoot(), '')).toEqual([]);
  });

  it('finds every occurrence, case-insensitively, in document order', () => {
    const matches = collectFindMatches(buildRoot(), 'cinnamon');

    expect(matches).toHaveLength(3);
    for (const match of matches) {
      expect(match.node.data.slice(match.start, match.end).toLowerCase()).toBe('cinnamon');
    }
    // Document order: the first message, then the second message's two.
    expect(matches[0]?.node.data).toContain('Cinnamon roll');
    expect(matches[1]?.node.data).toBe('cinnamon');
    expect(matches[2]?.node.data).toBe('cinnamon');
  });

  it('skips hidden subtrees (a collapsed tool-call detail)', () => {
    const matches = collectFindMatches(buildRoot(), 'cinnamon');

    expect(matches.some((match) => match.node.data.includes('hidden'))).toBe(false);
  });

  it('skips form-control values and non-content elements', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<input value="cinnamon"><textarea>cinnamon</textarea><style>.cinnamon{}</style><p>cinnamon</p>';

    const matches = collectFindMatches(root, 'cinnamon');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.node.data).toBe('cinnamon');
  });
});

describe('createTranscriptFindController', () => {
  it('reports the match count and the first match as active', () => {
    const controller = createTranscriptFindController(buildRoot());
    const states: FindState[] = [];
    controller.subscribe((state) => states.push(state));

    controller.setQuery('cinnamon');

    expect(states.at(-1)).toEqual({ matches: 3, activeMatchOrdinal: 1 });
    controller.dispose();
  });

  it('steps forward and backward, wrapping at both ends', () => {
    const controller = createTranscriptFindController(buildRoot());
    const states: FindState[] = [];
    controller.subscribe((state) => states.push(state));
    controller.setQuery('cinnamon');

    controller.step(true);
    expect(states.at(-1)?.activeMatchOrdinal).toBe(2);
    controller.step(true);
    expect(states.at(-1)?.activeMatchOrdinal).toBe(3);
    controller.step(true);
    expect(states.at(-1)?.activeMatchOrdinal).toBe(1);
    controller.step(false);
    expect(states.at(-1)?.activeMatchOrdinal).toBe(3);
    controller.dispose();
  });

  it('clears the search on stop', () => {
    const controller = createTranscriptFindController(buildRoot());
    const states: FindState[] = [];
    controller.subscribe((state) => states.push(state));
    controller.setQuery('cinnamon');

    controller.stop();

    expect(states.at(-1)).toEqual({ matches: 0, activeMatchOrdinal: 0 });
    expect(highlights.get('daisy-find-match')?.size).toBe(0);
    controller.dispose();
  });

  it('recomputes on refresh, keeping the active match', () => {
    const root = buildRoot();
    const controller = createTranscriptFindController(root);
    let last: FindState | undefined;
    controller.subscribe((state) => {
      last = state;
    });
    controller.setQuery('cinnamon');
    controller.step(true);

    // A repaint replaces the transcript's DOM; the ranges would be stale.
    const replacement = document.createElement('div');
    replacement.innerHTML = '<div class="msg">cinnamon cinnamon cinnamon cinnamon</div>';
    root.replaceChildren(replacement);
    controller.refresh();

    expect(last).toEqual({ matches: 4, activeMatchOrdinal: 2 });
    expect(highlights.get('daisy-find-match')?.size).toBe(4);
    controller.dispose();
  });

  it('registers all-match and active ranges with the Custom Highlight API', () => {
    const controller = createTranscriptFindController(buildRoot());

    controller.setQuery('cinnamon');

    expect(highlights.get('daisy-find-match')?.size).toBe(3);
    expect(highlights.get('daisy-find-current')?.size).toBe(1);
    controller.dispose();
  });

  it('removes its highlights on dispose', () => {
    const controller = createTranscriptFindController(buildRoot());
    controller.setQuery('cinnamon');

    controller.dispose();

    expect(highlights.has('daisy-find-match')).toBe(false);
    expect(highlights.has('daisy-find-current')).toBe(false);
  });

  it('never edits the searched DOM', () => {
    const root = buildRoot();
    const before = root.innerHTML;
    const controller = createTranscriptFindController(root);

    controller.setQuery('cinnamon');
    controller.step(true);

    expect(root.innerHTML).toBe(before);
    controller.dispose();
  });
});
