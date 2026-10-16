/**
 * The contract a find bar drives, so the bar's UI is independent of how (and
 * where) a match is actually found.
 *
 * Two implementations exist:
 *
 *  - `createNativeFindController` (`nativeFind.ts`) drives Chromium's
 *    `findInPage` over a whole `WebContents` - used for the AEM pane, whose
 *    document only the AEM view holds.
 *  - `createTranscriptFindController` (`chat/transcriptFind.ts`) searches the
 *    chat transcript subtree directly, because Chromium's find cannot be scoped
 *    and searching the shell document matched the find bar's own field and the
 *    composer.
 */
export interface FindState {
  /** Total matches in the searched document, or `0` when there is no query. */
  readonly matches: number;
  /** The 1-based position of the active match, or `0` when there is none. */
  readonly activeMatchOrdinal: number;
}

export interface FindController {
  /**
   * Starts a new search for `text`, resetting the active match to the first.
   * An empty `text` clears the search entirely.
   */
  setQuery(text: string): void;
  /** Moves the active match one step in `forward`'s direction, wrapping at either end. */
  step(forward: boolean): void;
  /** Clears the search: no matches, no highlight. */
  stop(): void;
  /** Re-runs the current query against the searched content (e.g. after it was rebuilt). */
  refresh(): void;
  /** Subscribes to match-count changes; returns an unsubscribe function. */
  subscribe(listener: (state: FindState) => void): () => void;
  dispose(): void;
}
