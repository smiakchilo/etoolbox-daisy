/**
 * The prefill script: what main injects into a page on `dom-ready` to put a
 * saved sign-in into its form - and to offer the remembered usernames on the
 * field that asks for one.
 *
 * It runs in the page's main world through `webContents.executeJavaScript` -
 * not through the preload - for three reasons: a login form is frequently
 * rendered by the page's own script (React/Angular identity-provider steps),
 * which only the main world can drive correctly; `executeJavaScript` bypasses
 * the page's CSP, where a script tag would not; and SSO windows opened by
 * `window.open` have no preload at all, so this is the only mechanism that
 * reaches them.
 *
 * **Filling.** It is deliberately silent about what it did beyond returning
 * whether it wrote anything, never clicks, and never submits:
 *
 * - it fills only **empty** fields, so a value the user (or the page) already
 *   put there wins;
 * - it refuses a page with more than one *usable* password field, or a
 *   `new-password` one: that is a change-password form, and filling it would be
 *   wrong (AEM's hidden new/confirm-password inputs do not count);
 * - a field a page hides from assistive tech (`aria-hidden`, `tabindex="-1"`,
 *   `hidden`) is **not** a field: password managers are decoyed with exactly
 *   that shape (Adobe's IMS pages ship `credential-hide-helper` inputs), and
 *   counting one both hides the email step and writes the password into a
 *   field the page never shows;
 * - it fills the **first** credential (the origin's most recently used one),
 *   then watches the username field: typing a different saved username swaps
 *   the password to that entry - which is how a second account on the same
 *   origin is reached without a picker;
 * - it swaps only while the password field still holds the value it filled, so
 *   a password the user typed is never overwritten;
 * - **a page with no password field is still a sign-in page**: an identity
 *   provider's first step asks only for the email/username (Adobe and HPE both
 *   do), so a single, unambiguous login field is filled from the same
 *   credential, and the observer stays alive for the password step that renders
 *   later in the same document;
 * - it re-tries through a `MutationObserver` for a bounded window, because an
 *   identity provider's second step often renders after `dom-ready`, and stops
 *   once a password step has been reached.
 *
 * **Suggestions.** A dropdown of the remembered usernames is attached to every
 * login field (never a password field) on focus, filtered as the user types.
 * It lives in a **closed shadow root**, so page script can see that something
 * was appended but can never read the list itself - the addresses are offered
 * to the reader, not published to the page. Selecting one writes it through the
 * native value setter with `input`/`change` events, so React/Angular pages see
 * it exactly as if it had been typed.
 *
 * Passwords reach the page as a JSON literal in this function's own closure.
 * Page script cannot read that closure; it can read the input values, which is
 * exactly what it could read if the user had typed them.
 */

export interface FillCredential {
  readonly username: string;
  /** Empty for a username hint: there is nothing to put in a password field. */
  readonly password: string;
}

/**
 * How long the observer keeps waiting for a form that is not there yet. Long
 * enough for a two-step identity-provider flow (type the email, read the error,
 * continue), short enough that a page left open all day is not watched forever.
 */
export const FILL_WATCH_MS = 60_000;

/**
 * The attribute on the element whose closed shadow root holds the suggestion
 * list. The page can find this element; it cannot read the list inside it.
 */
export const SUGGESTION_HOST_ATTRIBUTE = 'data-daisy-saved-sign-in';

/**
 * Builds the script for one origin's credentials (most recently used first) and
 * the remembered usernames offered on a login field.
 * Pure: no Electron, no I/O - the unit tests execute the result against jsdom.
 */
