/**
 * Saved sign-ins, page side: the one thing the remote page's preload does that
 * is not the bridge.
 *
 * A submitted sign-in form is reported to main, which decides the origin from
 * the sending frame (never from this payload) and remembers the pair for that
 * origin. There is no UI and no confirmation: this application is not a
 * general-purpose browser, the pane is the user's own signed-in session, and
 * the vault is DPAPI-encrypted in the app's technical folder. Chrome asks
 * because it browses the whole web; this pane browses the user's AEM hosts and
 * the identity providers in front of them.
 *
 * The rules that keep a capture honest - each has a case in
 * `tests/unit/preload/credentialCapture.test.ts`:
 *
 * - **Exactly one non-hidden password field** in the form. An account page's
 *   change-password form has two or three, and remembering one of them would
 *   overwrite the working credential with a new one that is not the login's.
 *   AEM's ordinary sign-in form also carries its new/confirm-password inputs,
 *   but hidden; those do not count until the page shows them for a password
 *   change, at which point this guard refuses the form again.
 * - **Never a `new-password` field** (`autocomplete="new-password"` on the
 *   field or the form) - the same form, by another signal.
 * - **Never an empty password**, and never a password field with no username
 *   anywhere in the form *yet*: main falls back to the origin's most recent
 *   username, but an empty password is not a credential.
 * - **One report per action.** A submit can arrive as `submit`, as Enter in the
 *   password field, and as a click on the button; the three are deduped by the
 *   payload plus a short window, so main sees one report.
 *
 * This module imports nothing but types, so it is unit-testable against jsdom;
 * `webview-preload.ts` is the thin wiring that supplies the document and the
 * IPC send.
 */

export interface CredentialCapturePayload {
  /** May be empty: an identity provider's password step often omits the field. */
  readonly username: string;
  readonly password: string;
}

/**
 * How long a repeated identical report is dropped. Long enough for one form
 * submission's submit/keydown/click to collapse into one message, short enough
 * that signing in twice in a row still reports twice.
 */
export const CAPTURE_DEDUPE_MS = 1500;

const USERNAME_INPUT_TYPES = new Set(['text', 'email', 'tel']);

/**
 * The element an event names, without an `instanceof Element` check: this
 * module is exercised against jsdom, whose constructors are not the globals a
 * preload normally sees, and a duck-typed `closest` is the only capability the
 * listeners need anyway.
 */
function elementOf(target: EventTarget | null): Element | null {
  if (target === null || typeof target !== 'object') return null;
  const candidate = target as Partial<Element>;
  return typeof candidate.closest === 'function' ? (target as Element) : null;
}

function inputType(input: Element): string {
  return (input.getAttribute('type') ?? 'text').toLowerCase();
}

function isDisabled(input: Element): boolean {
  return input.hasAttribute('disabled');
}

/** Hidden change-password inputs share AEM's ordinary sign-in form; they are not candidates. */
function isPasswordCandidate(input: Element): boolean {
  return inputType(input) === 'password' && !isDisabled(input) && !input.hasAttribute('hidden');
}

/**
 * The element's live `value`, without trusting its type: `Reflect.get` is
 * `any`-typed, and only an input-shaped element is ever passed here.
 */
function inputValue(input: Element): string {
  const value: unknown = Reflect.get(input, 'value');
  return typeof value === 'string' ? value : '';
}

/**
 * The form's credentials, or `undefined` when this is not a sign-in form we may
 * remember. `scope` is the submitted form, or the document for a password field
 * that is not inside one.
 */
export function readCredentialFrom(
  scope: ParentNode,
  passwordInput: Element,
): CredentialCapturePayload | undefined {
  const live = inputValue(passwordInput);
  const passwordValue = live.length > 0 ? live : (passwordInput.getAttribute('value') ?? '');
  if (passwordValue.length === 0) return undefined;
  if ((passwordInput.getAttribute('autocomplete') ?? '').toLowerCase() === 'new-password') {
    return undefined;
  }

  const passwordInputs = Array.from(scope.querySelectorAll('input')).filter(isPasswordCandidate);
  if (passwordInputs.length !== 1) return undefined;

  const inputs = Array.from(scope.querySelectorAll<Element>('input'));
  const passwordIndex = inputs.indexOf(passwordInput);
  let usernameInput: Element | undefined;
  // Walk backwards from the password field: the nearest preceding text-ish
  // input is the username in every sign-in form shape we know (Granite's
  // `j_username`, an IdP's `username`/`loginfmt`, a plain email field).
  for (let index = passwordIndex - 1; index >= 0; index -= 1) {
    const input = inputs[index];
    if (input === undefined || isDisabled(input)) continue;
    if (!USERNAME_INPUT_TYPES.has(inputType(input))) continue;
    usernameInput = input;
    break;
  }
  usernameInput ??= scope.querySelector('input[autocomplete="username"]') ?? undefined;

  const username = usernameInput === undefined ? '' : inputValue(usernameInput).trim();

  return { username, password: passwordValue };
}

/** The single password input an element belongs to, or `undefined` for a page we must not touch. */
export function findSignInForm(doc: Document, target: Element | null): Element | undefined {
  const form = target?.closest('form') ?? null;
  const scope: ParentNode = form ?? doc;
  const passwords = Array.from(scope.querySelectorAll('input')).filter(isPasswordCandidate);
  if (passwords.length !== 1) return undefined;
  if (form !== null && (form.getAttribute('autocomplete') ?? '').toLowerCase() === 'new-password') {
    return undefined;
  }
  return passwords[0];
}

/**
 * Installs the capture listeners. Returns a function that removes them (the
 * preload never calls it - a document's listeners die with the document - but
 * a unit test needs to).
 */
export function installCredentialCapture(
  doc: Document,
  send: (capture: CredentialCapturePayload) => void,
  now: () => number = Date.now,
): () => void {
  let lastPayload: CredentialCapturePayload | undefined;
  let lastAt = Number.NEGATIVE_INFINITY;

  function report(target: Element | null): void {
    try {
      const passwordInput = findSignInForm(doc, target);
      if (passwordInput === undefined) return;
      const scope: ParentNode = passwordInput.closest('form') ?? doc;
      const payload = readCredentialFrom(scope, passwordInput);
      if (payload === undefined) return;
      if (
        lastPayload !== undefined &&
        lastPayload.username === payload.username &&
        lastPayload.password === payload.password &&
        now() - lastAt < CAPTURE_DEDUPE_MS
      ) {
        return;
      }
      lastPayload = payload;
      lastAt = now();
      send(payload);
    } catch {
      // A capture must never break the page's own sign-in. Anything unexpected
      // (an exotic DOM, a detached form) just means this submission is not
      // remembered.
    }
  }

  const onSubmit = (event: Event): void => {
    report(elementOf(event.target));
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return;
    report(elementOf(event.target));
  };
  const onClick = (event: MouseEvent): void => {
    const target = elementOf(event.target);
    if (target === null) return;
    report(target.closest('button, input[type="submit"], input[type="button"]'));
  };

  // Capture phase, so a form whose own handler stops propagation still reports.
  doc.addEventListener('submit', onSubmit, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('click', onClick, true);

  return () => {
    doc.removeEventListener('submit', onSubmit, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('click', onClick, true);
  };
}
