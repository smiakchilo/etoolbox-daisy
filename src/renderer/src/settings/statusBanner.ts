/**
 * The Settings panel's one status slot, and the aggregation that feeds it.
 *
 * The Settings surface shows exactly one message at a time. The row is owned
 * by the browser pane (`browserPane.ts`), not by the Settings panel: it lives
 * in the pane's page panel directly below the view slot, so save feedback
 * survives the panel being dismissed (a panel-owned row was hidden with the
 * panel, losing the "Settings saved" acknowledgement and any save error). It
 * shares the `banner-row` base class, styles and height with the browser
 * pane's navigation row (`lib/alertBanner.ts`, `styles/banner.css`), plus its
 * own `surface-status-banner` surface class - the class split keeps Playwright
 * strict-mode locators targeting the *browser* banner
 * (`.browser-toolbar-message`) from matching two elements. Every mutation
 * status the sections used to render as per-field paragraphs now arrives here
 * (see the step-09/10 handoff): auto-save feedback, validation errors,
 * two-click confirmations, and password set/clear results.
 *
 * Single-slot priority, `prompt > error > notice > status > standing`:
 * - `showStatus` is transient (auto-clears) and never displaces an error, a
 *   notice or a prompt - the actionable thing stays on screen.
 * - `showNotice` is sticky, dismissible, and carries one inline action (the
 *   chat pane's "Table exported to CSV. <Open in folder>" row). It outranks a
 *   transient status but yields to an error, so a failure still wins the row.
 * - `showError` is sticky and dismissible; it never displaces a prompt.
 *   `clearError` drops only the error row (restoring the floor beneath it),
 *   which is how the chat pane discards an error the user has moved on from -
 *   a new prompt, a new session, or a different conversation - without
 *   touching a prompt or the floor.
 * - `showPrompt` is sticky, dismissible, and replaces anything.
 * - `setStanding` is the persistent floor: shown only while no `show*`
 *   presentation is active, and restored when one clears. The chat pane
 *   expresses its standing conditions this way rather than as a second
 *   `sp-alert-banner`, so one pane can never stack two banners: the "no usable
 *   agent" prompt (a plain row), the composer's "Connecting to agent..." row
 *   (the shared `"loading"` presentation - light-gray fill + progress line)
 *   and its send-blocked reason (a plain row). A plain floor row carries the
 *   shared close control like any other message; dismissing it hides the floor
 *   until its condition changes. A `"loading"` floor row does not (the shared
 *   presentation rule - see `lib/alertBanner.ts`).
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
 * `createSaveReporter` turns the concurrent auto-saves (each IPC call,
 * wrapped by `reportSave`) into one "Saving\u2026" -> "Settings saved"
 * / first-error sequence, so a label save and a proxy save happening in the
 * same instant don't fight over the single slot.
 */

import {
  applyBannerPresentation,
  BANNER_ACTION_MARKER,
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
  /**
   * Sticky, dismissible notice with one inline action - the chat pane's
   * "Exported to table-….csv <Open in folder>" row after a successful export.
   * Ranks below an error and above a transient status, so a failure still wins
   * the single row. Activating the action also dismisses the notice (a one-shot
   * acknowledgement the reader has just acted on).
   */
  showNotice(copy: string, action: StatusBannerAction): void;
  /** Hides whatever is showing. */
  clear(): void;
  /**
   * True while a confirm prompt is on screen. Optional so a section's test
   * double need not implement it; a section that rebuilds its rows uses it to
   * avoid tearing down the row a confirmation is anchored to.
   */
  isPromptShowing?(): boolean;
}

