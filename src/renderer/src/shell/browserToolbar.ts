import { el } from '../lib/dom';
import type { BrowserIpcVoidResult } from '../../../shared';
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
 * implementation-plan.md step 05: `result.error.message` is always shown,
 * and only `unknown_origin` gets different treatment (a prompt to add the
 * server in Settings, per requirements-decisions.md section 3 - the address
 * is never silently navigated to and no server is ever auto-created).
 */
export interface BrowserToolbar {
  readonly element: HTMLElement;
  /**
   * A status/prompt row rendered as a sibling of `element`, not nested inside
   * it (keeps `role="toolbar"` clean). The owning pane groups it with the
   * native view region (`browserPane.ts`'s `browserPagePanel`) so the two
   * hide together; this module only owns when the row is shown/cleared.
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

  const messageText = el('span', { attrs: { class: 'browser-toolbar-message__text' } });
  const openSettingsButton = el('sp-button', {
    attrs: {
      variant: 'secondary',
      quiet: '',
      class: 'browser-toolbar-message__settings',
    },
    text: 'Settings',
  });
  openSettingsButton.hidden = true;
  openSettingsButton.addEventListener('click', () => {
    void window.daisy.openSettingsWindow();
  });
  const messageElement = el('div', {
    attrs: { class: 'browser-toolbar-message', role: 'status' },
    children: [messageText, openSettingsButton],
  });
  messageElement.hidden = true;

  function showMessage(text: string, options?: { readonly offerOpenSettings?: boolean }): void {
    messageText.textContent = text;
    messageElement.hidden = false;
    openSettingsButton.hidden = !options?.offerOpenSettings;
  }

  function clearMessage(): void {
    messageElement.hidden = true;
    messageText.textContent = '';
    openSettingsButton.hidden = true;
  }

  function handleVoidResult(result: BrowserIpcVoidResult): void {
    if (result.ok) {
      clearMessage();
      return;
    }
    if (result.error.code === 'unknown_origin') {
      // requirements-decisions.md section 3: an unknown origin must prompt
      // the user to add a server, and must never silently navigate or
      // auto-create one - so this branches on the code, but only to change
      // *which* message/affordance is shown, never to retry the navigation.
      const origin = result.error.origin ?? 'That address';
      showMessage(`"${origin}" is not a configured server. Add it in Settings first.`, {
        offerOpenSettings: true,
      });
      return;
    }
    // Generic handling for every other/future error code (implementation
    // -plan.md step 05): always show the message, never swallow it.
    showMessage(result.error.message);
  }

  backButton.addEventListener('click', () => {
    void window.daisy.browser.goBack().then(handleVoidResult);
  });
  forwardButton.addEventListener('click', () => {
    void window.daisy.browser.goForward().then(handleVoidResult);
  });
  refreshButton.addEventListener('click', () => {
    void window.daisy.browser.reload().then(handleVoidResult);
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
  addressField.addEventListener('change', () => {
    const value = addressField.value.trim();
    if (value === '') return;
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

  // Once a real navigation-state event has been observed, it is the only
  // authoritative source for the address bar: `setAddressValue` (driven by
  // `computeAddressBarValue()`, which is always "" - see viewModel.ts) must
  // not be allowed to clobber it back to empty on a later settings-snapshot
  // reload (e.g. the window regaining focus).
  let hasLiveNavigationState = false;

  const unsubscribeState = window.daisy.browser.onStateChanged((state) => {
    hasLiveNavigationState = true;
    addressField.value = state.url;
    // A navigation to a new page has begun, so whatever the row is showing
    // (an error, the "unknown origin" prompt, "Switching servers...") now
    // describes the state *before* this navigation and is stale - clear it.
    // A failed navigation re-shows it via `handleVoidResult`; a successful
    // one should never resurrect text from a previous page.
    if (state.isLoading) {
      clearMessage();
    }
    if (state.canGoBack) {
      backButton.removeAttribute('disabled');
    } else {
      backButton.setAttribute('disabled', '');
    }
    if (state.canGoForward) {
      forwardButton.removeAttribute('disabled');
    } else {
      forwardButton.setAttribute('disabled', '');
    }
  });

  // Re-derived whenever the snapshot changes so the switch handler below can
  // restore the picker to its correct disabled state without clobbering the
  // no-servers case (it must not blindly remove `disabled` after a switch).
  let hasServers = false;

  const unsubscribeSwitch = window.daisy.browser.onSwitchStateChanged((state) => {
    // requirements-decisions.md section 4: "Keep tools disabled until the
    // transition completes." Back/Forward's finer-grained history state is
    // restored by the next `onStateChanged` push the switch produces, not
    // guessed at here.
    const controls = [backButton, forwardButton, refreshButton, addressField];
    for (const control of controls) {
      if (state.switching) {
        control.setAttribute('disabled', '');
      } else {
        control.removeAttribute('disabled');
      }
    }
    if (state.switching || !hasServers) {
      serverPickerButton.setAttribute('disabled', '');
    } else {
      serverPickerButton.removeAttribute('disabled');
    }
    if (state.switching) {
      showMessage('Switching servers...');
    } else {
      clearMessage();
    }
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
      if (hasServers) {
        serverPickerButton.removeAttribute('disabled');
      } else {
        serverPickerButton.setAttribute('disabled', '');
      }
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
      void window.daisy.browser.navigate(origin).then(handleVoidResult);
    },
    dispose(): void {
      unsubscribeState();
      unsubscribeSwitch();
    },
  };
}
