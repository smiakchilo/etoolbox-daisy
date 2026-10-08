import { el } from '../lib/dom';
import {
  applyBannerPresentation,
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
import type {
  AddServerResult,
  BrowserIpcVoidResult,
  BrowserNavigationState,
  CertificateBlockedInfo,
} from '../../../shared';
import { SERVER_SWATCHES } from '../../../shared';
import type { HostOption } from './viewModel';
import {
  canOpenInExternalBrowser,
  describeBlockedCertificate,
  describeUnknownOrigin,
  deriveServerLabelFromOrigin,
  findHostAutocomplete,
  resolveAddressChipHost,
  resolveAddressSubmission,
  resolveHostLabelForeground,
  shouldInferAddressCompletion,
} from './viewModel';

/**
 * The left pane's toolbar: Back/Forward/Refresh, a plain text address bar,
 * and a "picker button" coupled to the address field's right edge
 * (requirements-decisions.md section 8).
 *
 * The address bar (`addressField`) is an ordinary `sp-textfield`: typing a
 * URL and pressing Enter navigates exactly as before. The
 * `sp-picker-button` beside it (`hostsButton`) is a combobox-style
 * affordance, not a value-holding control - clicking it asks the owning pane
 * to suspend the native `WebContentsView` and reveal the whole-size hosts
 * list (`hostsPanel.ts`). Selecting a host there calls back into
 * `navigateTo(origin)`, which writes that host's *origin* into the address
 * field and runs it through the exact same `navigate()` call as anything
 * typed directly. With zero configured servers the button stays visible but
 * disabled (see `setHostOptions`), so there is nothing to open.
 *
 * The button reveals its "open" state when the hosts panel is up:
 * `setHostsPickerOpen(true)` sets the `open` attribute, whose `:host([open])`
 * CSS rule gives the pressed look; the pane clears it when the panel closes.
 *
 * Every control here is wired to the real `window.daisy.browser` IPC surface
 * now that it exists. Failures are handled generically per
 * implementation-plan.md step 05: `result.error.message` is always shown
 * (for `network_error` this is already humanised copy - see
 * networkErrorCopy.ts), and only `unknown_origin` gets different treatment
 * (a prompt: the origin is added as a new server via `settings:add-server`,
 * then the address is retried on the normal switchServer path - the toolbar
 * never navigates or auto-creates on its own). A user-initiated stop
 * (`browser:stop`) produces an `ERR_ABORTED` error that is suppressed here
 * as expected behaviour rather than surfaced as an error banner.
 *
 * Untrusted certificates follow a different route from the errors above:
 * main observes the blocked navigation and pushes
 * `browser:certificate-blocked` (with the *decision*, not the page URL),
 * and this module turns it into the banner's most prominent non-loading
 * presentation - a single "OK" `sp-action-button` prompt, structured exactly
 * like the unknown-origin prompt below (a `_copy` span with the button inline
 * in the sentence; cancel is the banner's dismiss cross). The flow guarantees
 * the host is already a managed server by the time this banner can appear:
 * an unknown origin is refused *before* any certificate check and only becomes
 * navigable once the unknown-origin prompt's OK has created the server (see
 * `addOriginServer`), so OK here just attaches the exception to that existing
 * entry - it never creates or re-creates a server. OK asks main to approve
 * it, and clears the row; main then auto-retries the blocked navigation, which
 * surfaces via the normal loading state. Dismissal (the banner's close control)
 * just clears the row: nothing is persisted and nothing is retried. The banner
 * re-appears the next time the address is re-requested (Enter in the address
 * bar or Refresh), because every such re-request re-fires `certificate-error`
 * and main re-pushes the decision - exactly how the unknown-origin prompt
 * re-appears after a dismissal.
 */
export interface BrowserToolbar {
  readonly element: HTMLElement;
  /**
   * A status/prompt row rendered as a sibling of `element`, not nested inside
   * it (keeps `role="toolbar"` clean). An `sp-alert-banner` (neutral
   * variant) whose `open` attribute is its whole show/hide mechanism
   * (`:host{display:none}` / `:host([open]){display:flex}` in the
   * component's own stylesheet) - so nothing here has to fight the
   * component's display rules with a `hidden` attribute. Dismissibility is
   * state-dependent: the loading banner carries no close control (a load in
   * flight is not something to wave away), while error/prompt rows are
   * `dismissible`. The component dispatches a cancelable `close` event when
   * the user dismisses a row; this module prevents the default so it keeps
   * full control of `open`, and listens to reclaim the row. The owning
   * pane groups it with the native view region (`browserPane.ts`'s
   * `browserPagePanel`) so the two hide together; this module only owns when
   * the row is shown/cleared.
   */
  readonly messageElement: HTMLElement;
  /** Refreshes the address bar text and host-selector options for a newly loaded snapshot. */
  setAddressValue(value: string): void;
  /** Refreshes the host-selector options (and the certificate prompt's matching-server state) for a newly loaded snapshot. */
  setHostOptions(options: readonly HostOption[]): void;
  /** Marks the picker button as open (panel visible) or closed. */
  setHostsPickerOpen(open: boolean): void;
  /**
   * Reflects the pane's forced home (welcome) screen onto the chrome. While it
   * is up the address bar is blanked (the screen is not a page, so it has no
   * address) and Back/Forward are disabled (they address the covered page's
   * history, which is not what is on screen). Dismissing the veil restores the
   * covered page's live URL and its history controls. The Home button itself,
   * the host picker and the loading/error row are unaffected - a load the page
   * started keeps reporting, and typing a fresh address is still a navigation
   * that leaves the veil.
   */
  setHomeShown(shown: boolean): void;
  /** Swaps the agent-pane toggle's icon/title between "Close Agent" and "Open Agent". */
  setAgentPaneOpen(open: boolean): void;
  /**
   * Writes `url` into the address field and navigates to it, exactly like a
   * typed address. Used by the hosts picker's selection and by a transcript
   * link (routed here by the shell so every browser navigation - and every
   * navigation failure - is owned by this pane, never the chat pane).
   */
  navigateTo(url: string): void;
  /** Unsubscribes from `onStateChanged`/`onSwitchStateChanged`/`onCertificateBlocked`. */
  dispose(): void;
}

export interface BrowserToolbarCallbacks {
  /** Fired when the picker button is activated; the owning pane opens/closes the panel. */
  onHostsPickerClick(): void;
  /** Fired when the Home button is activated; the owning pane reveals the home screen. */
  onHomeClick(): void;
  /**
   * Fired when a user-initiated navigation begins (a typed/selected address,
   * Back/Forward, or Refresh). The owning pane leaves the home screen when the
   * user navigates away from it, and dismisses any whole-size panel covering
   * the page-view region so the navigation's result is visible. Page-caused
   * navigation never fires this.
   */
  onNavigationStarted?(): void;
  /** Fired when the agent-pane toggle is activated; the shell shows/hides the chat pane. */
  onToggleAgentPane?(): void;
}

/**
 * Icon-only nav button: no visible text label, just the icon plus a
 * `title`/`aria-label` pair so the affordance is still named for sighted
 * mouse users (native tooltip) and assistive tech alike.
 */
function buildNavButton(
  label: string,
  iconTag: string,
  options?: { readonly iconClass?: string },
): HTMLElement {
  const button = el('sp-action-button', {
    attrs: { quiet: '', title: label, 'aria-label': label },
  });
  const icon = document.createElement(iconTag);
  icon.setAttribute('slot', 'icon');
  if (options?.iconClass) {
    icon.setAttribute('class', options.iconClass);
  }
  button.append(icon);
  return button;
}

const LOADING_LABEL = 'Loading\u2026';

/**
 * The `sp-textfield` host, plus the few members the address bar drives on it:
 * `value`, the delegated `focused` flag and shadow `focusElement`, and its
 * `select()` helper. Kept as an intersection rather than `any` so the toolbar
 * stays type-checked while still reaching the Spectrum control's real API.
 */
type AddressField = HTMLElement & {
  value: string;
  focused?: boolean;
  focusElement?: HTMLInputElement | HTMLTextAreaElement | null;
  select?: () => void;
  /** Lit's update barrier; absent in jsdom (the custom element never upgrades). */
  updateComplete?: Promise<unknown>;
};

/**
 * Left inset of the coloured host label inside the address field, the gap
 * between it and the address text, and the field's own resting inline padding.
 * The label's measured width plus the inset and gap is the input left padding
 * that pushes the address text past it.
 */
const ADDRESS_LABEL_LEFT_INSET_PX = 8;
const ADDRESS_LABEL_GAP_PX = 8;
const ADDRESS_FIELD_BASE_INLINE_PADDING_PX = 8;
/**
 * The chip's absolute upper bound, and the slice of the field it must always
 * leave for the address itself (about a handful of characters plus the caret).
 * The live clamp is `field width - insets - this reserve`, so the chip can
 * never reach the field's right border - let alone spill into the picker.
 */
const ADDRESS_LABEL_MAX_PX = 160;
const ADDRESS_LABEL_MIN_ADDRESS_PX = 40;

export function createBrowserToolbar(callbacks: BrowserToolbarCallbacks): BrowserToolbar {
  const toolbar = el('div', { attrs: { class: 'toolbar browser-toolbar', role: 'toolbar' } });

  // Home reveals the pane's home (welcome) screen. Leftmost, like a browser's
  // Home control; the pane owns what "home" means, including closing any open
  // panel. The button is never disabled - the home screen is always available.
  const homeButton = buildNavButton('Home', 'sp-icon-home');
  homeButton.addEventListener('click', () => callbacks.onHomeClick());

  // "Back" reuses Forward's sp-icon-arrow400 glyph, rotated 180deg via CSS
  // (see .nav-icon--back in browser.css) rather than a separate icon asset.
  const backButton = buildNavButton('Back', 'sp-icon-arrow400', { iconClass: 'nav-icon--back' });
  const forwardButton = buildNavButton('Forward', 'sp-icon-arrow400');
  const refreshButton = buildNavButton('Refresh', 'sp-icon-refresh');
  // Nothing is loaded yet (no navigation state has been reported), so there
  // is nothing to go back/forward to until the first `onStateChanged` event.
  backButton.setAttribute('disabled', '');
  forwardButton.setAttribute('disabled', '');

  // The shared banner-row base (lib/alertBanner.ts, styles/banner.css) with
  // the browser surface class. Every row is dismissible by default; the close
  // control is derived centrally by `applyBannerPresentation` (the loading
  // branch drops it, error/prompt rows keep it). The component shows its
  // `sp-close-button` when `dismissible` is set and dispatches a cancelable
  // `close` on click; this module prevents the default so it keeps full
  // control of `open`.
  const messageElement = createBannerRow('browser-toolbar-message');
  configureBannerTransition(messageElement, BANNER_TRANSITION_DURATION_MS);

  // Loading text shown inside the banner — the indefinite progress bar
  // animation is rendered via CSS in banner.css, so no spinner is needed.
  const loadingSpan = el('span', {
    attrs: { class: 'browser-toolbar-message__loading' },
    children: [document.createTextNode(LOADING_LABEL)],
  });

  // Indeterminate progress line pinned to the loading banner's top edge - the
  // shared loading-presentation node (`lib/alertBanner.ts` /
  // `banner.css`'s `.banner-row__progress`), also used by the chat pane's
  // "Connecting to agent..." row. Created once so the DOM node is stable
  // across loading cycles, then swapped in/out of the banner like
  // `loadingSpan`.
  const progressTrack = createBannerProgressLine();

  // The error row's "Reload": re-issues the exact navigation operation that
  // failed (the target that timed out / was unreachable), so the user can
  // retry without retyping. Built once and read `errorRetry` at click time, so
  // it always reflects the currently displayed error.
  const reloadButton = createBannerActionButton('Reload');
  reloadButton.addEventListener('click', () => {
    const retry = errorRetry;
    if (retry !== null) retry();
  });

  // ── State ────────────────────────────────────────────────────────────────
  let lastNavigationState: BrowserNavigationState | null = null;
  let switching = false;
  // Set while the pane's forced home (welcome) screen covers the page-view
  // region. It is not a page: the address bar is blanked and Back/Forward are
  // disabled while it is up (see `applyPresentation` and the state
  // subscription), and dismissing it restores the covered page's URL.
  let homeShown = false;
  // Set when a navigation IPC call reports a failure. That call settles only
  // once the load it awaited has ended (a rejected `loadURL`, or a
  // goBack/goForward/reload that settled), so a still-buffered
  // `isLoading:true` push must not keep the Stop/banner up or mask the error.
  // Cleared by the next navigation-state push.
  let failedNavigation = false;
  let errorText: string | null = null;
  // The action the error row's "Reload" button re-issues: the exact navigation
  // operation that failed (see `NavigationAttempt`). `null` for errors that are
  // not a failed navigation (an add-server failure, an approval failure, ...),
  // which is also what hides the Reload control for them.
  let errorRetry: (() => void) | null = null;
  // Signature of the error row currently painted, so an error that persists
  // across many state pushes (a restored page's redirect/SSO chain) is not
  // rebuilt - and its Reload button not detached mid-click - on every push.
  // Reset whenever another presentation takes the row.
  let renderedErrorSignature: string | null = null;

  // Monotonic id for one issued navigation operation. A recovery (restore of
  // the previous page) only completes if no newer navigation superseded it:
  // the user typing a new address mid-recovery must win over the restore.
  let navigationToken = 0;
  // The blocked-certificate decision main most recently pushed via
  // `browser:certificate-blocked`, or null when no prompt is pending. Cleared
  // by a new navigation (main clears its own auto-retry target at the same
  // boundaries), by Dismiss/the banner close control, and when an approval
  // request is dispatched.
  let blockedCertificate: CertificateBlockedInfo | null = null;
  // The unknown-origin prompt (`browser:navigate`'s `unknown_origin` error):
  // the address the user typed (retried after the server is created) and the
  // canonical origin to store. `url` is captured from the address field at
  // error time, `origin` comes from the IPC error. Cleared by a new
  // navigation, by Dismiss/the banner close control, and when an Add
  // dispatch starts.
  let unknownOriginPrompt: { readonly url: string; readonly origin: string } | null = null;

  // How long a loading state must persist before the loading banner appears.
  // A load that finishes within this window (fast reload, near-instant local
  // server, quick in-page navigation) never shows the banner, so no layout
  // shift happens for the common quick case.
  const LOADING_BANNER_DELAY_MS = 200;
  let loadingBannerTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Banner ───────────────────────────────────────────────────────────────
  // The banner shows (in priority order):
  //  1. "Loading…"+spinner (plus a progress line at the top edge) — any load
  //     is in progress (a server switch, or any navigation the view reports
  //     while `isLoading` is true, whether the toolbar or the page started
  //     it). Pending certificate and unknown-origin prompts are cleared the
  //     moment a new load starts - approving/adding's auto-retry and any
  //     manual navigation both supersede them.
  //  2. The untrusted-certificate prompt — set by `onCertificateBlocked`.
  //  3. The unknown-origin prompt — set by `browser:navigate`'s
  //     `unknown_origin` error.
  //  4. Error copy — set by `handleVoidResult` (network failures, storage
  //     errors).
  //  5. Closed (idle) — no active load and nothing to display.
  //
  // Opening and closing animate the row's block-size (the shared
  // `lib/alertBanner.ts` helpers + `banner.css`), so the native view's
  // reserved rectangle above it shrinks/grows gradually instead of snapping.
  // `open` stays set for the collapse's duration; the content is cleared when
  // the animation completes. Loading is debounced by `LOADING_BANNER_DELAY_MS`:
  // a sustained load arms a timer; if the load ends before the timer fires the
  // banner is never shown (and no layout shift occurs). Error and idle
  // transitions start immediately (their own reveal/collapse then runs). The
  // loading presentation is never dismissible: the close control is reserved
  // for error/prompt rows, where dismissing clears the error copy or the
  // prompt.

  let bannerHideTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelBannerHide(): void {
    if (bannerHideTimer !== null) {
      clearTimeout(bannerHideTimer);
      bannerHideTimer = null;
    }
  }

  /** True when the loading presentation (light row + progress line) is applied. */
  function isLoadingPresentationShown(): boolean {
    return messageElement.classList.contains(BANNER_ROW_LOADING_CLASS);
  }

  function cancelLoadingBanner(): void {
    if (loadingBannerTimer !== null) {
      clearTimeout(loadingBannerTimer);
      loadingBannerTimer = null;
    }
  }

  /**
   * The DOM-side closure: `open`/`dismissible` off, children cleared, any
   * in-flight collapse unwound. Called when the collapse animation completes
   * (or synchronously under reduced motion).
   */
  function finalizeBannerHide(): void {
    cancelBannerHide();
    renderedErrorSignature = null;
    applyBannerPresentation(messageElement, 'hidden');
    restoreBannerRow(messageElement);
    messageElement.removeAttribute('open');
    messageElement.replaceChildren();
  }

  /** Starts (or immediately completes) the collapse of the current row. */
  function hideBanner(): void {
    // Already collapsing: leave the animation (and its teardown timer) alone.
    if (isBannerClosing(messageElement)) return;
    if (!messageElement.hasAttribute('open') || !collapseBannerRow(messageElement)) {
      finalizeBannerHide();
      return;
    }
    bannerHideTimer = setTimeout(finalizeBannerHide, BANNER_TRANSITION_DURATION_MS);
  }

  /**
   * Shows `children` in the row. The reveal plays only when the row was not
   * already showing (a content swap - loading -> error - keeps the current
   * height); a row caught mid-collapse is restored in place so the new content
   * does not replay the reveal from zero.
   */
  function showBanner(children: readonly Node[], loading: boolean): void {
    cancelBannerHide();
    const wasClosing = isBannerClosing(messageElement);
    const wasVisible = messageElement.hasAttribute('open') && !wasClosing;
    // The close control is the shared presentation rule: loading rows have
    // none, every other row does (see `applyBannerPresentation`).
    applyBannerPresentation(messageElement, loading ? 'loading' : 'default');
    messageElement.replaceChildren(...children);
    messageElement.setAttribute('open', '');
    if (wasClosing) restoreBannerRow(messageElement);
    else if (!wasVisible) revealBannerRow(messageElement);
  }

  function applyLoadingPresentation(): void {
    cancelLoadingBanner();
    renderedErrorSignature = null;
    showBanner([buildBannerCopy([loadingSpan]), progressTrack], true);
    setNavMode('stop');
  }

  function applyErrorPresentation(): void {
    cancelLoadingBanner();
    setNavMode('refresh');
    // Already showing exactly this error (the common case while a restored
    // page loads for seconds): keep the row and its button node as they are.
    const signature = `${errorText ?? ''}|${errorRetry === null ? 'plain' : 'reload'}`;
    if (
      renderedErrorSignature === signature &&
      messageElement.hasAttribute('open') &&
      !isBannerClosing(messageElement) &&
      !isLoadingPresentationShown()
    ) {
      return;
    }
    renderedErrorSignature = signature;
    // A failed navigation row carries a "Reload" that re-issues the failed
    // target; errors that are not a navigation (no retry to offer) stay a
    // plain copy row. The error text is dynamic (it repeats the URL the user
    // typed), so it must not go through `buildBannerPrompt`'s `{action}`
    // marker; the Reload button is appended inline after it instead.
    const content: readonly Node[] =
      errorRetry !== null
        ? [buildBannerCopy([`${errorText ?? ''} `, reloadButton])]
        : [buildBannerCopy([errorText ?? ''])];
    showBanner(content, false);
  }

  // The untrusted-certificate prompt: the decision main pushed to the
  // renderer, plus a single "OK" action button. Structured and placed exactly
  // like the unknown-origin prompt below (copy span + actions span, cancel is
  // the banner's dismiss cross), so the two decisions read as one family. OK
  // is disabled only in the degenerate case where no configured server's
  // origin matches the blocked origin - normal flow can never reach it,
  // because an unknown origin is refused and created *before* any certificate
  // check (see `addOriginServer`), so the host is always a managed server by
  // the time this banner appears. Approval attaches the exception to that
  // server's persisted entry; approving never creates a server.
  function applyCertificatePromptPresentation(): void {
    cancelLoadingBanner();
    renderedErrorSignature = null;
    const info = blockedCertificate;
    if (info === null) return;

    const matchingHost = hostOptions.find((host) => host.origin === info.origin);
    const okButton = createBannerActionButton('OK');
    if (matchingHost === undefined) {
      okButton.setAttribute('disabled', '');
    }
    okButton.addEventListener('click', () => {
      void allowBlockedCertificate(info, matchingHost);
    });

    showBanner(buildBannerPrompt(describeBlockedCertificate(), [okButton]), false);
    setNavMode('refresh');
  }

  // Approving intentionally precedes any auto-retry surfacing: `browser:
  // approve-certificate-exception` resolves ok once the exception is
  // persisted and live, and main then re-navigates on its own (this toolbar
  // never issues the retry) - the banner's loading presentation takes over
  // from the prompt when that navigation reports `isLoading`.
  async function allowBlockedCertificate(
    info: CertificateBlockedInfo,
    matchingHost: HostOption | undefined,
  ): Promise<void> {
    if (matchingHost === undefined) return;
    blockedCertificate = null;
    const result: BrowserIpcVoidResult = await window.daisy.browser.approveCertificateException({
      serverId: matchingHost.id,
      exception: info,
    });
    if (!result.ok) {
      if (result.error.code === 'server_not_found') {
        errorText = `The server for ${info.origin} no longer exists. Add it in Settings`;
      } else {
        errorText = result.error.message;
      }
    }
    applyPresentation();
  }

  // The unknown-origin prompt: `browser:navigate` refused an address whose
  // origin matches no configured server (requirements-decisions.md section 3:
  // never navigate silently, never auto-create on the tool's behalf). Unlike
  // the certificate prompt - where approval only ever attaches to servers the
  // user already configured - this one offers to *create* the server, because
  // navigation is impossible without one. The origin stored via
  // `settings:add-server` is exactly the one main refused, but the copy never
  // cites it: the address bar on the row above already shows it, and repeating
  // the URL both adds noise and invites the user to read the banner instead of
  // the actual navigated address. A single "OK" `sp-action-button` accepts;
  // cancel is implicit in the banner's dismiss cross (the `dismissible`
  // attribute is set on every non-loading prompt). OK deliberately is not an
  // accent `sp-button` - there is no blue fill - so the banner reads as a
  // status strip, not a blocking dialog.
  function applyUnknownOriginPromptPresentation(): void {
    cancelLoadingBanner();
    renderedErrorSignature = null;
    const prompt = unknownOriginPrompt;
    if (prompt === null) return;

    const okButton = createBannerActionButton('OK');
    okButton.addEventListener('click', () => {
      void addOriginServer(prompt);
    });

    showBanner(buildBannerPrompt(describeUnknownOrigin(), [okButton]), false);
    setNavMode('refresh');
  }

  // "OK": persists the new server (default label from the origin, first
  // swatch), then retries the exact address the user typed. The retry goes
  // through the same `browser:navigate` as the failed attempt, which now
  // resolves to a configured server and takes the normal switchServer path -
  // so the toolbar never performs a second, different kind of navigation.
  async function addOriginServer(prompt: {
    readonly url: string;
    readonly origin: string;
  }): Promise<void> {
    unknownOriginPrompt = null;
    const result: AddServerResult = await window.daisy.settings.addServer({
      label: deriveServerLabelFromOrigin(prompt.origin),
      origin: prompt.origin,
      color: { kind: 'swatch', swatch: SERVER_SWATCHES[0] },
    });
    if (!result.ok) {
      errorText = `Couldn't add "${prompt.origin}": ${result.error.message}`;
      applyPresentation();
      return;
    }
    performNavigate(prompt.url);
  }

  function applyIdlePresentation(): void {
    cancelLoadingBanner();
    hideBanner();
    setNavMode('refresh');
  }

  function applyPresentation(): void {
    const isLoading = lastNavigationState?.isLoading === true && !failedNavigation;
    // Every load is treated the same, whether the toolbar initiated it
    // (address bar, picker, Back/Forward/Refresh) or the page did (clicking a
    // link or button): the view's own `isLoading` is the only authority, plus
    // a server switch's teardown phase before its `loadURL` starts and a
    // failure result that has already settled the load.
    //
    // The one exception is an error the user has not acknowledged: while an
    // error row is on screen it suppresses the loading presentation, so the
    // page the recovery restores - and that page's own redirects/SSO hops,
    // which keep loading for seconds - never evict the message the user is
    // reading. A user-initiated navigation clears the error first (see
    // `performNavigate`), so the loading presentation is never lost for a load
    // the user actually asked for.
    const loading = errorText === null && (switching || isLoading);

    // The Refresh/Stop swap is deliberately NOT debounced with the banner: a
    // real browser swaps the control the instant a navigation starts. Every
    // transition is derived here from the same `loading` condition that drives
    // the banner, so the two can never drift apart. Only the banner's
    // appearance waits `LOADING_BANNER_DELAY_MS` (so a quick load moves no
    // layout).
    setNavMode(loading ? 'stop' : 'refresh');

    // ── Banner ───────────────────────────────────────────────────────────
    // Loading is the only presentation with a delay: the banner appears
    // only after `LOADING_BANNER_DELAY_MS` of sustained load, then stays
    // until the load ends.  Fast navigations finish inside the
    // window and never move the layout.  Anything else (error, idle,
    // dismiss) applies / cancels immediately.
    if (loading) {
      if (isLoadingPresentationShown() && !isBannerClosing(messageElement)) {
        // Banner already visible — nothing to do. (A row mid-collapse is not
        // "visible": it is on its way out, so a new load re-arms below.)
      } else if (loadingBannerTimer === null) {
        // A stale error/prompt row is superseded by this load and collapses
        // away, even though the loading presentation itself is debounced (a
        // quick load then leaves the banner area empty, not showing the
        // previous row).
        hideBanner();
        loadingBannerTimer = setTimeout(() => {
          loadingBannerTimer = null;
          const stillLoading =
            switching || (lastNavigationState?.isLoading === true && !failedNavigation);
          if (stillLoading) {
            applyLoadingPresentation();
          } else {
            // The load ended inside the debounce window (or an error
            // superseded it): the synchronous transitions above already
            // handled it; this is a safety net for a same-tick race.
            applyPresentation();
          }
        }, LOADING_BANNER_DELAY_MS);
      }
    } else if (blockedCertificate !== null) {
      applyCertificatePromptPresentation();
    } else if (unknownOriginPrompt !== null) {
      applyUnknownOriginPromptPresentation();
    } else if (errorText !== null) {
      applyErrorPresentation();
    } else {
      applyIdlePresentation();
    }

    // ── Toolbar controls ────────────────────────────────────────────────
    // Switching disables back/forward until the transition completes
    // (requirements-decisions.md section 4), and the forced home screen
    // disables them for as long as it covers the page: it is not a history
    // position, so Back must not silently act on the hidden page's history.
    // The address field is always enabled so the user can type a new address -
    // a normal browser's address bar never disables on load (and gating it on
    // `switching` alone made refresh/in-page navigations inconsistent, which
    // never set that flag).
    const navLocked = switching || homeShown;
    const controls = [backButton, forwardButton];
    for (const control of controls) {
      if (navLocked) {
        control.setAttribute('disabled', '');
      } else {
        control.removeAttribute('disabled');
      }
    }
    if (!navLocked) {
      if (lastNavigationState?.canGoBack === true) {
        backButton.removeAttribute('disabled');
      } else {
        backButton.setAttribute('disabled', '');
      }
      if (lastNavigationState?.canGoForward === true) {
        forwardButton.removeAttribute('disabled');
      } else {
        forwardButton.setAttribute('disabled', '');
      }
    }
    // Picker: enabled whenever hosts are configured, even mid-switch. Like
    // the address field, it must never trap the user in a slow or flaky load
    // with no way out: picking another host supersedes the in-flight switch
    // (`serverSwitch.ts`). Only "no hosts to pick from" disables it.
    if (!hasHosts) {
      hostsButton.setAttribute('disabled', '');
    } else {
      hostsButton.removeAttribute('disabled');
    }
  }

  /**
   * Reflects the pane's forced home (welcome) screen onto the chrome (see the
   * interface doc). Blanking/restoring the address is done here rather than in
   * the pane because the address field is this module's to own; the covered
   * page's live URL is kept in `lastNavigationState`, which the state
   * subscription keeps updating even while the veil is up.
   */
  function setHomeShown(shown: boolean): void {
    if (homeShown === shown) return;
    homeShown = shown;
    if (shown) {
      addressField.value = '';
    } else if (addressField.value === '') {
      // Restore the covered page's address - unless a navigation already wrote
      // a fresh one (a typed address, or the Refresh that leaves the veil), in
      // which case the state push follows it up.
      addressField.value = lastNavigationState?.url ?? '';
    }
    refreshAddressLabel();
    refreshExternalButton();
    applyPresentation();
  }

  // ── Refresh / Stop swap ──────────────────────────────────────────────────
  // The button DOM node is reused across swaps; only its icon, title,
  // aria-label, and click handler change. `setNavMode` is idempotent
  // (early-returns if the mode is already set). The initial call below wires
  // the Refresh handler immediately so the control is usable even before the
  // first navigation-state event arrives.
  let navMode: 'refresh' | 'stop' = 'refresh';
  let navClickHandler: (() => void) | null = null;

  function setNavMode(mode: 'refresh' | 'stop'): void {
    // Idempotent once wired: the initial `setNavMode('refresh')` call below
    // must run despite `navMode` already being 'refresh', so the guard also
    // checks that a click handler is actually attached.
    if (navMode === mode && navClickHandler !== null) return;
    navMode = mode;
    refreshButton.replaceChildren();
    if (navClickHandler) {
      refreshButton.removeEventListener('click', navClickHandler);
      navClickHandler = null;
    }
    if (mode === 'stop') {
      const icon = document.createElement('sp-icon-cross600');
      icon.setAttribute('slot', 'icon');
      refreshButton.append(icon);
      refreshButton.setAttribute('title', 'Stop');
      refreshButton.setAttribute('aria-label', 'Stop');
      navClickHandler = () => {
        void window.daisy.browser.stop().then(handleVoidResult);
      };
    } else {
      const icon = document.createElement('sp-icon-refresh');
      icon.setAttribute('slot', 'icon');
      refreshButton.append(icon);
      refreshButton.setAttribute('title', 'Refresh');
      refreshButton.setAttribute('aria-label', 'Refresh');
      navClickHandler = () => {
        // When the address bar shows a different URL than the loaded page,
        // Refresh navigates to the address bar value instead of blindly
        // reloading the stale page — matching normal browser behaviour where
        // Refresh retries whatever the address bar shows. Crucially this also
        // covers the case where NO page is loaded yet (`lastNavigationState`
        // is null — e.g. a fresh profile whose first attempt was refused as
        // unknown_origin before `loadURL` ever ran, so no state push fired):
        // the only non-empty address then differs from "nothing", so Refresh
        // re-requests it and re-triggers the prompt. `reload()` alone would
        // reload the blank view and do nothing.
        const value = resolveAddressSubmission((addressField.value ?? '').trim(), hostOptions);
        const currentUrl = lastNavigationState?.url;
        if (value !== '' && value !== currentUrl) {
          performNavigate(value);
        } else {
          performReload();
        }
      };
    }
    refreshButton.addEventListener('click', navClickHandler);
  }

  // ── IPC result handler ───────────────────────────────────────────────────
  /**
   * One navigation operation the toolbar issued (an address/picker/transcript
   * navigation, Back/Forward, or Refresh). `previous` is a synchronous
   * snapshot of the page that was on screen at the moment the operation was
   * issued - the only instant at which the state feed reliably names the
   * *previous* page, because the failed load's own `did-start-loading` push
   * replaces it a tick later. `retry` re-issues the exact operation, and
   * `token` lets a recovery bail out if a newer navigation superseded it.
   */
  interface NavigationAttempt {
    readonly target: string;
    readonly previous: string;
    readonly retry: () => void;
    readonly token: number;
    /**
     * How a failure may restore the previous page:
     *
     * - `"history"` - a fresh navigation (`browser:navigate`) reliably pushes a
     *   history entry for the failed target, so the page behind it is exactly
     *   the one remembered. Restore with an instant history back (bfcache: no
     *   network, no loading banner).
     * - `"exact"` - a Back/Forward failure leaves the active history entry
     *   ambiguous, so re-navigate the remembered URL exactly instead.
     * - `"none"` - a reload's "previous page" is the very page that just
     *   failed; there is nothing to fall back to, so the error row and its
     *   Reload are the whole recovery.
     */
    readonly restoreVia: 'history' | 'exact' | 'none';
  }

  /** The URL of the page currently on screen, or `''` when the view is blank. */
  function currentDisplayedUrl(): string {
    return lastNavigationState?.url ?? '';
  }

  function performNavigate(target: string): void {
    const token = ++navigationToken;
    callbacks.onNavigationStarted?.();
    // A user-initiated navigation is what clears a previous error row (see
    // `applyPresentation`): the user has moved on, so the loading presentation
    // may take the row again.
    errorText = null;
    errorRetry = null;
    const previous = currentDisplayedUrl();
    void window.daisy.browser.navigate(target).then((result) =>
      handleVoidResult(result, {
        target,
        previous,
        retry: () => performNavigate(target),
        token,
        restoreVia: 'history',
      }),
    );
  }

  function performReload(): void {
    const token = ++navigationToken;
    callbacks.onNavigationStarted?.();
    errorText = null;
    errorRetry = null;
    const previous = currentDisplayedUrl();
    void window.daisy.browser.reload().then((result) =>
      handleVoidResult(result, {
        target: previous,
        previous,
        retry: performReload,
        token,
        restoreVia: 'none',
      }),
    );
  }

  function performHistory(direction: 'back' | 'forward'): void {
    const token = ++navigationToken;
    callbacks.onNavigationStarted?.();
    errorText = null;
    errorRetry = null;
    const previous = currentDisplayedUrl();
    const retry = (): void => performHistory(direction);
    const command =
      direction === 'back' ? window.daisy.browser.goBack() : window.daisy.browser.goForward();
    void command.then((result) =>
      // The destination is a history entry the renderer does not know
      // synchronously, so `target` stays empty: a failure restores the
      // displayed page rather than treating the two as equal.
      handleVoidResult(result, { target: '', previous, retry, token, restoreVia: 'exact' }),
    );
  }

  function handleVoidResult(result: BrowserIpcVoidResult, attempt?: NavigationAttempt): void {
    if (!result.ok) {
      // The awaited load has settled; a buffered `isLoading:true` push must not
      // keep the Stop/banner up past the failure.
      failedNavigation = true;
      // A Stop clicked during a load makes `loadURL` reject. Verified on
      // Electron 44.3.0 (probe in the Step 05 verification records): the
      // rejection arrives as ERR_FAILED. ERR_ABORTED covers other cancellation
      // paths and earlier Chromium versions. Neither code is produced by a
      // genuine server-side failure here or AEM QueryBuilder traffic (those map
      // to ERR_CONNECTION_REFUSED, ERR_TIMED_OUT, ERR_NAME_NOT_RESOLVED…), so
      // suppressing them cannot hide a real "couldn't display content"
      // condition.
      const isCancellation =
        result.error.code === 'network_error' &&
        (result.error.errorCode === 'ERR_ABORTED' || result.error.errorCode === 'ERR_FAILED');
      if (!isCancellation) {
        if (result.error.code === 'unknown_origin') {
          // requirements-decisions.md section 3: an unknown origin must never
          // be navigated to or auto-created silently. The prompt offers to
          // add it as a server (a single "OK" action button; cancel is the
          // banner's dismiss cross). The address field still holds the value
          // that was just refused (a failed navigation fires no did-navigate
          // state push), so it is captured wholesale as the auto-retry target
          // once the server exists.
          const submittedUrl = addressField.value.trim();
          const origin = result.error.origin ?? submittedUrl;
          unknownOriginPrompt = { url: submittedUrl === '' ? origin : submittedUrl, origin };
          errorText = null;
          errorRetry = null;
        } else {
          errorText = result.error.message;
          errorRetry = attempt?.retry ?? null;
          if (
            result.error.code === 'network_error' &&
            attempt !== undefined &&
            attempt.restoreVia !== 'none'
          ) {
            // A failed load would leave the page-view region showing whatever
            // the view last had. Recover the page that was on screen before
            // this attempt silently behind the error row; when there was none,
            // the pane's home screen is already exposed (the native view is
            // collapsed while `hasDocument` is false), so nothing else is
            // needed. This returns without applying the presentation: the
            // restore runs and the error row (with its Reload) is re-asserted
            // once it settles.
            recoverFailedLoad(attempt, result.error.message);
            return;
          }
        }
      }
    }
    applyPresentation();
  }

  /**
   * Recovers from a failed load that would otherwise leave the page-view
   * region showing the wrong page: go back to the page remembered when the
   * operation was issued. When there was no such page (or it is the very page
   * that just failed) there is nothing to restore - the pane's home screen is
   * the fallback, shown automatically because the native view is collapsed
   * while no document is loaded.
   *
   * The restore is **silent**: the error row is already on screen and, because
   * an unacknowledged error suppresses the loading presentation (see
   * `applyPresentation`), the restore's own load - and any redirects or SSO
   * hops the restored page starts - run behind it without evicting it.
   */
  function recoverFailedLoad(attempt: NavigationAttempt, message: string): void {
    const { previous, target, restoreVia } = attempt;
    if (restoreVia !== 'none' && previous !== '' && previous !== target) {
      // The restore runs detached and best-effort: the error row (with Reload)
      // is the recovery the user sees, and the home screen covers the
      // no-document case. A newer navigation simply supersedes it.
      void restorePage(restoreVia, previous).catch(() => undefined);
    }
    // Paint the error row now; the restore (if any) proceeds behind it.
    errorText = message;
    applyPresentation();
  }

  /**
   * Puts the remembered page back. `"history"` uses an instant history back -
   * Electron restores the previous document from bfcache in tens of
   * milliseconds with no network round trip (verified on Electron 44.3.0), so
   * the pane never shows a sustained blank. `"exact"` re-navigates the
   * remembered URL, which re-resolves the server/proxy the same way any typed
   * address would.
   */
  async function restorePage(via: 'history' | 'exact', previous: string): Promise<boolean> {
    if (via === 'history') {
      const outcome = await window.daisy.browser.goBack();
      return outcome.ok;
    }
    const outcome = await window.daisy.browser.navigate(previous);
    return outcome.ok;
  }

  // ── Chrome action click handlers ─────────────────────────────────────────
  // Back/Forward are chrome-initiated but NOT sourced from a fetch-against
  // the server — they replay a browser history entry that the view already
  // knows. No arming is needed: the view's own `isLoading` push drives the
  // same banner + Stop presentation as any other load.
  backButton.addEventListener('click', () => {
    performHistory('back');
  });
  forwardButton.addEventListener('click', () => {
    performHistory('forward');
  });

  const addressField = el('sp-textfield', {
    attrs: {
      class: 'address-bar',
      id: 'browser-address-bar',
      // Not a URL-shaped example: kept honest until the first real
      // navigation-state event arrives (see `hasLiveNavigationState` below).
      placeholder: 'Select a host or type an address',
      'aria-label': 'Address',
    },
  }) as AddressField;

  // The field's built-in truncation tooltip (`TruncatedValueTooltipController`)
  // draws a "bottom"-placed tooltip under the field whenever the address
  // overflows. That region is occupied by the native webview, which paints
  // above all web content, so the tooltip is unusable here - the controller's
  // `render()` is stubbed so the overlay is never produced at all.
  const truncatedValueTooltipController = (
    addressField as unknown as {
      truncatedValueTooltipController?: { render(): unknown };
    }
  ).truncatedValueTooltipController;
  if (truncatedValueTooltipController) {
    truncatedValueTooltipController.render = () => undefined;
  }

  // Navigation is committed only by an explicit action: pressing Enter while
  // the field has focus, or the toolbar's Refresh button (see `reload`). The
  // field's `change` event is deliberately NOT wired up: sp-textfield forwards
  // the underlying <input>'s `change`, which fires on *blur* — so merely
  // moving focus away (e.g. clicking the hosts picker beside the field, or a
  // banner button) would otherwise launch a navigation for a half-typed value
  // such as "loc". Enter navigates unconditionally, even when the value is
  // unchanged (pressing Enter again after dismissing the unknown-origin prompt
  // must re-request the refused URL).
  addressField.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // A scheme-less address names a configured host's domain; the protocol is
    // inferred from that host before navigating (see `resolveAddressSubmission`).
    const value = resolveAddressSubmission(addressField.value, hostOptions);
    if (value === '') return;
    event.preventDefault();
    addressField.value = value;
    refreshAddressLabel();
    refreshExternalButton();
    performNavigate(value);
  });

  // The field's real shadow `<input>` - the node that owns the text selection.
  // Undefined before the Spectrum control's first render and in jsdom (where
  // the custom element never upgrades), so every use tolerates `null`.
  function addressInputElement(): HTMLInputElement | HTMLTextAreaElement | null {
    return addressField.focusElement ?? null;
  }

  /**
   * Whether the address field currently holds focus. `sp-textfield` reflects
   * this as a boolean property; jsdom has no such property, so the document's
   * active element is the fallback.
   */
  function isAddressFocused(): boolean {
    if (typeof addressField.focused === 'boolean') return addressField.focused;
    return addressField.ownerDocument.activeElement === addressField;
  }

  /**
   * Selects the whole address, through the shadow input when it exists. The
   * selection is made *backwards* (focus/caret at index 0) and the scroll is
   * pinned to the start, so selecting a long address keeps its beginning in
   * view instead of scrolling the end into view and pushing the start out of
   * the field - a plain `select()` puts the caret at the end and does exactly
   * that.
   */
  function selectAllAddressText(): void {
    const input = addressInputElement();
    if (input !== null) {
      input.setSelectionRange(0, input.value.length, 'backward');
      input.scrollLeft = 0;
      return;
    }
    addressField.select?.();
  }

  // One click into an unfocused address bar selects its whole value; the next
  // click clears that selection and places the caret - Chrome's behaviour.
  // Preventing the default on the first mousedown is what keeps the browser
  // from collapsing our select-all to a caret at the click point; when the
  // field is already focused the default runs, placing the caret (and so
  // clearing any selection).
  addressField.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    if (isAddressFocused()) return;
    event.preventDefault();
    addressField.focus();
    selectAllAddressText();
  });

  /**
   * Inline type-ahead over the configured hosts: completes a partially typed
   * address and selects the appended text, so the next keystroke replaces the
   * completion (Chrome's address bar). Only runs while the caret sits at the
   * end of the text; an unavailable selection (jsdom) is treated as "at end".
   * Programmatic writes (the live-navigation state push) fire no `input` event,
   * so they never trigger a completion.
   *
   * Called only for completion-worthy edits (see `shouldInferAddressCompletion`):
   * a deletion, cut, undo or IME composition must never re-append the inferred
   * tail, or the edit would appear to have no effect.
   */
  // Guards an async selection application against a newer completion: only the
  // most recent one may move the caret.
  let autocompleteToken = 0;

  function applyHostAutocomplete(): void {
    // Bump first: any completion already awaiting its render is now stale and
    // must not move the caret, even if this input produced no new completion.
    const token = ++autocompleteToken;
    const input = addressInputElement();
    const typed = addressField.value;
    if (input !== null) {
      const { selectionStart, selectionEnd } = input;
      if (
        selectionStart !== null &&
        selectionEnd !== null &&
        (selectionStart !== typed.length || selectionEnd !== typed.length)
      ) {
        return;
      }
    }
    const completion = findHostAutocomplete(typed, hostOptions);
    if (completion === undefined) return;
    addressField.value = completion.value;
    if (input === null) return;
    // `sp-textfield` re-renders its shadow `<input>` from the host `value` on a
    // microtask, and that re-assignment resets the selection to the end - so
    // the completion's selection is applied only after that update settles.
    const applySelection = (): void => {
      if (token !== autocompleteToken) return;
      input.setSelectionRange(completion.selectionStart, completion.selectionEnd);
    };
    const updateComplete = addressField.updateComplete;
    if (updateComplete !== undefined) {
      void updateComplete.then(applySelection);
    } else {
      applySelection();
    }
  }

  // Keep the paired host label and the external-browser control tracking
  // whatever the field shows, whether typed here or written programmatically
  // (the state pushes below call the two refreshers explicitly, since assigning
  // `.value` fires no `input` event). The label/external refreshers always run,
  // but the completion only runs for a completion-worthy edit: the `input`
  // event carries the native `inputType`, and re-appending the inferred tail
  // after a Backspace/Delete/Cut/Undo (or during IME composition) would make
  // that edit appear to do nothing.
  addressField.addEventListener('input', (event) => {
    if (shouldInferAddressCompletion(event.inputType, event.isComposing)) {
      applyHostAutocomplete();
    }
    refreshAddressLabel();
    refreshExternalButton();
  });

  // `sp-picker-button` default `position="right"` removes its left border
  // radius so it sits flush against the address field's right edge as a
  // combobox glyph (the sibling `.browser-toolbar__address-group` wrapper in
  // browser.css completes the coupling). Its built-in chevron triggers the
  // pane's open/close toggle. Non-quiet: a filled resting background whose
  // `:host([open])` "down" variant is the visibly pressed toggle state.
  const hostsButton = el('sp-picker-button', {
    attrs: {
      id: 'hosts-button',
      class: 'hosts-button',
      position: 'right',
      'accessible-label': 'Choose host',
      title: 'Choose host',
      disabled: '',
    },
  });
  hostsButton.addEventListener('click', () => callbacks.onHostsPickerClick());

  // The coloured host label paired with the address: a block showing the
  // configured host's *label* on that host's colour when the address in the
  // field belongs to it, hidden when the address is empty or matches no host.
  // It is positioned absolutely inside the field's left edge by CSS, and the
  // field's address text is pushed past it by the input's left padding - see
  // `refreshAddressLabel`. Colour is never the only signal: the block's text
  // names the host.
  const addressLabel = el('span', {
    attrs: { class: 'address-bar__host-label' },
  });
  addressLabel.hidden = true;

  const addressGroup = el('div', {
    attrs: { class: 'browser-toolbar__address-group' },
    children: [addressField, addressLabel, hostsButton],
  });

  // "Open in external browser": hands the address bar's current URL to the OS
  // default browser via `browser:openExternal`. Labelless like the nav
  // controls; it is enabled only while the address field holds an absolute
  // http(s) URL (the same predicate main re-validates with), so it never
  // offers an action main would refuse. Sits after the address group and
  // before the agent-pane toggle.
  const externalButton = buildNavButton('Open in external browser', 'sp-icon-open-in-light');
  externalButton.setAttribute('disabled', '');
  externalButton.addEventListener('click', () => {
    const value = addressField.value.trim();
    if (value === '') return;
    void window.daisy.browser.openExternal({ url: value }).then(handleVoidResult);
  });

  // The agent-pane toggle, pinned to the toolbar's right edge (`addressGroup`
  // is the flex-grow item, so this sits after it). It is a real toggle: one
  // fixed icon, with the `selected` state (styled by browser.css) showing the
  // pane is open. `title`/`aria-label` keep naming the action; the pane does
  // not exist yet at mount, so it starts selected/open.
  const agentToggleButton = el('sp-action-button', {
    attrs: { quiet: '', class: 'browser-toolbar__agent-toggle' },
  });
  const agentToggleIcon = document.createElement('sp-icon-padding-right');
  agentToggleIcon.setAttribute('slot', 'icon');
  agentToggleButton.append(agentToggleIcon);
  agentToggleButton.addEventListener('click', () => callbacks.onToggleAgentPane?.());

  function renderAgentToggle(open: boolean): void {
    const label = open ? 'Close Agent' : 'Open Agent';
    agentToggleButton.toggleAttribute('selected', open);
    agentToggleButton.setAttribute('title', label);
    agentToggleButton.setAttribute('aria-label', label);
  }

  renderAgentToggle(true);

  toolbar.append(
    homeButton,
    backButton,
    forwardButton,
    refreshButton,
    addressGroup,
    externalButton,
    agentToggleButton,
  );

  // Wire the Refresh control immediately (idempotent), so clicking it before
  // the first navigation-state event still works.
  setNavMode('refresh');

  // ── Close / Dismiss handler ──────────────────────────────────────────────
  // A dismissed row was closed by the user, not by navigation state. The
  // component's `shouldClose()` dispatches a cancelable `close` and removes
  // `open` itself; the default is prevented so this module keeps full
  // control over visibility through `applyPresentation`. Any error text goes
  // away with the dismissal - but if a load is still in progress the loading
  // presentation stays (or, if it had not been shown yet, re-appears after the
  // debounce window).
  messageElement.addEventListener('close', (event) => {
    event.preventDefault();
    blockedCertificate = null;
    unknownOriginPrompt = null;
    errorText = null;
    errorRetry = null;
    applyPresentation();
  });

  // ── State subscriptions ──────────────────────────────────────────────────
  // Once a real navigation-state event has been observed, it is the only
  // authoritative source for the address bar: `setAddressValue` (driven by
  // `computeAddressBarValue()`, which is always "" - see viewModel.ts) must
  // not be allowed to clobber it back to empty on a later settings-snapshot
  // reload (e.g. the window regaining focus).
  let hasLiveNavigationState = false;

  const unsubscribeState = window.daisy.browser.onStateChanged((state) => {
    hasLiveNavigationState = true;
    lastNavigationState = state;
    // The address field tracks the live navigation unconditionally, *except*
    // while the forced home screen covers the page: the screen is not a page,
    // so it has no address, and `lastNavigationState` keeps the covered page's
    // live URL for when the veil is dismissed. Main reports the destination of
    // a main-frame navigation from `did-start-navigation` (see
    // `aemBrowserView.ts`), so this shows an in-page link's target at the
    // moment the click starts the load - exactly as it shows a toolbar-typed
    // target - instead of waiting for the new document to commit.
    if (!homeShown) {
      addressField.value = state.url;
    }
    // A navigation to a new page has begun: pending prompts (and main's
    // matching auto-retry target) are superseded by it, and a failure flag
    // from the previous navigation no longer applies. Deliberately does NOT
    // clear `errorText`/`errorRetry`: an error row is the user's to read and
    // dismiss, and a page the recovery restored can start several loads of its
    // own (redirects, an SSO hop) that would otherwise erase it. It is cleared
    // only by a user-initiated navigation (`performNavigate`/`performReload`/
    // `performHistory`) or by dismissing the row.
    if (state.isLoading) {
      failedNavigation = false;
      blockedCertificate = null;
      unknownOriginPrompt = null;
    }
    refreshAddressLabel();
    refreshExternalButton();
    applyPresentation();
  });

  // Re-derived whenever the snapshot changes so the switch handler below can
  // restore the picker to its correct disabled state without clobbering the
  // no-servers case (it must not blindly remove `disabled` after a switch).
  let hasHosts = false;
  // The full host option list, kept for the certificate prompt's
  // matching-host check (Allow is enabled only when a configured host's
  // origin equals the blocked origin) and for the address bar's paired host
  // label and type-ahead. Mirrors `hasHosts` (which only feeds the picker's
  // disabled state) but cannot be merged into it: `hasHosts` is a boolean, and
  // matching needs the actual origins and labels.
  let hostOptions: readonly HostOption[] = [];

  /**
   * Re-derives the address bar's paired label block from the field's current
   * value and the configured hosts. A host match paints the block with that
   * host's label and colour (foreground chosen for readability) and pushes
   * the address text past the measured block with the input's left padding; no
   * match (empty, unparseable, or unknown origin) hides it and resets both.
   * The match is *inferred*-or-exact (`resolveAddressChipHost`), so editing a
   * host's address does not blink the chip off on every Backspace.
   */
  function refreshAddressLabel(): void {
    const host = resolveAddressChipHost(addressField.value ?? '', hostOptions);
    const input = addressInputElement();
    if (host === undefined) {
      addressLabel.hidden = true;
      addressLabel.textContent = '';
      addressLabel.style.removeProperty('background-color');
      addressLabel.style.removeProperty('color');
      addressLabel.style.removeProperty('max-inline-size');
      if (input !== null) input.style.removeProperty('padding-inline-start');
      return;
    }
    addressLabel.textContent = host.label;
    addressLabel.style.backgroundColor = host.colorCss;
    addressLabel.style.color = resolveHostLabelForeground(host.colorCss);
    addressLabel.hidden = false;
    // Clamp the chip to the field's real width, always leaving room for a few
    // address characters, so a long label can never spill over the field's
    // right border (or into the picker button). Skipped before layout (a
    // zero-width field, and jsdom), where the CSS upper bound stands in.
    const fieldWidth = addressField.getBoundingClientRect().width;
    if (fieldWidth > 0) {
      const available = Math.max(
        0,
        Math.min(
          ADDRESS_LABEL_MAX_PX,
          fieldWidth -
            ADDRESS_LABEL_LEFT_INSET_PX -
            ADDRESS_LABEL_GAP_PX -
            ADDRESS_FIELD_BASE_INLINE_PADDING_PX -
            ADDRESS_LABEL_MIN_ADDRESS_PX,
        ),
      );
      addressLabel.style.maxInlineSize = `${String(available)}px`;
    } else {
      addressLabel.style.removeProperty('max-inline-size');
    }
    // Push the address text past the clamped block with the shadow input's
    // *left padding* (not `text-indent`): padding sits outside the input's
    // scrollable content, so a long address that scrolls to reveal its end can
    // never drag its beginning under the chip. Measured against the real
    // geometry so the gap is exact regardless of borders/offsets.
    if (input !== null) {
      const inputRect = input.getBoundingClientRect();
      const chipRect = addressLabel.getBoundingClientRect();
      const paddingLeft = Math.max(
        0,
        Math.round(chipRect.right + ADDRESS_LABEL_GAP_PX - inputRect.left - input.clientLeft),
      );
      input.style.paddingInlineStart = paddingLeft === 0 ? '' : `${String(paddingLeft)}px`;
    }
  }

  /**
   * Re-derives the "Open in external browser" control's enabled state from the
   * field's current value: enabled only while the address is an absolute
   * http(s) URL (see `canOpenInExternalBrowser`), disabled otherwise.
   */
  function refreshExternalButton(): void {
    if (canOpenInExternalBrowser(addressField.value)) {
      externalButton.removeAttribute('disabled');
    } else {
      externalButton.setAttribute('disabled', '');
    }
  }

  // The chip's width clamp depends on the field's live width, which changes
  // with the window and the pane splitter, so recompute it whenever the field
  // resizes. Guarded because jsdom has no `ResizeObserver`; the clamp itself
  // changes nothing the field's own size depends on, so this cannot loop.
  const addressFieldResizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          refreshAddressLabel();
        })
      : null;
  addressFieldResizeObserver?.observe(addressField);

  const unsubscribeSwitch = window.daisy.browser.onSwitchStateChanged((state) => {
    switching = state.switching;
    applyPresentation();
  });

  // A blocked navigation arrives as a decision on the renderer's own
  // deadline: main pushes it on the AEM session's `certificate-error` event,
  // which also secretly carries the full URL so main can keep it as the
  // auto-retry target. The push payload deliberately carries only the three
  // `TlsException` fields, so the renderer never touches that URL.
  const unsubscribeBlocked = window.daisy.browser.onCertificateBlocked((info) => {
    blockedCertificate = info;
    applyPresentation();
  });

  return {
    element: toolbar,
    messageElement,
    setAddressValue(value: string): void {
      if (hasLiveNavigationState) return;
      addressField.value = value;
      refreshAddressLabel();
      refreshExternalButton();
    },
    setHostOptions(options: readonly HostOption[]): void {
      // Never touches `addressField.value`: the address bar's displayed
      // text is owned exclusively by `setAddressValue`/the live
      // navigation-state event above, and must not be reset just because
      // the configured host list reloaded (e.g. the window regaining
      // focus). The picker's disabled state, the certificate prompt's
      // matching-host state and the address's paired host label all depend on
      // the snapshot, so all are re-derived here.
      hasHosts = options.length > 0;
      hostOptions = options;
      refreshAddressLabel();
      applyPresentation();
    },
    setHostsPickerOpen(open: boolean): void {
      if (open) {
        hostsButton.setAttribute('open', '');
        hostsButton.setAttribute('aria-expanded', 'true');
      } else {
        hostsButton.removeAttribute('open');
        hostsButton.setAttribute('aria-expanded', 'false');
      }
    },
    setHomeShown,
    setAgentPaneOpen(open: boolean): void {
      renderAgentToggle(open);
    },
    navigateTo(url: string): void {
      addressField.value = url;
      refreshAddressLabel();
      refreshExternalButton();
      performNavigate(url);
    },
    dispose(): void {
      cancelLoadingBanner();
      cancelBannerHide();
      addressFieldResizeObserver?.disconnect();
      unsubscribeState();
      unsubscribeSwitch();
      unsubscribeBlocked();
    },
  };
}
