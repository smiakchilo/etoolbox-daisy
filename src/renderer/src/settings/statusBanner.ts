/**
 * The Settings panel's one status slot, and the aggregation that feeds it.
 *
 * The panel shows exactly one message at a time - a second `sp-alert-banner`
 * appended to the panel surface and pinned to its bottom edge. The row shares
 * the `banner-row` base class, styles and height with the browser pane's
 * status row (`lib/alertBanner.ts`, `styles/banner.css`), plus its own
 * `settings-banner` surface class - the class split keeps Playwright
 * strict-mode locators targeting the *browser* banner
 * (`.browser-toolbar-message`) from matching two elements while Settings is
 * open. Every mutation
 * status the sections used to render as per-field paragraphs now arrives here
 * (see the step-09/10 handoff): auto-save feedback, validation errors,
 * two-click confirmations, and password set/clear results.
 *
 * Single-slot priority, `prompt > error > status > standing`:
 * - `showStatus` is transient (auto-clears) and never displaces an error or
 *   a prompt - the actionable thing stays on screen.
 * - `showError` is sticky and dismissible; it never displaces a prompt.
 * - `showPrompt` is sticky, dismissible, and replaces anything.
 * - `setStanding` is the persistent floor: shown only while no `show*`
 *   presentation is active, and restored when one clears. The chat pane
 *   expresses its standing conditions this way rather than as a second
 *   `sp-alert-banner`, so one pane can never stack two banners: the "no usable
 *   agent" prompt (a plain row), the composer's "Connecting to agent..." row
 *   (the shared `"loading"` presentation - light-gray fill + progress line)
 *   and its send-blocked reason (a plain row).
 * Equal kinds replace equal kinds (the latest message wins). A later
 * presentation therefore always suppresses the former one: it takes the single
 * row, and the standing floor returns when it lets go.
 *
 * The row is revealed/collapsed by animating its block-size (the shared
 * `lib/alertBanner.ts` helpers + `banner.css`), so the tab content above it
 * gives up/recovers the space gradually rather than snapping - the same
 * behaviour as the browser pane's row, which shrinks the native view's
 * reserved rectangle.
 *
 * `createSaveReporter` turns the concurrent auto-saves (each debounced IPC
 * call, wrapped by `reportSave`) into one "Saving\u2026" -> "Settings saved"
 * / first-error sequence, so a label save and a proxy save happening in the
 * same instant don't fight over the single slot.
 */

import {
  BANNER_ROW_LOADING_CLASS,
  BANNER_TRANSITION_DURATION_MS,
  buildBannerCopy,
  buildBannerPrompt,
  collapseBannerRow,
  configureBannerTransition,
  createBannerActionButton,
  createBannerProgressLine,
  createBannerRow,
  isBannerClosing,
  restoreBannerRow,
  revealBannerRow,
} from '../lib/alertBanner';

export interface StatusBannerAction {
  readonly label: string;
  onActivate(): void;
}

/** The status-consuming side of the banner, as injected into each section. */
export interface StatusBannerSink {
  /** Transient message that auto-clears; lowest priority. */
  showStatus(message: string): void;
  /** Sticky, dismissible error row. Does not displace a prompt. */
  showError(message: string): void;
  /** Sticky, dismissible confirm prompt with one action; highest priority. */
  showPrompt(copy: string, action: StatusBannerAction): void;
  /** Hides whatever is showing. */
  clear(): void;
}

export interface StatusBanner extends StatusBannerSink {
  readonly element: HTMLElement;
  /** True while a sticky two-click/action prompt row is showing. */
  isPromptShowing(): boolean;
  /**
   * Sets the banner's persistent, lowest-priority content - the row shown
   * whenever no `showStatus`/`showError`/`showPrompt` presentation is active.
   * `null` clears it. A later presentation takes the single row (the standing
   * content swaps out in place); when that presentation clears, the standing
   * content returns. Passing the same content reference and presentation again
   * is a no-op, so a caller can re-assert its standing state on every refresh
   * without churning the DOM.
   *
   * `presentation` is `"plain"` (the default) for an ordinary row, or
   * `"loading"` for the shared loading presentation - a light-gray fill plus
   * the indeterminate progress line pinned to the row's top edge, exactly as
   * the browser pane's "Loading\u2026" row renders (see `lib/alertBanner.ts`).
   * The chat pane uses `"loading"` for its "Connecting to agent..." row.
   */
  setStanding(
    content: readonly Node[] | null,
    presentation?: StatusBannerStandingPresentation,
  ): void;
  dispose(): void;
}

/** The standing floor's two presentations: an ordinary row, or the loading one. */
export type StatusBannerStandingPresentation = 'plain' | 'loading';

type BannerSlot = 'status' | 'error' | 'prompt';

const SLOT_RANK: Readonly<Record<BannerSlot, number>> = { status: 1, error: 2, prompt: 3 };

