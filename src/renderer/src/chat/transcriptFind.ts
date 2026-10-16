import type { FindController, FindState } from '../shell/findController';

/**
 * Find-in-page for the chat transcript.
 *
 * Chromium's `findInPage` cannot be scoped to a subtree: run on the shell
 * document it also matched the query text in the find bar's own field and the
 * composer's placeholder, and its matches and stepping wandered between those
 * and the transcript instead of walking the transcript's own occurrences. The
 * chat bar therefore searches the transcript subtree directly, case-insensitively,
 * and highlights with the CSS Custom Highlight API - ranges, not DOM edits - so
 * the transcript the view owns is never modified and a repaint only needs a
 * {@link FindController.refresh}.
 */

export interface FindMatch {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
/** Non-content elements the transcript never legitimately needs searched. */
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'INPUT', 'TEXTAREA']);

function collectTextNodes(root: Node, out: Text[]): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      out.push(child as Text);
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const element = child as HTMLElement;
    // Hidden content is not on screen to highlight (a collapsed tool-call
    // detail); a form control's value is not transcript text.
    if (element.hidden || SKIPPED_TAGS.has(element.tagName)) continue;
    collectTextNodes(element, out);
  }
}

/** Case-insensitive occurrences of `query` within `root`, in document order. */
export function collectFindMatches(root: Node, query: string): FindMatch[] {
  if (query === '') return [];
  const needle = query.toLowerCase();
  const nodes: Text[] = [];
  collectTextNodes(root, nodes);
  const matches: FindMatch[] = [];
  for (const node of nodes) {
    const haystack = node.data.toLowerCase();
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) break;
      matches.push({ node, start: index, end: index + needle.length });
      from = index + needle.length;
    }
  }
  return matches;
}

const MATCH_HIGHLIGHT = 'daisy-find-match';
const ACTIVE_HIGHLIGHT = 'daisy-find-current';

interface HighlightSupport {
  readonly all: Highlight;
  readonly active: Highlight;
}

/** The Custom Highlight API, or `undefined` where it is unavailable (jsdom). */
function highlightSupport(): HighlightSupport | undefined {
  if (typeof Highlight === 'undefined') return undefined;
  if (typeof CSS === 'undefined' || CSS.highlights === undefined) return undefined;
  return { all: new Highlight(), active: new Highlight() };
}

export function createTranscriptFindController(root: HTMLElement): FindController {
  const highlight = highlightSupport();
  let query = '';
  let matches: FindMatch[] = [];
  let activeIndex = -1;
  const listeners = new Set<(state: FindState) => void>();

  function emit(): void {
    const state: FindState = {
      matches: matches.length,
      activeMatchOrdinal: activeIndex < 0 ? 0 : activeIndex + 1,
    };
    for (const listener of listeners) listener(state);
  }

  function rangeOf(match: FindMatch): Range {
    const range = root.ownerDocument.createRange();
    range.setStart(match.node, match.start);
    range.setEnd(match.node, match.end);
    return range;
  }

  function applyHighlights(): void {
    if (highlight === undefined) return;
    highlight.all.clear();
    highlight.active.clear();
    for (const match of matches) highlight.all.add(rangeOf(match));
    const active = matches[activeIndex];
    if (active !== undefined) highlight.active.add(rangeOf(active));
    CSS.highlights.set(MATCH_HIGHLIGHT, highlight.all);
    CSS.highlights.set(ACTIVE_HIGHLIGHT, highlight.active);
  }

  /**
   * Brings the active match into view when it is off screen. The offset is
   * computed from the match's own rect rather than `scrollIntoView`, which would
   * stop at the enclosing block (a long paragraph is one block, not one line).
   */
  function scrollActiveIntoView(): void {
    const active = matches[activeIndex];
    if (active === undefined) return;
    const range = rangeOf(active);
    // jsdom has no layout, so a range has no rect there.
    if (typeof range.getBoundingClientRect !== 'function') return;
    const rect = range.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    if (rect.top >= view.top && rect.bottom <= view.bottom) return;
    root.scrollTop += rect.top - view.top - (view.height - rect.height) / 2;
  }

  function recompute(keepActive: boolean): void {
    matches = collectFindMatches(root, query);
    if (matches.length === 0) activeIndex = -1;
    else if (activeIndex < 0) activeIndex = 0;
    else if (activeIndex >= matches.length) activeIndex = matches.length - 1;
    else if (!keepActive) activeIndex = 0;
    applyHighlights();
    emit();
  }

  return {
    setQuery(next: string): void {
      query = next;
      activeIndex = 0;
      recompute(false);
      scrollActiveIntoView();
    },
    step(forward: boolean): void {
      if (matches.length === 0) return;
      const count = matches.length;
      activeIndex = forward ? (activeIndex + 1) % count : (activeIndex - 1 + count) % count;
      applyHighlights();
      emit();
      scrollActiveIntoView();
    },
    stop(): void {
      query = '';
      matches = [];
      activeIndex = -1;
      applyHighlights();
      emit();
    },
    refresh(): void {
      if (query === '') return;
      recompute(true);
    },
    subscribe(listener: (state: FindState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      listeners.clear();
      if (highlight !== undefined && typeof CSS !== 'undefined' && CSS.highlights !== undefined) {
        CSS.highlights.delete(MATCH_HIGHLIGHT);
        CSS.highlights.delete(ACTIVE_HIGHLIGHT);
      }
    },
  };
}
