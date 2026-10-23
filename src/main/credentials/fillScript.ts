/**
 * The prefill script: what main injects into a page on `dom-ready` to put a
 * saved sign-in into its form.
 *
 * It runs in the page's main world through `webContents.executeJavaScript` -
 * not through the preload - for three reasons: a login form is frequently
 * rendered by the page's own script (React/Angular identity-provider steps),
 * which only the main world can drive correctly; `executeJavaScript` bypasses
 * the page's CSP, where a script tag would not; and SSO windows opened by
 * `window.open` have no preload at all, so this is the only mechanism that
 * reaches them. The origin gate lives in `autofill.ts`, before anything is
 * injected: main never builds this string for an origin the vault does not
 * know.
 *
 * The script is deliberately silent about what it did beyond returning whether
 * it filled something, never clicks, and never submits:
 *
 * - it fills only **empty** fields, so a value the user (or the page) already
 *   put there wins;
 * - it refuses a page with more than one password field, or a `new-password`
 *   one: that is a change-password form, and filling it would be wrong;
 * - it fills the **first** credential (the origin's most recently used one),
 *   then watches the username field: typing a different saved username swaps
 *   the password to that entry - which is how a second account on the same
 *   origin is reached without a picker;
 * - it swaps only while the password field still holds the value it filled, so
 *   a password the user typed is never overwritten;
 * - it re-tries through a `MutationObserver` for a bounded window, because an
 *   identity provider's password step often renders after `dom-ready`.
 *
 * Passwords reach the page as a JSON literal in this function's own closure.
 * Page script cannot read that closure; it can read the input values, which is
 * exactly what it could read if the user had typed them.
 */

export interface FillCredential {
  readonly username: string;
  readonly password: string;
}

/** How long the observer keeps waiting for a form that is not there yet. */
export const FILL_WATCH_MS = 10_000;

/**
 * Builds the script for one origin's credentials (most recently used first).
 * Pure: no Electron, no I/O - the unit tests execute the result against jsdom.
 */
export function buildCredentialFillScript(credentials: readonly FillCredential[]): string {
  const serialized = JSON.stringify(
    credentials.map((credential) => ({
      username: credential.username,
      password: credential.password,
    })),
  );

  return `(() => {
  const credentials = ${serialized};
  const watchMs = ${FILL_WATCH_MS};
  if (!Array.isArray(credentials) || credentials.length === 0) return false;
  if (!document.documentElement) return false;

  const isField = (el) => el && el.tagName === 'INPUT';
  const typeOf = (el) => ((el.getAttribute('type') || 'text') + '').toLowerCase();
  const passwordFields = () =>
    Array.from(document.querySelectorAll('input')).filter(
      (el) => isField(el) && typeOf(el) === 'password' && !el.disabled,
    );

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
      if (!isField(candidate) || candidate.disabled) continue;
      const type = typeOf(candidate);
      if (type === 'text' || type === 'email' || type === 'tel') return candidate;
    }
    const named = form.querySelector('input[autocomplete="username"]');
    return isField(named) ? named : null;
  }

  let activePassword = credentials[0].password;
  let stopWatching = null;

  function fill() {
    const fields = passwordFields();
    if (fields.length !== 1) return false;
    const password = fields[0];
    if ((password.getAttribute('autocomplete') || '').toLowerCase() === 'new-password') {
      return false;
    }
    const username = usernameFieldFor(password);
    if (username && username.value === '' && credentials[0].username !== '') {
      setValue(username, credentials[0].username);
    }
    if (password.value === '' && credentials[0].password !== '') {
      setValue(password, credentials[0].password);
      activePassword = credentials[0].password;
    }
    return true;
  }

  function candidateFor(value) {
    const wanted = value.trim().toLowerCase();
    if (!wanted) return null;
    return (
      credentials.find((credential) => credential.username.toLowerCase() === wanted) || null
    );
  }

  // A different saved username typed into the form swaps the password, but only
  // while the field still holds what this script put there.
  function onInput(event) {
    const target = event.target;
    if (!isField(target)) return;
    const type = typeOf(target);
    if (type === 'password' || (type !== 'text' && type !== 'email' && type !== 'tel')) return;
    const fields = passwordFields();
    if (fields.length !== 1) return;
    const password = fields[0];
    if (password.value !== activePassword) return;
    const match = candidateFor(target.value);
    if (!match || match.password === password.value) return;
    setValue(password, match.password);
    activePassword = match.password;
  }

  // An in-page navigation can inject this script again into the same document;
  // the previous run's listener and observer are retired first, so a long-lived
  // SPA never accumulates them. The marker holds only a dispose function.
  const globalKey = '__daisySavedSignInFill';
  const previous = window[globalKey];
  if (previous && typeof previous.dispose === 'function') previous.dispose();

  const filledNow = fill();
  document.addEventListener('input', onInput, true);
  window[globalKey] = {
    dispose: () => {
      document.removeEventListener('input', onInput, true);
      if (stopWatching) stopWatching();
    },
  };
  if (filledNow) return true;

  // The form may still be rendering (an identity provider's two-step flow): watch
  // for it for a bounded time, then stop for good.
  let stopped = false;
  let timer = null;
  const observer = new MutationObserver(() => {
    if (stopped) return;
    if (fill()) {
      stopped = true;
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  timer = setTimeout(() => {
    stopped = true;
    observer.disconnect();
  }, watchMs);
  stopWatching = () => {
    stopped = true;
    observer.disconnect();
    if (timer !== null) clearTimeout(timer);
  };
  return false;
})();`;
}