/**
 * How long a transient status ("Settings saved", "Host added", ...) stays
 * visible before it auto-clears. Deliberately short: it is only an
 * acknowledgement, and errors/prompts are sticky and unaffected by this.
 */
export const STATUS_AUTO_CLEAR_MS = 1500;

export interface StatusBannerOptions {
  /**
   * How long a transient `showStatus` message stays visible before
   * auto-clearing. Defaults to {@link STATUS_AUTO_CLEAR_MS}.
   */
  readonly autoClearMs?: number;
  /**
   * The row's surface class (the second class after the shared `banner-row`).
   * Defaults to `settings-banner`; the chat pane passes `chat-status-banner`
   * so the two slots never collide in a Playwright strict-mode locator when
   * Settings is open over the chat pane.
   */
  readonly surfaceClassName?: string;
}

export function createStatusBanner(options: StatusBannerOptions = {}): StatusBanner {
  const autoClearMs = options.autoClearMs ?? STATUS_AUTO_CLEAR_MS;
  const banner = createBannerRow(options.surfaceClassName ?? 'settings-banner');
  configureBannerTransition(banner, BANNER_TRANSITION_DURATION_MS);

  let slot: BannerSlot | null = null;
  let standing: readonly Node[] | null = null;
  let standingPresentation: StatusBannerStandingPresentation = 'plain';
  let autoClearTimer: ReturnType<typeof setTimeout> | null = null;
  let collapseTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelAutoClear(): void {
    if (autoClearTimer !== null) {
      clearTimeout(autoClearTimer);
      autoClearTimer = null;
    }
  }

  // The DOM-side closure: `open`/`dismissible` off, children cleared, any
  // in-flight collapse unwound. Calling it while a collapse is scheduled
  // aborts that collapse (the row is gone), so it doubles as the "cancel a
  // pending hide" path in `present`.
  function finalizeHide(): void {
    if (collapseTimer !== null) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    restoreBannerRow(banner);
    // The loading presentation is a property of the row's content, so it goes
    // with the content - a later plain row must not inherit the light fill or
    // the progress line.
    banner.classList.remove(BANNER_ROW_LOADING_CLASS);
    // Same contract as the browser banner (browserToolbar.ts's
    // `finalizeBannerHide`): dismissing also drops `dismissible`, so the
    // closed row carries no leftover close control.
    banner.removeAttribute('dismissible');
    banner.removeAttribute('open');
    banner.replaceChildren();
  }

  // The row collapses rather than vanishing: the shared `--closing` class
  // (banner.css) animates its block-size to 0 while `open` stays up so the
  // host is still displayed, and the DOM is torn down when the animation
  // completes. Under `prefers-reduced-motion` the animation is skipped, so the
  // teardown happens synchronously instead. `isPromptShowing` clears
  // immediately (slot is dropped first), so nothing actionable lingers for the
  // collapse. This only ever tears the row down; it does not touch `slot`, so
  // it can be reused both for "nothing left to show" and as the fallback when
  // the standing floor is empty.
  function hideRow(): void {
    cancelAutoClear();
    if (!banner.hasAttribute('open')) {
      finalizeHide();
      return;
    }
    if (!collapseBannerRow(banner)) {
      finalizeHide();
      return;
    }
    collapseTimer = setTimeout(finalizeHide, BANNER_TRANSITION_DURATION_MS);
  }

  // Paints the standing content (the persistent floor) into the single row, or
  // tears the row down when there is none. Never dismissible: it describes a
  // standing condition, not an error to wave away. A `"loading"` presentation
  // adds the shared light fill and the indeterminate progress line at the
  // row's top edge (the same rendering as the browser pane's "Loading\u2026").
  function showStanding(): void {
    if (standing === null) {
      hideRow();
      return;
    }
    cancelAutoClear();
    const wasVisible = banner.hasAttribute('open') && !isBannerClosing(banner);
    // A row caught mid-collapse is unwound first so new content reveals from
    // scratch rather than resuming a half-finished collapse.
    if (collapseTimer !== null) finalizeHide();
    const loading = standingPresentation === 'loading';
    const children = loading ? [...standing, createBannerProgressLine()] : standing;
    banner.replaceChildren(...children);
    banner.classList.toggle(BANNER_ROW_LOADING_CLASS, loading);
    banner.removeAttribute('dismissible');
    banner.setAttribute('open', '');
    if (!wasVisible) revealBannerRow(banner);
  }

  // Drops whatever `show*` presentation is active and falls back to the
  // standing floor (if any).
  function dismissSlot(): void {
    slot = null;
    if (standing !== null) showStanding();
    else hideRow();
  }

  function canShow(candidate: BannerSlot): boolean {
    return slot === null ? true : SLOT_RANK[candidate] >= SLOT_RANK[slot];
  }

  function present(next: BannerSlot, content: readonly Node[]): boolean {
    if (!canShow(next)) return false;
    cancelAutoClear();
    // A row mid-collapse is torn down first so the new message reveals from
    // scratch (re-adding `open` replays the reveal keyframes).
    const wasVisible = banner.hasAttribute('open') && !isBannerClosing(banner);
    if (collapseTimer !== null) finalizeHide();
    slot = next;
    banner.replaceChildren(...content);
    // A later presentation never inherits the standing floor's loading fill:
    // only `showStanding` applies it, and it is dropped the moment the floor
    // gives way.
    banner.classList.remove(BANNER_ROW_LOADING_CLASS);
    // Transient statuses carry no close control (auto-clearing, nothing to
    // wave away); error/prompt rows are dismissible, like the browser row.
    if (next === 'status') banner.removeAttribute('dismissible');
    else banner.setAttribute('dismissible', '');
    banner.setAttribute('open', '');
    // Already showing: a same-height content swap (status -> error) must not
    // replay the reveal. A fresh row (or one cancelled mid-collapse) reveals.
    if (!wasVisible) revealBannerRow(banner);
    return true;
  }

  function promptContent(copy: string, action: StatusBannerAction): readonly Node[] {
    // A size-s `sp-action-button`, exactly like the browser banner's OK
    // buttons (browserToolbar.ts) - deliberately NOT an accent `sp-button`,
    // so the confirm reads as a status-strip action, not a blocking dialog.
    const actionButton = createBannerActionButton(action.label);
    actionButton.addEventListener('click', () => action.onActivate());
    return buildBannerPrompt(copy, [actionButton]);
  }

  // Same contract as the browser banner (browserToolbar.ts): the component's
  // own close control dispatches a cancelable `close` event - prevent the
  // default so this module keeps full control of `open`, then reclaim the row.
  banner.addEventListener('close', (event) => {
    event.preventDefault();
    dismissSlot();
  });

  return {
    get element() {
      return banner;
    },
    isPromptShowing(): boolean {
      return slot === 'prompt';
    },
    showStatus(message: string): void {
      if (!present('status', [buildBannerCopy([message])])) return;
      autoClearTimer = setTimeout(() => {
        if (slot === 'status') dismissSlot();
      }, autoClearMs);
    },
    showError(message: string): void {
      present('error', [buildBannerCopy([message])]);
    },
    showPrompt(copy: string, action: StatusBannerAction): void {
      present('prompt', promptContent(copy, action));
    },
    setStanding(
      content: readonly Node[] | null,
      presentation: StatusBannerStandingPresentation = 'plain',
    ): void {
      if (standing === content && standingPresentation === presentation) return;
      standing = content;
      standingPresentation = presentation;
      // A live presentation owns the row; the floor is repainted when it
      // clears (dismissSlot). Otherwise the floor is what shows.
      if (slot === null) showStanding();
    },
    clear(): void {
      standing = null;
      standingPresentation = 'plain';
      slot = null;
      hideRow();
    },
    dispose(): void {
      cancelAutoClear();
      finalizeHide();
      banner.remove();
    },
  };
}