export function buildCredentialFillScript(
  credentials: readonly FillCredential[],
  suggestions: readonly string[] = [],
): string {
  const serializedCredentials = JSON.stringify(
    credentials.map((credential) => ({
      username: credential.username,
      password: credential.password,
    })),
  );
  const serializedSuggestions = JSON.stringify(
    suggestions.filter((username) => username.length > 0),
  );

  return `(() => {
  const credentials = ${serializedCredentials};
  const suggestions = ${serializedSuggestions};
  const watchMs = ${FILL_WATCH_MS};
  const hostAttribute = ${JSON.stringify(SUGGESTION_HOST_ATTRIBUTE)};
  if (!Array.isArray(credentials) || !Array.isArray(suggestions)) return false;
  if (credentials.length === 0 && suggestions.length === 0) return false;
  if (!document.documentElement) return false;

  const userTypes = ['text', 'email', 'tel'];
  const loginHint = /user|email|login|logon|account|identifier/i;
  const isField = (el) => !!el && el.tagName === 'INPUT';
  const typeOf = (el) => ((el.getAttribute('type') || 'text') + '').toLowerCase();

  // A field the page does not show is not a field: hidden, removed from the
  // accessibility tree, or out of the tab order. Password-manager decoys are
  // exactly this shape (see the module comment).
  const isOccluded = (el) => {
    if (!isField(el)) return true;
    if (el.disabled || el.hasAttribute('hidden')) return true;
    if ((el.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return true;
    if ((el.getAttribute('tabindex') || '') === '-1') return true;
    return typeof el.closest === 'function' && el.closest('[aria-hidden="true"]') !== null;
  };

  const passwordFields = () =>
    Array.from(document.querySelectorAll('input')).filter(
      (el) => isField(el) && typeOf(el) === 'password' && !isOccluded(el),
    );

  // The login/email field of a page that asks for one. A type of email and an
  // autocomplete of username are explicit; names every sign-in form of this
  // shape uses ("username", "userid", "Email address", "loginfmt", "accountId")
  // decide otherwise. Readonly is the provider's own copy of a value it already
  // shows, not something a reader fills.
  const looksLikeLogin = (el) => {
    if (!isField(el) || isOccluded(el) || el.readOnly) return false;
    if (userTypes.indexOf(typeOf(el)) < 0) return false;
    if (typeOf(el) === 'email') return true;
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.indexOf('username') >= 0 || autocomplete.indexOf('email') >= 0) return true;
    const label = [el.getAttribute('name'), el.id, el.getAttribute('placeholder')]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(' ');
    return loginHint.test(label);
  };

  const loginFields = () => Array.from(document.querySelectorAll('input')).filter(looksLikeLogin);

  function setValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function usernameFieldFor(password) {
    const form = password.form || document;
    const inputs = Array.from(form.querySelectorAll('input'));
    const index = inputs.indexOf(password);
    for (let at = index - 1; at >= 0; at -= 1) {
      const candidate = inputs[at];
      if (!isField(candidate) || isOccluded(candidate) || candidate.readOnly) continue;
      const type = typeOf(candidate);
      if (type === 'text' || type === 'email' || type === 'tel') return candidate;
    }
    const named = form.querySelector('input[autocomplete="username"]');
    return isField(named) && !isOccluded(named) ? named : null;
  }

  let activePassword = credentials.length > 0 ? credentials[0].password : '';

  // Whether a submitted value is a known username, and which credential it is.
  function candidateFor(value) {
    const wanted = value.trim().toLowerCase();
    if (!wanted) return null;
    return (
      credentials.find((credential) => credential.username.toLowerCase() === wanted) || null
    );
  }

  // Fills what this page has, and says whether a password step was reached (the
  // point at which the observer has nothing left to wait for).
  function fill() {
    if (credentials.length === 0) return { wrote: false, passwordStep: false };
    const fields = passwordFields();
    if (fields.length > 1) return { wrote: false, passwordStep: false };
    if (fields.length === 1) {
      const password = fields[0];
      if ((password.getAttribute('autocomplete') || '').toLowerCase() === 'new-password') {
        return { wrote: false, passwordStep: false };
      }
      let wrote = false;
      const username = usernameFieldFor(password);
      if (username && username.value === '' && credentials[0].username !== '') {
        setValue(username, credentials[0].username);
        wrote = true;
      }
      if (password.value === '' && credentials[0].password !== '') {
        setValue(password, credentials[0].password);
        wrote = true;
        activePassword = credentials[0].password;
      }
      return { wrote: wrote, passwordStep: true };
    }
    // No usable password field: the identity provider's first step, which only
    // asks who the user is.
    const names = loginFields();
    if (names.length === 1 && names[0].value === '' && credentials[0].username !== '') {
      setValue(names[0], credentials[0].username);
      return { wrote: true, passwordStep: false };
    }
    return { wrote: false, passwordStep: false };
  }

  // ---------------------------------------------------------------------
  // The username suggestion list (closed shadow root).
  // ---------------------------------------------------------------------

  let host = null;
  let list = null;
  let targetInput = null;
  let matches = [];
  let optionElements = [];
  let activeIndex = -1;
  let suppressInput = false;

  function ensureHost() {
    if (host !== null && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute(hostAttribute, '');
    host.style.position = 'fixed';
    host.style.left = '0px';
    host.style.top = '0px';
    host.style.width = '0px';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent =
      '.list{position:absolute;top:0;left:0;width:100%;box-sizing:border-box;max-height:240px;' +
      'overflow-y:auto;margin:0;padding:4px 0;background:#ffffff;color:#222222;' +
      'border:1px solid #c9c9c9;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.18);' +
      'font:13px/1.4 -apple-system,"Segoe UI",Roboto,Ubuntu,sans-serif;pointer-events:auto;}' +
      '.option{padding:6px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis;}' +
      '.option[aria-selected="true"]{background:#e8e8e8;}';
    list = document.createElement('div');
    list.className = 'list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Saved sign-ins');
    list.hidden = true;
    shadow.appendChild(style);
    shadow.appendChild(list);
    (document.body || document.documentElement).appendChild(host);
  }

  function hideSuggestions() {
    activeIndex = -1;
    if (list !== null) list.hidden = true;
  }

  function renderOptions() {
    if (list === null) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    optionElements = matches.map((name, index) => {
      const option = document.createElement('div');
      option.className = 'option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.textContent = name;
      // mousedown, not click: preventDefault keeps the keyboard in the field so
      // the page never sees a blur it would act on.
      option.addEventListener('mousedown', (event) => {
        event.preventDefault();
        selectSuggestion(index);
      });
      list.appendChild(option);
      return option;
    });
  }

  function positionSuggestions(input) {
    if (host === null) return;
    const rect = input.getBoundingClientRect();
    host.style.left = Math.round(rect.left) + 'px';
    host.style.top = Math.round(rect.bottom + 2) + 'px';
    host.style.width = Math.max(120, Math.round(rect.width)) + 'px';
  }

  function showSuggestions(input) {
    if (!looksLikeLogin(input)) {
      hideSuggestions();
      return;
    }
    const current = (input.value || '').trim();
    const query = current.toLowerCase();
    const next = suggestions.filter((name) => {
      if (name === current) return false;
      return query === '' || name.toLowerCase().indexOf(query) >= 0;
    });
    if (next.length === 0) {
      hideSuggestions();
      return;
    }
    ensureHost();
    targetInput = input;
    matches = next;
    renderOptions();
    positionSuggestions(input);
    if (list !== null) list.hidden = false;
  }

  function selectSuggestion(index) {
    const name = matches[index];
    const input = targetInput;
    hideSuggestions();
    if (name === undefined || input === null) return;
    suppressInput = true;
    try {
      setValue(input, name);
    } finally {
      suppressInput = false;
    }
  }

  function markActive(nextIndex) {
    const previous = optionElements[activeIndex];
    if (previous) previous.setAttribute('aria-selected', 'false');
    activeIndex = nextIndex;
    const next = optionElements[activeIndex];
    if (!next) return;
    next.setAttribute('aria-selected', 'true');
    if (typeof next.scrollIntoView === 'function') next.scrollIntoView({ block: 'nearest' });
  }

  function onKeyDown(event) {
    if (targetInput === null || list === null || list.hidden) return;
    if (event.target !== targetInput) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      markActive(activeIndex + 1 >= optionElements.length ? 0 : activeIndex + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      markActive(activeIndex - 1 < 0 ? optionElements.length - 1 : activeIndex - 1);
      return;
    }
    if (event.key === 'Enter') {
      if (activeIndex < 0) return;
      event.preventDefault();
      event.stopPropagation();
      selectSuggestion(activeIndex);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideSuggestions();
      return;
    }
    if (event.key === 'Tab') hideSuggestions();
  }

  function onFocusIn(event) {
    const target = event.target;
    if (isField(target) && looksLikeLogin(target)) showSuggestions(target);
  }

  function onFocusOut(event) {
    if (targetInput !== null && event.target === targetInput) hideSuggestions();
  }

  // A different saved username typed into the form swaps the password, but only
  // while the field still holds what this script put there.
  function onInput(event) {
    const target = event.target;
    if (!isField(target)) return;
    const type = typeOf(target);
    if (type === 'text' || type === 'email' || type === 'tel') {
      const fields = passwordFields();
      if (fields.length === 1) {
        const password = fields[0];
        if (password.value === activePassword) {
          const match = candidateFor(target.value);
          if (match && match.password !== password.value) {
            setValue(password, match.password);
            activePassword = match.password;
          }
        }
      }
    }
    if (suppressInput) return;
    if (looksLikeLogin(target)) showSuggestions(target);
  }

  function onScroll() {
    hideSuggestions();
  }

  function onResize() {
    hideSuggestions();
  }

  // An in-page navigation can inject this script again into the same document;
  // the previous run's listeners, observer and dropdown are retired first, so a
  // long-lived SPA never accumulates them. The marker holds only a dispose
  // function.
  const globalKey = '__daisySavedSignInFill';
  const previous = window[globalKey];

  let observer = null;
  let timer = null;
  let stopped = false;

  function stopWatching() {
    stopped = true;
    if (observer !== null) observer.disconnect();
    if (timer !== null) clearTimeout(timer);
  }

  function dispose() {
    stopWatching();
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    if (host !== null && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    list = null;
    targetInput = null;
    matches = [];
    optionElements = [];
    activeIndex = -1;
  }

  if (previous && typeof previous.dispose === 'function') previous.dispose();
  window[globalKey] = { dispose: dispose };

  const initial = fill();
  document.addEventListener('input', onInput, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);

  // The form may still be rendering (an identity provider's two-step flow), or
  // the second step may replace the first in the same document. Keep watching
  // until a password step is reached, or for a bounded window.
  if (!initial.passwordStep && credentials.length > 0) {
    observer = new MutationObserver(() => {
      if (stopped) return;
      if (fill().passwordStep) stopWatching();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    timer = setTimeout(stopWatching, watchMs);
  }

  return initial.wrote;
})();`;
}
