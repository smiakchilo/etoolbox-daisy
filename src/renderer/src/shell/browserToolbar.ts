import { el } from '../lib/dom';
import { buildBannerPrompt, createBannerRow } from '../lib/alertBanner';
import type {
  AddServerResult,
  BrowserIpcVoidResult,
  BrowserNavigationState,
  CertificateBlockedInfo,
} from '../../../shared';
import { SERVER_SWATCHES } from '../../../shared';
import type { HostOption } from './viewModel';
import {
  describeBlockedCertificate,
  describeUnknownOrigin,
  deriveServerLabelFromOrigin,
} from './viewModel';

/**
 * The left pane's toolbar: Back/Forward/Refresh, a plain text address bar,
 * and a "picker button" coupled to the address field's right edge
 * (requirements-decisions.md section 8).
 *
 * The address bar (`addressField`) is an ordinary `sp-textfield`: typing a
 * URL and committing it (Enter/blur) navigates exactly as before. The
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
 * like the unknown-origin prompt below (a `_copy` span plus a
 * `_actions` span; cancel is the banner's dismiss cross). The flow guarantees
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
  /** Writes `origin` into the address field and navigates to it, exactly like a typed address. */
  navigateTo(origin: string): void;
  /** Unsubscribes from `onStateChanged`/`onSwitchStateChanged`/`onCertificateBlocked`. */
  dispose(): void;
}

