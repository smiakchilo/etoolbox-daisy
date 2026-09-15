import { el } from '../lib/dom';
import type { BrowserIpcVoidResult } from '../../../shared';
import type { ServerOption } from './viewModel';

/**
 * The left pane's toolbar: Back/Forward/Refresh, a plain text address bar,
 * and a "picker button" that opens the full server list beside it
 * (requirements-decisions.md section 8).
 *
 * The address bar (`addressField`) is an ordinary `sp-textfield`: typing a
 * URL and committing it (Enter/blur) navigates exactly as before. The
 * `sp-action-menu` beside it (`serverMenuButton`) is a menu-button, not a
 * value-holding control - clicking it opens a menu of the configured
 * servers, each item showing its colour swatch and label like the old
 * standalone `sp-picker`. Selecting an item writes that server's *origin*
 * into the address field and runs it through the exact same `navigate()`
 * call as anything typed directly - see `buildServerMenuItem`. With zero
 * configured servers the button is hidden entirely (see `setServerOptions`),
 * so there is nothing to open.
 *
 * Opening the menu from the address field itself (Chrome-address-bar-style)
 * was tried and deliberately dropped: `sp-action-menu`'s popover only runs
 * its open CSS transition reliably when toggled from its own trigger via a
 * real click; toggled from elsewhere it has no transition to watch, and the
 * library's own "no transition started" safety net force-closes it ~50ms
 * later. The button remains the only way to open the menu.
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
  /** A status/prompt row rendered as a sibling of `element`, not nested inside it (keeps `role="toolbar"` clean). */
  readonly messageElement: HTMLElement;
  /** Refreshes the address bar text and server-selector options for a newly loaded snapshot. */
  setAddressValue(value: string): void;
  setServerOptions(options: readonly ServerOption[]): void;
  /** Unsubscribes from `onStateChanged`/`onSwitchStateChanged`. */
  dispose(): void;
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

/**
 * One `sp-menu-item` for the server picker button's menu: a colour swatch
 * plus the server's label, exactly like the old standalone `sp-picker`.
 * Unlike `sp-combobox` (which clones slotted items into plain text),
 * `sp-action-menu` renders its slotted children directly, so the swatch's
 * icon-slot content survives. The item's `value` is the server's *origin*
 * (not its id, and not its label) - selecting it writes that origin into the
 * address field, which then flows through the same `navigate()` call as
 * anything typed directly.
 */
function buildServerMenuItem(option: ServerOption): HTMLElement {
  const swatch = el('span', { attrs: { class: 'server-swatch', role: 'presentation' } });
  swatch.style.backgroundColor = option.colorCss;
  swatch.setAttribute('slot', 'icon');
  return el('sp-menu-item', {
    attrs: { value: option.origin },
    text: option.label,
    children: [swatch],
  });
}

export function createBrowserToolbar(): BrowserToolbar {
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
    attrs: { variant: 'secondary' },
    text: 'Open Settings',
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

  const serverMenuButton = el('sp-action-menu', {
    attrs: {
      id: 'server-picker-button',
      class: 'server-picker-button',
      quiet: '',
      label: 'Choose server',
    },
  }) as HTMLElement & { value: string; toggle(target?: boolean): void };
  const serverMenuIcon = document.createElement('sp-icon-chevron-down');
  serverMenuIcon.setAttribute('slot', 'icon');
  serverMenuButton.append(serverMenuIcon);
  // Hidden until `setServerOptions` supplies at least one server - see the
  // `[hidden]` override in shell.css (needed because the component's own
  // `:host{display:inline-flex}` would otherwise win over the plain
  // attribute).
  serverMenuButton.hidden = true;

  // Selecting a menu item sets `.value` to that item's `value` (the origin)
  // and fires this event synchronously from inside the click handler, before
  // the component reverts `.value` back to its prior value (it does this
  // regardless, since `selects` is deliberately left unset here - this is a
  // stateless menu button, not a persistent selection control) - so reading
  // `.value` here, during the event, is reliable even though it does not
  // stick afterwards. One `navigate()` call handles it exactly like a typed
  // address would.
  serverMenuButton.addEventListener('change', () => {
    const value = serverMenuButton.value.trim();
    if (value === '') return;
    addressField.value = value;
    void window.daisy.browser.navigate(value).then(handleVoidResult);
  });

  toolbar.append(backButton, forwardButton, refreshButton, addressField, serverMenuButton);

  // Once a real navigation-state event has been observed, it is the only
  // authoritative source for the address bar: `setAddressValue` (driven by
  // `computeAddressBarValue()`, which is always "" - see viewModel.ts) must
  // not be allowed to clobber it back to empty on a later settings-snapshot
  // reload (e.g. the window regaining focus).
  let hasLiveNavigationState = false;

  const unsubscribeState = window.daisy.browser.onStateChanged((state) => {
    hasLiveNavigationState = true;
    addressField.value = state.url;
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

  const unsubscribeSwitch = window.daisy.browser.onSwitchStateChanged((state) => {
    // requirements-decisions.md section 4: "Keep tools disabled until the
    // transition completes." Back/Forward's finer-grained history state is
    // restored by the next `onStateChanged` push the switch produces, not
    // guessed at here.
    const controls = [backButton, forwardButton, refreshButton, addressField, serverMenuButton];
    for (const control of controls) {
      if (state.switching) {
        control.setAttribute('disabled', '');
      } else {
        control.removeAttribute('disabled');
      }
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
      // focus). The menu item elements themselves are re-slotted (the
      // trailing icon child stays put, since it's addressed to a different
      // slot). With zero servers the button is hidden entirely - there is
      // nothing to open.
      serverMenuButton.replaceChildren(serverMenuIcon, ...options.map(buildServerMenuItem));
      serverMenuButton.hidden = options.length === 0;
    },
    dispose(): void {
      unsubscribeState();
      unsubscribeSwitch();
    },
  };
}
