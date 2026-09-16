import { el } from '../lib/dom';
import type { BrowserIpcVoidResult, BrowserNavigationState } from '../../../shared';
import type { ServerOption } from './viewModel';

/**
 * The left pane's toolbar: Back/Forward/Refresh, a plain text address bar,
 * and a "picker button" coupled to the address field's right edge
 * (requirements-decisions.md section 8).
 *
 * The address bar (`addressField`) is an ordinary `sp-textfield`: typing a
 * URL and committing it (Enter/blur) navigates exactly as before. The
 * `sp-picker-button` beside it (`serverPickerButton`) is a combobox-style
 * affordance, not a value-holding control - clicking it asks the owning pane
 * to suspend the native `WebContentsView` and reveal the whole-size server
 * list (`serverPickerPanel.ts`). Selecting a server there calls back into
 * `navigateTo(origin)`, which writes that server's *origin* into the address
 * field and runs it through the exact same `navigate()` call as anything
 * typed directly. With zero configured servers the button stays visible but
 * disabled (see `setServerOptions`), so there is nothing to open.
 *
 * The button reveals its "open" state when the picker panel is up:
 * `setServerPickerOpen(true)` sets the `open` attribute, whose `:host([open])`
 * CSS rule gives the pressed look; the pane clears it when the panel closes.
 *
 * Every control here is wired to the real `window.daisy.browser` IPC surface
 * now that it exists. Failures are handled generically per
 * implementation-plan.md step 05: `result.error.message` is always shown
 * (for `network_error` this is already humanised copy - see
 * networkErrorCopy.ts), and only `unknown_origin` gets different treatment (a
 * prompt to add the server in Settings, per requirements-decisions.md section
 * 3 - the address is never silently navigated to and no server is ever
 * auto-created). A user-initiated stop (`browser:stop`) produces an
 * `ERR_ABORTED` error that is suppressed here as expected behaviour rather
 * than surfaced as an error banner.
 */
export interface BrowserToolbar {
  readonly element: HTMLElement;
  /**
   * A status/prompt row rendered as a sibling of `element`, not nested inside
   * it (keeps `role="toolbar"` clean). An `sp-alert-banner` (neutral
   * variant) whose `open` attribute is its whole show/hide mechanism
   * (`:host{display:none}` / `:host([open]){display:flex}` in the
   * component's own stylesheet) - so nothing here has to fight the
   * component's display rules with a `hidden` attribute. It is also
   * `dismissible`: the user can close the row with its close button, which
   * makes the component remove the `open` attribute itself; this module
   * listens for the component's `close` event to reclaim the row. The owning
   * pane groups it with the native view region (`browserPane.ts`'s
   * `browserPagePanel`) so the two hide together; this module only owns when
   * the row is shown/cleared.
   */
  readonly messageElement: HTMLElement;
  /** Refreshes the address bar text and server-selector options for a newly loaded snapshot. */
  setAddressValue(value: string): void;
  setServerOptions(options: readonly ServerOption[]): void;
  /** Marks the picker button as open (panel visible) or closed. */
  setServerPickerOpen(open: boolean): void;
  /** Writes `origin` into the address field and navigates to it, exactly like a typed address. */
  navigateTo(origin: string): void;
  /** Unsubscribes from `onStateChanged`/`onSwitchStateChanged`. */
  dispose(): void;
}

export interface BrowserToolbarCallbacks {
  /** Fired when the picker button is activated; the owning pane opens/closes the panel. */
  onServerPickerClick(): void;
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
  // (see .nav-icon--back in shell.css) rather than a separate icon asset.
  const backButton = buildNavButton('Back', 'sp-icon-arrow100', { iconClass: 'nav-icon--back' });
  const forwardButton = buildNavButton('Forward', 'sp-icon-arrow100');
  const refreshButton = buildNavButton('Refresh', 'sp-icon-refresh');
  // Nothing is loaded yet (no navigation state has been reported), so there
  // is nothing to go back/forward to until the first `onStateChanged` event.
  backButton.setAttribute('disabled', '');
  forwardButton.setAttribute('disabled', '');

  const messageElement = el('sp-alert-banner', {
    attrs: {
      class: 'browser-toolbar-message',
      variant: 'neutral',
      // Lets the user dismiss a status/prompt row with the close button (an
      // `sp-close-button`). The component owns the mechanics: clicking it
      // dispatches a cancelable `close` event and removes the `open`
      // attribute itself - the toolbar only stays consistent with that state
      // and never fights it.
      dismissible: '',
    },
  });

  // Indeterminate progress circle reused across loading cycles. Created once
  // so the DOM node is stable when the banner content is swapped between
  // loading, error, and idle.
  const progressCircle = el('sp-progress-circle', {
    attrs: { size: 's', indeterminate: '', 'aria-label': LOADING_LABEL },
  });
  const loadingSpan = el('span', {
    attrs: { class: 'browser-toolbar-message__loading' },
    children: [progressCircle, document.createTextNode(LOADING_LABEL)],
  });

