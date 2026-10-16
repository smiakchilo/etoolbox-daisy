import { el } from '../lib/dom';
import type { FindController, FindState } from './findController';

/**
 * One pane's find-in-page bar.
 *
 * Two are created - one above the AEM pane's view slot, one above the chat
 * transcript - and both are this same component. The bar owns only its UI and a
 * debounce; the actual finding is delegated to a {@link FindController}, which
 * is what lets the AEM pane use Chromium's `findInPage` over its own
 * `WebContents` while the chat pane searches just the transcript subtree.
 *
 * Escaping focus and the close control dismiss it, stopping the search so no
 * highlight lingers.
 */
export interface FindBar {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  /** Reveals the bar and focuses its field; re-runs the last query if there was one. */
  open(): void;
  /** Hides the bar and ends the search (clears the highlight). */
  close(): void;
  /** Re-runs the current query, e.g. after the searched content was rebuilt. */
  refresh(): void;
  dispose(): void;
}

export interface FindBarOptions {
  readonly testIdPrefix: string;
  readonly controller: FindController;
}

/**
 * How long typing must pause before the live search runs. A find over a long
 * result table can be expensive in the searched document, so issuing one per
 * keystroke is what makes typing stutter; the paused search gives the same final
 * result without the per-character churn.
 */
export const LIVE_SEARCH_DEBOUNCE_MS = 150;

/** The `sp-textfield` host, plus the shadow input the field exposes once it upgrades. */
type FindField = HTMLElement & {
  value: string;
  focusElement?: HTMLInputElement | HTMLTextAreaElement | null;
  select?: () => void;
};

function buildControl(testId: string, label: string, iconTag: string): HTMLElement {
  const button = el('sp-action-button', {
    attrs: { quiet: '', title: label, 'aria-label': label, 'data-testid': testId },
  });
  const icon = document.createElement(iconTag);
  icon.setAttribute('slot', 'icon');
  button.append(icon);
  return button;
}

export function createFindBar(options: FindBarOptions): FindBar {
  const { controller } = options;
  let open = false;
  let text = '';
  let state: FindState = { matches: 0, activeMatchOrdinal: 0 };

  const field = el('sp-textfield', {
    attrs: {
      class: 'find-bar__field',
      placeholder: 'Find',
      'aria-label': 'Find in page',
      'data-testid': `${options.testIdPrefix}-field`,
    },
  }) as FindField;
  const count = el('span', {
    attrs: {
      class: 'find-bar__count',
      'aria-live': 'polite',
      'data-testid': `${options.testIdPrefix}-count`,
    },
  });
  const previousButton = buildControl(
    `${options.testIdPrefix}-prev`,
    'Previous match',
    'sp-icon-chevron-up',
  );
  const nextButton = buildControl(
    `${options.testIdPrefix}-next`,
    'Next match',
    'sp-icon-chevron-down',
  );
  const closeButton = el('sp-close-button', {
    attrs: {
      class: 'find-bar__close',
      label: 'Close find bar',
      'data-testid': `${options.testIdPrefix}-close`,
    },
  });
  // The field and the match count share one bordered box (like the address
  // bar); the step controls read as one stepper just outside it.
  const box = el('div', {
    attrs: { class: 'find-bar__box' },
    children: [field, count],
  });
  const stepper = el('div', {
    attrs: { class: 'find-bar__stepper' },
    children: [previousButton, nextButton],
  });

  const element = el('div', {
    attrs: { class: 'find-bar', 'data-testid': options.testIdPrefix },
    children: [box, stepper, closeButton],
  });
  element.hidden = true;

  let debounceHandle: ReturnType<typeof setTimeout> | undefined;

  function cancelDebounce(): void {
    if (debounceHandle !== undefined) {
      clearTimeout(debounceHandle);
      debounceHandle = undefined;
    }
  }

  function renderCount(): void {
    count.textContent = text === '' ? '' : `${state.activeMatchOrdinal}/${state.matches}`;
  }

  const unsubscribe = controller.subscribe((next) => {
    state = next;
    renderCount();
  });

  function openBar(): void {
    if (open) {
      field.select?.();
      field.focus();
      return;
    }
    open = true;
    element.hidden = false;
    cancelDebounce();
    // Re-run the last query so the highlight returns with the bar. A fresh bar
    // has no text, so nothing is issued and the field is simply ready.
    if (text !== '') controller.setQuery(text);
    field.select?.();
    field.focus();
  }

  function closeBar(): void {
    if (!open) return;
    cancelDebounce();
    open = false;
    element.hidden = true;
    controller.stop();
    state = { matches: 0, activeMatchOrdinal: 0 };
    renderCount();
  }

  field.addEventListener('input', () => {
    text = field.value;
    cancelDebounce();
    if (text === '') {
      controller.setQuery('');
      renderCount();
      return;
    }
    debounceHandle = setTimeout(() => {
      debounceHandle = undefined;
      controller.setQuery(text);
    }, LIVE_SEARCH_DEBOUNCE_MS);
    renderCount();
  });

  /**
   * Applies a query that is still waiting out the debounce, so a key that steps
   * (Enter, the controls) never races ahead of it. Returns whether it applied
   * one - in which case the step is skipped: that key showed the first match,
   * and the next key advances.
   */
  function flushPendingQuery(): boolean {
    if (debounceHandle === undefined) return false;
    cancelDebounce();
    controller.setQuery(text);
    return true;
  }

  field.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // The bar is the only thing Escape is closing here (a panel and the bar
      // are mutually exclusive), but stop the event so it cannot also reach a
      // document-level handler.
      event.preventDefault();
      event.stopPropagation();
      closeBar();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (text === '' || flushPendingQuery()) return;
    controller.step(!event.shiftKey);
  });

  previousButton.addEventListener('click', () => {
    if (flushPendingQuery()) return;
    controller.step(false);
  });
  nextButton.addEventListener('click', () => {
    if (flushPendingQuery()) return;
    controller.step(true);
  });
  closeButton.addEventListener('click', () => closeBar());

  return {
    element,
    get isOpen() {
      return open;
    },
    open: openBar,
    close: closeBar,
    refresh(): void {
      if (open) controller.refresh();
    },
    dispose(): void {
      cancelDebounce();
      unsubscribe();
      controller.dispose();
    },
  };
}
