import type { FindController, FindState } from './findController';

/**
 * The AEM pane's find, driven by Chromium's `findInPage` over the pane's own
 * `WebContents` (`browserController.find`). The match highlight is Chromium's
 * own, and the pane's document - not the shell's - is the only one searched, so
 * nothing in the app chrome can ever match.
 *
 * The `found-in-page` count arrives asynchronously; each target's result is
 * forwarded from main and filtered here by `target`, so a pane's bar ignores the
 * other's.
 */
export function createNativeFindController(target: 'browser' | 'chat'): FindController {
  let text = '';
  const listeners = new Set<(state: FindState) => void>();

  function emit(state: FindState): void {
    for (const listener of listeners) listener(state);
  }

  const unsubscribe = window.daisy.browser.onFindResult((result) => {
    if (result.target !== target) return;
    emit({ matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal });
  });

  return {
    setQuery(next: string): void {
      text = next;
      if (next === '') {
        void window.daisy.browser.stopFind({ target });
        emit({ matches: 0, activeMatchOrdinal: 0 });
        return;
      }
      // Electron 44 emits `found-in-page` only for `findNext: true`; a changed
      // text restarts the session at the first match (see the IPC contract).
      void window.daisy.browser.find({ target, text: next, forward: true });
    },
    step(forward: boolean): void {
      if (text === '') return;
      void window.daisy.browser.find({ target, text, forward });
    },
    stop(): void {
      text = '';
      void window.daisy.browser.stopFind({ target });
      emit({ matches: 0, activeMatchOrdinal: 0 });
    },
    refresh(): void {
      // A native session lives in the searched `WebContents`; there is nothing
      // to rebuild here.
    },
    subscribe(listener: (state: FindState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      listeners.clear();
      unsubscribe();
    },
  };
}