  // ── State ────────────────────────────────────────────────────────────────
  let lastNavigationState: BrowserNavigationState | null = null;
  let switching = false;
  let pendingExternalNav = 0;
  let errorText: string | null = null;

  // ── Banner ───────────────────────────────────────────────────────────────
  // The banner shows (in priority order):
  //  1. "Loading…"+spinner — any external load is in progress (either a
  //     server switch, or a toolbar-initiated reload/back/forward/address
  //     submit while `isLoading` is true).
  //  2. Error copy — set by `handleVoidResult` (network failures, unknown-
  //     origin prompt, storage errors).
  //  3. Closed (idle) — no active external load and no error to display.
  function applyPresentation(): void {
    const isLoading = lastNavigationState?.isLoading === true;
    const loading = switching || (isLoading && pendingExternalNav > 0);

    // ── Banner ───────────────────────────────────────────────────────────
    if (loading) {
      messageElement.replaceChildren(loadingSpan);
      messageElement.setAttribute('open', '');
    } else if (errorText !== null) {
      messageElement.replaceChildren(document.createTextNode(errorText));
      messageElement.setAttribute('open', '');
    } else {
      messageElement.replaceChildren();
      messageElement.removeAttribute('open');
    }

    // ── Refresh / Stop ──────────────────────────────────────────────────
    if (loading) {
      setNavMode('stop');
    } else {
      setNavMode('refresh');
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
    // Picker: disabled while switching, or when no servers are configured.
    if (switching || !hasServers) {
      serverPickerButton.setAttribute('disabled', '');
    } else {
      serverPickerButton.removeAttribute('disabled');
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
        markExternalNavigation();
        void window.daisy.browser.reload().then(handleVoidResult);
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
          // requirements-decisions.md section 3: an unknown origin must prompt
          // the user to add a server, and must never silently navigate or
          // auto-create one. The prompt is text-only: the Settings window is
          // one click away in the window chrome, so the row carries no button.
          const origin = result.error.origin ?? 'That address';
          errorText = `"${origin}" is not a configured server. Add it in Settings, then try again`;
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
      placeholder: 'Select a server or type an address',
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

  addressField.addEventListener('change', () => {
    const value = addressField.value.trim();
    if (value === '') return;
    markExternalNavigation();
    void window.daisy.browser.navigate(value).then(handleVoidResult);
  });

  // `sp-picker-button` default `position="right"` removes its left border
  // radius so it sits flush against the address field's right edge as a
  // combobox glyph (the sibling `.browser-toolbar__address-group` wrapper in
  // shell.css completes the coupling). Its built-in chevron triggers the
  // pane's open/close toggle. Non-quiet: a filled resting background whose
  // `:host([open])` "down" variant is the visibly pressed toggle state.
  const serverPickerButton = el('sp-picker-button', {
    attrs: {
      id: 'server-picker-button',
      class: 'server-picker-button',
      position: 'right',
      'accessible-label': 'Choose server',
      title: 'Choose server',
      disabled: '',
    },
  });
  serverPickerButton.addEventListener('click', () => callbacks.onServerPickerClick());

  const addressGroup = el('div', {
    attrs: { class: 'browser-toolbar__address-group' },
    children: [addressField, serverPickerButton],
  });

  toolbar.append(backButton, forwardButton, refreshButton, addressGroup);

  // Wire the Refresh control immediately (idempotent), so clicking it before
  // the first navigation-state event still works.
  setNavMode('refresh');

  // ── Close / Dismiss handler ──────────────────────────────────────────────
  // A dismissed row was closed by the user, not by navigation state. Any
  // error text goes away with the dismissal — but if an external load is
  // still in progress the loading presentation is re-shown on the next
  // state push. This is a minor accepted edge.
  messageElement.addEventListener('close', () => {
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
  let hasServers = false;

  const unsubscribeSwitch = window.daisy.browser.onSwitchStateChanged((state) => {
    switching = state.switching;
    applyPresentation();
  });

  return {
    element: toolbar,
    messageElement,
    setAddressValue(value: string): void {
      if (hasLiveNavigationState) return;
      addressField.value = value;
    },
    setServerOptions(options: readonly ServerOption[]): void {
      // Never touches `addressField.value`: the address bar's displayed
      // text is owned exclusively by `setAddressValue`/the live
      // navigation-state event above, and must not be reset just because
      // the configured server list reloaded (e.g. the window regaining
      // focus). Only the picker's disabled state depends on the snapshot.
      hasServers = options.length > 0;
      applyPresentation();
    },
    setServerPickerOpen(open: boolean): void {
      if (open) {
        serverPickerButton.setAttribute('open', '');
        serverPickerButton.setAttribute('aria-expanded', 'true');
      } else {
        serverPickerButton.removeAttribute('open');
        serverPickerButton.setAttribute('aria-expanded', 'false');
      }
    },
    navigateTo(origin: string): void {
      addressField.value = origin;
      markExternalNavigation();
      void window.daisy.browser.navigate(origin).then(handleVoidResult);
    },
    dispose(): void {
      unsubscribeState();
      unsubscribeSwitch();
    },
  };
}