export interface BrowserToolbarCallbacks {
  /** Fired when the picker button is activated; the owning pane opens/closes the panel. */
  onHostsPickerClick(): void;
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

export function createBrowserToolbar(callbacks: BrowserToolbarCallbacks): BrowserToolbar {
  const toolbar = el('div', { attrs: { class: 'toolbar browser-toolbar', role: 'toolbar' } });

  // "Back" reuses Forward's sp-icon-arrow100 glyph, rotated 180deg via CSS
  // (see .nav-icon--back in browser.css) rather than a separate icon asset.
  const backButton = buildNavButton('Back', 'sp-icon-arrow100', { iconClass: 'nav-icon--back' });
  const forwardButton = buildNavButton('Forward', 'sp-icon-arrow100');
  const refreshButton = buildNavButton('Refresh', 'sp-icon-refresh');
  // Nothing is loaded yet (no navigation state has been reported), so there
  // is nothing to go back/forward to until the first `onStateChanged` event.
  backButton.setAttribute('disabled', '');
  forwardButton.setAttribute('disabled', '');

  // The shared banner-row base (lib/alertBanner.ts, styles/banner.css) with
  // the browser surface class. The factory starts the row `dismissible`;
  // error/prompt presentations keep it, the loading branch removes it (the
  // `applyPresentation` loading path). The component shows its `sp-close-button`
  // when `dismissible` is set and dispatches a cancelable `close` on click;
  // this module prevents the default so it keeps full control of `open`.
  const messageElement = createBannerRow('browser-toolbar-message');

  // Loading text shown inside the banner — the indefinite progress bar
  // animation is rendered via CSS in browser.css, so no spinner is needed.
  const loadingSpan = el('span', {
    attrs: { class: 'browser-toolbar-message__loading' },
    children: [document.createTextNode(LOADING_LABEL)],
  });

  // Indeterminate progress line pinned to the loading banner's top edge - a
  // hand-copied rendering of Spectrum's `sp-progress-bar` size="s" sweep
  // (see browser.css `.browser-toolbar-message__progress`), because the
  // `@spectrum-web-components/progress-bar` package is not a project
  // dependency. Created once so the DOM node is stable across loading
  // cycles, then swapped in/out of the banner like `loadingSpan`.
  const progressFill = el('div', {
    attrs: { class: 'browser-toolbar-message__progress-fill' },
  });
  const progressTrack = el('div', {
    attrs: { class: 'browser-toolbar-message__progress' },
    children: [progressFill],
  });

  // ── State ────────────────────────────────────────────────────────────────
  let lastNavigationState: BrowserNavigationState | null = null;
  let switching = false;
  let pendingExternalNav = 0;
  let errorText: string | null = null;
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
  // A chrome-armed external navigation that finishes within this window (fast
  // reload, near-instant local server) never shows the banner, so no layout
  // shift happens for the common quick case.
  const LOADING_BANNER_DELAY_MS = 200;
  let loadingBannerTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Banner ───────────────────────────────────────────────────────────────
  // The banner shows (in priority order):
  //  1. "Loading…"+spinner (plus a progress line at the top edge) — any
  //     external load is in progress (either a server switch, or a
  //     toolbar-initiated reload/back/forward/address submit while
  //     `isLoading` is true). Pending certificate and unknown-origin prompts
  //     are cleared the moment a new load starts - approving/adding's
  //     auto-retry and any manual navigation both supersede them.
  //  2. The untrusted-certificate prompt — set by `onCertificateBlocked`.
  //  3. The unknown-origin prompt — set by `browser:navigate`'s
  //     `unknown_origin` error.
  //  4. Error copy — set by `handleVoidResult` (network failures, storage
  //     errors).
  //  5. Closed (idle) — no active external load and nothing to display.
  //
  // Opening and closing are instant (`open` toggles `display` on the
  // component) - no slide animation. Loading is debounced by
  // `LOADING_BANNER_DELAY_MS`: a sustained load arms a timer; if the load
  // ends before the timer fires the banner is never shown (and no layout
  // shift occurs). Error and idle transitions apply immediately. The loading
  // presentation is never dismissible: the close control is reserved for
  // error/prompt rows, where dismissing clears the error copy or the prompt.

  /** True when the `--loading` class + loading content are actively applied. */
  function isLoadingPresentationShown(): boolean {
    return messageElement.classList.contains('browser-toolbar-message--loading');
  }

  function cancelLoadingBanner(): void {
    if (loadingBannerTimer !== null) {
      clearTimeout(loadingBannerTimer);
      loadingBannerTimer = null;
    }
  }

  function applyLoadingPresentation(): void {
    cancelLoadingBanner();
    messageElement.classList.add('browser-toolbar-message--loading');
    messageElement.removeAttribute('dismissible');
    messageElement.replaceChildren(loadingSpan, progressTrack);
    messageElement.setAttribute('open', '');
    setNavMode('stop');
  }

  function applyErrorPresentation(): void {
    cancelLoadingBanner();
    messageElement.classList.remove('browser-toolbar-message--loading');
    messageElement.setAttribute('dismissible', '');
    messageElement.replaceChildren(document.createTextNode(errorText ?? ''));
    messageElement.setAttribute('open', '');
    setNavMode('refresh');
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
    messageElement.classList.remove('browser-toolbar-message--loading');
    messageElement.setAttribute('dismissible', '');
    const info = blockedCertificate;
    if (info === null) return;

    const matchingHost = hostOptions.find((host) => host.origin === info.origin);
    const okButton = el('sp-action-button', { attrs: { size: 'm' }, text: 'OK' });
    if (matchingHost === undefined) {
      okButton.setAttribute('disabled', '');
    }
    okButton.addEventListener('click', () => {
      void allowBlockedCertificate(info, matchingHost);
    });

    messageElement.replaceChildren(...buildBannerPrompt(describeBlockedCertificate(), [okButton]));
    messageElement.setAttribute('open', '');
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
        errorText = `The server for ${info.origin} no longer exists. Add it in Settings, then try again.`;
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
    messageElement.classList.remove('browser-toolbar-message--loading');
    messageElement.setAttribute('dismissible', '');
    const prompt = unknownOriginPrompt;
    if (prompt === null) return;

    const okButton = el('sp-action-button', { attrs: { size: 'm' }, text: 'OK' });
    okButton.addEventListener('click', () => {
      void addOriginServer(prompt);
    });

    messageElement.replaceChildren(...buildBannerPrompt(describeUnknownOrigin(), [okButton]));
    messageElement.setAttribute('open', '');
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
    markExternalNavigation();
    const navigation: BrowserIpcVoidResult = await window.daisy.browser.navigate(prompt.url);
    handleVoidResult(navigation);
  }

  function applyIdlePresentation(): void {
    cancelLoadingBanner();
    messageElement.classList.remove('browser-toolbar-message--loading');
    messageElement.removeAttribute('dismissible');
    messageElement.removeAttribute('open');
    messageElement.replaceChildren();
    setNavMode('refresh');
  }

  function applyPresentation(): void {
    const isLoading = lastNavigationState?.isLoading === true;
    const loading = switching || (isLoading && pendingExternalNav > 0);

    // ── Banner ───────────────────────────────────────────────────────────
    // Loading is the only presentation with a delay: the banner appears
    // only after `LOADING_BANNER_DELAY_MS` of sustained load, then stays
    // until the load ends.  Fast external navigations finish inside the
    // window and never move the layout.  Anything else (error, idle,
    // dismiss) applies / cancels immediately.
    if (loading) {
      if (isLoadingPresentationShown()) {
        // Banner already visible — nothing to do.
      } else if (loadingBannerTimer === null) {
        loadingBannerTimer = setTimeout(() => {
          loadingBannerTimer = null;
          const stillIsLoading = lastNavigationState?.isLoading === true;
          const stillLoading = switching || (stillIsLoading && pendingExternalNav > 0);
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
    // Switching disables every control until the transition completes
    // (requirements-decisions.md section 4). When not switching, back/
    // forward reflect the live history; address field is always enabled so
    // the user can type a new address.
    const controls = [backButton, forwardButton, addressField];
    for (const control of controls) {
      if (switching) {
        control.setAttribute('disabled', '');
      } else {
        control.removeAttribute('disabled');
      }
    }
    if (!switching) {
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
    // Picker: disabled while switching, or when no hosts are configured.
    if (switching || !hasHosts) {
      hostsButton.setAttribute('disabled', '');
    } else {
      hostsButton.removeAttribute('disabled');
    }
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
      const icon = document.createElement('sp-icon-stop');
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
        const value = (addressField.value ?? '').trim();
        const currentUrl = lastNavigationState?.url;
        if (value !== '' && value !== currentUrl) {
          markExternalNavigation();
          void window.daisy.browser.navigate(value).then(handleVoidResult);
        } else {
          markExternalNavigation();
          void window.daisy.browser.reload().then(handleVoidResult);
        }
      };
    }
    refreshButton.addEventListener('click', navClickHandler);
  }

  // ── External navigation flag ─────────────────────────────────────────────
  // The toolbar is the only thing in the renderer that knows a navigation
  // was initiated outside the webview (address-bar, picker, back, forward,
  // refresh). Every chrome action arms `pendingExternalNav` right before
  // the IPC call. The counter is disarmed on the next `isLoading:false`
  // push (did-stop-loading), or when a non-ok IPC result arrives (the
  // navigation never actually started). This is sufficient because every
  // user-initiated server switch also sets `switching=true` via the
  // `ServerSwitchController` — so a switch's teardown phase (proxy setup,
  // before any `loadURL`) is covered by the `switching` condition in
  // `applyPresentation` regardless of whether `did-start-loading` has
  // fired yet.
  function markExternalNavigation(): void {
    pendingExternalNav += 1;
  }

  // ── IPC result handler ───────────────────────────────────────────────────
  function handleVoidResult(result: BrowserIpcVoidResult): void {
    if (!result.ok) {
      pendingExternalNav = 0;
      // A Stop clicked during a load makes `loadURL` reject. Verified on
      // Electron 44.3.0 (probe in the Step 05 verification records): the
      // rejection arrives as ERR_FAILED; `did-stop-loading` arrives first in
      // the renderer and disarms the arm, so the only reliable signal is the
      // error code itself. ERR_ABORTED covers other cancellation paths and
      // earlier Chromium versions. Neither code is produced by a genuine
      // server-side failure here or AEM QueryBuilder traffic (those map to
      // ERR_CONNECTION_REFUSED, ERR_TIMED_OUT, ERR_NAME_NOT_RESOLVED…), so
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
        } else {
          errorText = result.error.message;
        }
      }
    }
    applyPresentation();
  }

  // ── Chrome action click handlers ─────────────────────────────────────────
  // Back/Forward are chrome-initiated but NOT sourced from a fetch-against
  // the server — they replay a browser history entry that the view already
  // knows. `markExternalNavigation()` is still called for consistency so
  // the trio (banner + stop) shows for the resulting load.
  backButton.addEventListener('click', () => {
    markExternalNavigation();
    void window.daisy.browser.goBack().then(handleVoidResult);
  });
  forwardButton.addEventListener('click', () => {
    markExternalNavigation();
    void window.daisy.browser.goForward().then(handleVoidResult);
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
  }) as HTMLElement & { value: string };

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

  // Enter keydown navigates immediately regardless of whether the value
  // changed.  sp-textfield's `change` event only fires when the committed
  // value differs from the previous commit (same as native <input>), so
  // pressing Enter on an unchanged URL — e.g. after dismissing an
  // unknown-origin prompt — would silently do nothing without this handler.
  // A guard prevents double-firing: when keydown fires first it sets the
  // flag so the subsequent `change` event (if one fires) is skipped.
  let keydownNavigated = false;

  addressField.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const value = addressField.value.trim();
    if (value === '') return;
    event.preventDefault();
    keydownNavigated = true;
    markExternalNavigation();
    void window.daisy.browser.navigate(value).then(handleVoidResult);
  });