/** Outcome of one mutating IPC call, collapsed to what the banner needs. */
export type SaveOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface SaveReporter {
  begin(): void;
  /** `ok` false carries the failure message; `error` is ignored when `ok` is true. */
  settle(ok: boolean, error: string | undefined): void;
}

export interface SaveReporterHandlers {
  /** Fired when the first of a batch of concurrent saves starts. */
  onPendingStart(): void;
  /** Fired when the last of a batch settles; `firstError` is the first failure's message, or `undefined` if all succeeded. */
  onDrained(firstError: string | undefined): void;
}

/**
 * Collapses the many concurrent debounced saves (one per section/row) into
 * one "Saving\u2026" while any is in flight and exactly one outcome once they
 * all settle - the first failure wins, so a batch that half-succeeded is
 * announced honestly instead of as a blanket success.
 */
export function createSaveReporter(handlers: SaveReporterHandlers): SaveReporter {
  let pending = 0;
  let firstError: string | undefined;

  return {
    begin(): void {
      if (pending === 0) handlers.onPendingStart();
      pending += 1;
    },
    settle(ok: boolean, error: string | undefined): void {
      if (pending === 0) return;
      if (!ok && firstError === undefined) {
        firstError = error === undefined ? 'Save failed' : error;
      }
      pending -= 1;
      if (pending === 0) {
        const failure = firstError;
        firstError = undefined;
        handlers.onDrained(failure);
      }
    },
  };
}

/**
 * Wires one save (a promise in `SaveOutcome` shape) into a `SaveReporter`.
 * The reporter's settle runs before the caller's own `await` continuation
 * because it is attached first, so a drain that empties the batch is announced
 * before the caller's reload re-renders the section.
 */
export function reportSave(reporter: SaveReporter, outcome: Promise<SaveOutcome>): void {
  reporter.begin();
  void outcome.then(
    (result) => reporter.settle(result.ok, result.ok ? undefined : result.error),
    (error: unknown) =>
      reporter.settle(false, error instanceof Error ? error.message : String(error)),
  );
}