export interface StatusBanner extends StatusBannerSink {
  readonly element: HTMLElement;
  /** True while a sticky two-click/action prompt row is showing. */
  isPromptShowing(): boolean;
  /**
   * Drops a showing error row and falls back to whatever is beneath it (the
   * standing floor, or nothing). A no-op when the active presentation is not an
   * error, so a caller can assert "no stale error" without disturbing a prompt
   * or the floor. Unlike {@link clear}, it leaves the standing content and its
   * dismissal state intact - the chat pane uses it to discard an error the user
   * has moved on from (a new prompt, a new session, a different conversation).
   */
  clearError(): void;
  /**
   * Sets the banner's persistent, lowest-priority content - the row shown
   * whenever no `showStatus`/`showError`/`showPrompt` presentation is active.
   * `null` clears it. A later presentation takes the single row (the standing
   * content swaps out in place); when that presentation clears, the standing
   * content returns. Passing the same content reference and presentation again
   * is a no-op, so a caller can re-assert its standing state on every refresh
   * without churning the DOM.
   *
   * A plain floor row is dismissible like any other message; dismissing it
   * hides the floor until its content changes (the next `setStanding` with a
   * different reference clears the dismissal). A `"loading"` floor row carries
   * no close control.
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

/**
 * Raises the app's single destructive-confirmation prompt in a surface's alert
 * banner: a sticky, one-button row reading `Press {action} to <phrase>`. Every
 * surface that destroys something - Settings removing a host, a project or a
 * proxy, and History deleting a stored conversation - goes through this one
 * method, so the framing, the "OK" label and the one-button rule are identical
 * everywhere and no second confirmation UI exists to drift from them.
 *
 * `onConfirm` runs on the button press. A caller that must refuse a stale press
 * - the Settings sections disarm a pending removal when their row is edited -
 * guards inside its own callback; this method only raises the prompt. A caller
 * whose confirmed work reports through the banner must drop this prompt first
 * (a prompt outranks the status/error it would otherwise mask).
 */
export function confirmDestructiveAction(
  status: StatusBannerSink,
  phrase: string,
  onConfirm: () => void,
): void {
  status.showPrompt(`Press ${BANNER_ACTION_MARKER} to ${phrase}`, {
    label: 'OK',
    onActivate: onConfirm,
  });
}

/** The standing floor's two presentations: an ordinary row, or the loading one. */
export type StatusBannerStandingPresentation = 'plain' | 'loading';

type BannerSlot = 'status' | 'notice' | 'error' | 'prompt';

const SLOT_RANK: Readonly<Record<BannerSlot, number>> = {
  status: 1,
  notice: 2,
  error: 3,
  prompt: 4,
};

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
   * Defaults to `surface-status-banner` (the browser pane's panel-status row);
   * the chat pane passes `chat-status-banner` so the two slots never collide
   * in a Playwright strict-mode locator.
   */
  readonly surfaceClassName?: string;
}

export function createStatusBanner(options: StatusBannerOptions = {}): StatusBanner {
  const autoClearMs = options.autoClearMs ?? STATUS_AUTO_CLEAR_MS;
  const banner = createBannerRow(options.surfaceClassName ?? 'surface-status-banner');
  configureBannerTransition(banner, BANNER_TRANSITION_DURATION_MS);

  let slot: BannerSlot | null = null;
  // What is painted into the row right now, and a signature of that content.
  // `present` short-circuits when it is asked for the *same* thing, so a
  // repeated presentation (e.g. the address-confirm prompt re-affirmed by a
  // commit, or "Saving\u2026" re-asserted) does not tear the row
  // down and rebuild it - which would detach an action button the user (or a
  // test) is clicking. `slot` deliberately still clears immediately on
  // `clear()`; this is only about avoiding a needless rebuild.
  let renderedSlot: BannerSlot | null = null;
  let renderedSignature: string | null = null;
  let standing: readonly Node[] | null = null;
  let standingPresentation: StatusBannerStandingPresentation = 'plain';
  // Set when the user dismisses the standing floor. The floor stays hidden
  // until its condition changes (`setStanding` with different content clears
  // this), so a persistent prompt the user has acknowledged does not spring
  // back on the next status refresh.
  let standingDismissed = false;
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
    // A hidden row carries no close control (the shared presentation rule),
    // and the loading fill/progress line go with the content - a later plain
    // row must not inherit them.
    applyBannerPresentation(banner, 'hidden');
    // The row is empty now, so it renders nothing.
    renderedSlot = null;
    renderedSignature = null;
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
    // Cancel any collapse already in flight before starting another. Without
    // this, a second `hideRow` overwrote `collapseTimer` with a new timeout and
    // orphaned the first, which then fired later and emptied whatever row was
    // on screen by then - tearing down a confirmation the user was clicking.
    if (collapseTimer !== null) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
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
  // tears the row down when there is none or the user has dismissed it. A
  // plain floor row is an ordinary message - it carries the shared close
  // control (the presentation rule); a `"loading"` floor ("Connecting to
  // agent...") does not. A `"loading"` presentation also adds the shared light
  // fill and the indeterminate progress line at the row's top edge (the same
  // rendering as the browser pane's "Loading\u2026").
  function showStanding(): void {
    if (standing === null || standingDismissed) {
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
    applyBannerPresentation(banner, loading ? 'loading' : 'default');
    banner.setAttribute('open', '');
    renderedSlot = null;
    renderedSignature = null;
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

  function present(next: BannerSlot, content: readonly Node[], signature: string): boolean {
    if (!canShow(next)) return false;
    cancelAutoClear();
    // The same presentation is already on screen and not mid-collapse: keep it
    // rather than rebuilding (see `renderedSignature`).
    if (collapseTimer === null && renderedSlot === next && renderedSignature === signature) {
      return true;
    }
    // A row mid-collapse is torn down first so the new message reveals from
    // scratch (re-adding `open` replays the reveal keyframes).
    const wasVisible = banner.hasAttribute('open') && !isBannerClosing(banner);
    if (collapseTimer !== null) finalizeHide();
    slot = next;
    banner.replaceChildren(...content);
    // The shared close-control rule: a transient status (auto-clearing, nothing
    // to wave away) has no close control; error/notice/prompt rows do, like the
    // browser row. This also drops the standing floor's loading fill - only
    // `showStanding` applies it.
    applyBannerPresentation(banner, next === 'status' ? 'transient' : 'default');
    banner.setAttribute('open', '');
    renderedSlot = next;
    renderedSignature = signature;
    // Already showing: a same-height content swap (status -> error) must not
    // replay the reveal. A fresh row (or one cancelled mid-collapse) reveals.
    if (!wasVisible) revealBannerRow(banner);
    return true;
  }

  function inlineActionContent(copy: string, action: StatusBannerAction): readonly Node[] {
    // A size-s `sp-action-button`, exactly like the browser banner's OK
    // buttons (browserToolbar.ts) - deliberately NOT an accent `sp-button`,
    // so the confirm/notice reads as a status-strip action, not a blocking
    // dialog.
    const actionButton = createBannerActionButton(action.label);
    actionButton.addEventListener('click', () => action.onActivate());
    return buildBannerPrompt(copy, [actionButton]);
  }

  // Same contract as the browser banner (browserToolbar.ts): the component's
  // own close control dispatches a cancelable `close` event - prevent the
  // default so this module keeps full control of `open`, then reclaim the row.
  banner.addEventListener('close', (event) => {
    event.preventDefault();
    if (slot !== null) {
      // A live status/error/prompt: drop it and fall back to the floor (if any).
      dismissSlot();
      return;
    }
    // The standing floor itself: hide it until its condition changes.
    standingDismissed = true;
    hideRow();
  });

  return {
    get element() {
      return banner;
    },
    isPromptShowing(): boolean {
      return slot === 'prompt';
    },
    clearError(): void {
      // Only an error row is dropped; a prompt outranks an error, so `slot`
      // being `'error'` already rules out a live prompt, and the standing floor
      // is untouched (dismissSlot falls back to it, respecting `standingDismissed`).
      if (slot !== 'error') return;
      dismissSlot();
    },
    showStatus(message: string): void {
      if (!present('status', [buildBannerCopy([message])], `status:${message}`)) return;
      autoClearTimer = setTimeout(() => {
        if (slot === 'status') dismissSlot();
      }, autoClearMs);
    },
    showError(message: string): void {
      present('error', [buildBannerCopy([message])], `error:${message}`);
    },
    showNotice(copy: string, action: StatusBannerAction): void {
      // Activating a notice's action also dismisses the notice: it is a one-shot
      // acknowledgement, and the reader has just acted on it. Only the notice
      // slot is dropped (so a newer error that took the row meanwhile is left
      // alone), falling back to the standing floor.
      present(
        'notice',
        inlineActionContent(copy, {
          label: action.label,
          onActivate: () => {
            if (slot === 'notice') dismissSlot();
            action.onActivate();
          },
        }),
        `notice:${copy}:${action.label}`,
      );
    },
    showPrompt(copy: string, action: StatusBannerAction): void {
      present('prompt', inlineActionContent(copy, action), `prompt:${copy}:${action.label}`);
    },
    setStanding(
      content: readonly Node[] | null,
      presentation: StatusBannerStandingPresentation = 'plain',
    ): void {
      if (standing === content && standingPresentation === presentation) return;
      standing = content;
      standingPresentation = presentation;
      // A new condition clears a previous dismissal - the floor may show again.
      standingDismissed = false;
      // A live presentation owns the row; the floor is repainted when it
      // clears (dismissSlot). Otherwise the floor is what shows.
      if (slot === null) showStanding();
    },
    clear(): void {
      standing = null;
      standingPresentation = 'plain';
      standingDismissed = false;
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
 * Collapses the many concurrent saves (one per section/row) into
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