  addressField.addEventListener('change', () => {
    if (keydownNavigated) {
      keydownNavigated = false;
      return;
    }
    const value = addressField.value.trim();
    if (value === '') return;
    markExternalNavigation();
    void window.daisy.browser.navigate(value).then(handleVoidResult);
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

  const addressGroup = el('div', {
    attrs: { class: 'browser-toolbar__address-group' },
    children: [addressField, hostsButton],
  });

  toolbar.append(backButton, forwardButton, refreshButton, addressGroup);

  // Wire the Refresh control immediately (idempotent), so clicking it before
  // the first navigation-state event still works.
  setNavMode('refresh');

  // ── Close / Dismiss handler ──────────────────────────────────────────────
  // A dismissed row was closed by the user, not by navigation state. The
  // component's `shouldClose()` dispatches a cancelable `close` and removes
  // `open` itself; the default is prevented so this module keeps full
  // control over visibility through `applyPresentation`. Any error text goes
  // away with the dismissal - but if an external load is still in progress
  // the loading presentation stays (or, if it had not been shown yet,
  // re-appears after the debounce window).
  messageElement.addEventListener('close', (event) => {
    event.preventDefault();
    blockedCertificate = null;
    unknownOriginPrompt = null;
    errorText = null;
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
    addressField.value = state.url;
    // A navigation to a new page has begun — any stale error text is now
    // superseded by the live load state; clearing it here lets the banner
    // show "Loading…" instead of a stale error. A failed navigation
    // re-sets `errorText` via `handleVoidResult`; a successful one should
    // never resurrect text from a previous page.
    if (state.isLoading) {
      errorText = null;
      // A navigation to a new page has begun — any pending prompts (and
      // main's matching auto-retry target) are superseded by it.
      blockedCertificate = null;
      unknownOriginPrompt = null;
    } else {
      // A load finished with `isLoading:false` (did-stop-loading): every
      // pending external navigation is now complete, so the counter resets.
      // This also guards a later *in-webview* navigation (isLoading true,
      // no chrome had armed a counter) from wrongly showing the banner.
      pendingExternalNav = 0;
    }
    applyPresentation();
  });

  // Re-derived whenever the snapshot changes so the switch handler below can
  // restore the picker to its correct disabled state without clobbering the
  // no-servers case (it must not blindly remove `disabled` after a switch).
  let hasHosts = false;
  // The full host option list, kept for the certificate prompt's
  // matching-host check (Allow is enabled only when a configured host's
  // origin equals the blocked origin). Mirrors `hasHosts` (which only feeds
  // the picker's disabled state) but cannot be merged into it: `hasHosts`
  // is a boolean, and matching needs the actual origins.
  let hostOptions: readonly HostOption[] = [];

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
    },
    setHostOptions(options: readonly HostOption[]): void {
      // Never touches `addressField.value`: the address bar's displayed
      // text is owned exclusively by `setAddressValue`/the live
      // navigation-state event above, and must not be reset just because
      // the configured host list reloaded (e.g. the window regaining
      // focus). The picker's disabled state and the certificate prompt's
      // matching-host state both depend on the snapshot, so both are
      // re-derived here.
      hasHosts = options.length > 0;
      hostOptions = options;
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
    navigateTo(origin: string): void {
      addressField.value = origin;
      markExternalNavigation();
      void window.daisy.browser.navigate(origin).then(handleVoidResult);
    },
    dispose(): void {
      cancelLoadingBanner();
      unsubscribeState();
      unsubscribeSwitch();
      unsubscribeBlocked();
    },
  };
}
