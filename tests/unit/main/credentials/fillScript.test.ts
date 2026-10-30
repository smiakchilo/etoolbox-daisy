import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCredentialFillScript,
  SUGGESTION_HOST_ATTRIBUTE,
  type FillCredential,
} from '../../../../src/main/credentials/fillScript';

/**
 * The injected script, executed for real against a jsdom document. Building the
 * string and asserting on its text would prove nothing; running it proves the
 * two properties that matter - an empty field is filled, and a page whose shape
 * means "not a sign-in form" is left alone.
 *
 * `runScripts: 'dangerously'` is what lets `window.eval` execute the script
 * exactly as Chromium would (the same main-world evaluation
 * `executeJavaScript` performs).
 */

const pages: JSDOM[] = [];

interface Page {
  readonly document: Document;
  readonly window: JSDOM['window'];
}

function page(markup: string): Page {
  const dom = new JSDOM(`<!doctype html><html lang="en"><body>${markup}</body></html>`, {
    runScripts: 'dangerously',
    url: 'https://author.example.com/libs/granite/core/content/login.html',
  });
  pages.push(dom);
  return { document: dom.window.document, window: dom.window };
}

afterEach(() => {
  for (const dom of pages.splice(0)) {
    const holder = dom.window as unknown as {
      __daisySavedSignInFill?: { dispose?: () => void };
    };
    holder.__daisySavedSignInFill?.dispose?.();
    dom.window.close();
  }
});

const primary: FillCredential = { username: 'admin', password: 'secret' };

function evalFill(
  target: Page,
  credentials: readonly FillCredential[],
  suggestions: readonly string[] = [],
): unknown {
  return target.window.eval(buildCredentialFillScript(credentials, suggestions));
}

function valueOf(target: Page, selector: string): string {
  const element = target.document.querySelector<HTMLInputElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  return element.value;
}

function typeInto(target: Page, selector: string, value: string): void {
  const field = target.document.querySelector<HTMLInputElement>(selector);
  if (field === null) throw new Error(`no ${selector}`);
  field.value = value;
  field.dispatchEvent(new target.window.Event('input', { bubbles: true }));
}

describe('buildCredentialFillScript', () => {
  it('fills an empty Granite form and reports that it did', () => {
    const target = page(`
      <form method="post" action="/j_security_check">
        <input type="text" name="j_username">
        <input type="password" name="j_password">
        <button type="submit">Sign in</button>
      </form>`);

    expect(evalFill(target, [primary])).toBe(true);
    expect(valueOf(target, 'input[name="j_username"]')).toBe('admin');
    expect(valueOf(target, 'input[name="j_password"]')).toBe('secret');
  });

  it('ignores the hidden change-password fields on AEM’s sign-in form', () => {
    const target = page(`
      <form method="post" action="/j_security_check">
        <input type="text" name="j_username">
        <input type="password" name="j_password">
        <input type="password" id="new_password" hidden>
        <input type="password" id="confirm_password" hidden>
        <button type="submit">Sign in</button>
      </form>`);

    expect(evalFill(target, [primary])).toBe(true);
    expect(valueOf(target, 'input[name="j_username"]')).toBe('admin');
    expect(valueOf(target, 'input[name="j_password"]')).toBe('secret');
    expect(valueOf(target, '#new_password')).toBe('');
    expect(valueOf(target, '#confirm_password')).toBe('');
  });

  it('does not overwrite a field the page (or the user) already filled', () => {
    const target = page(`
      <form>
        <input type="text" name="j_username" value="someone-else">
        <input type="password" name="j_password" value="typed">
      </form>`);

    evalFill(target, [primary]);

    expect(valueOf(target, 'input[name="j_username"]')).toBe('someone-else');
    expect(valueOf(target, 'input[name="j_password"]')).toBe('typed');
  });

  it('leaves a change-password form alone (two password fields)', () => {
    const target = page(`
      <form>
        <input type="password" name="current">
        <input type="password" name="next">
      </form>`);

    expect(evalFill(target, [primary])).toBe(false);
    expect(valueOf(target, 'input[name="current"]')).toBe('');
    expect(valueOf(target, 'input[name="next"]')).toBe('');
  });

  it('leaves a new-password field alone', () => {
    const target = page(`
      <form>
        <input type="text" name="user">
        <input type="password" name="secret" autocomplete="new-password">
      </form>`);

    expect(evalFill(target, [primary])).toBe(false);
    expect(valueOf(target, 'input[name="secret"]')).toBe('');
  });

  it('fills a username-only step and reports that it did', () => {
    // An identity provider's first page asks only who the user is; the email
    // field is the one thing a saved sign-in can still fill there.
    const target = page(`
      <form>
        <input type="email" name="loginfmt">
        <button type="submit">Next</button>
      </form>`);

    expect(evalFill(target, [primary, { username: 'me@example.com', password: '' }])).toBe(true);
    expect(valueOf(target, 'input[name="loginfmt"]')).toBe('admin');
  });

  it('does not fill an arbitrary text field on a page with no password field', () => {
    const target = page(`
      <form>
        <input type="text" name="q">
        <button type="submit">Search</button>
      </form>`);

    expect(evalFill(target, [primary])).toBe(false);
    expect(valueOf(target, 'input[name="q"]')).toBe('');
  });

  it('ignores a password decoy the page hides from assistive tech', () => {
    // Adobe's email page: the email field, and a password input whose only job
    // is to decoy password managers (`credential-hide-helper`).
    const target = page(`
      <form id="EmailForm">
        <input id="EmailPage-EmailField" type="email" name="username" value="">
        <div class="credential-hide-helper">
          <input autocomplete="current-password" aria-hidden="true" name="passwd"
                 type="password" tabindex="-1">
        </div>
        <button type="submit">Continue</button>
      </form>`);
    const credential = { username: 'me@example.com', password: 'secret' };

    expect(evalFill(target, [credential])).toBe(true);
    expect(valueOf(target, '#EmailPage-EmailField')).toBe('me@example.com');
    // The saved password must not be typed into a field the page never shows.
    expect(valueOf(target, 'input[name="passwd"]')).toBe('');
  });

  it('keeps watching after a username-only step and fills the password step that follows', async () => {
    const target = page(`
      <form id="EmailForm">
        <input type="email" name="username">
        <button type="submit">Continue</button>
      </form>`);
    const credential = { username: 'me@example.com', password: 'secret' };

    expect(evalFill(target, [credential])).toBe(true);
    expect(valueOf(target, 'input[name="username"]')).toBe('me@example.com');

    // The provider replaces its first step with the password step in the same
    // document (no navigation, so no re-injection).
    const next = target.document.createElement('form');
    next.innerHTML =
      '<input type="password" name="password"><button type="submit">Sign in</button>';
    target.document.querySelector('#EmailForm')?.replaceWith(next);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(valueOf(target, 'input[name="password"]')).toBe('secret');
  });

  it('fills a password step whose username field is absent (step 2)', () => {
    const target = page(`
      <form>
        <input type="password" name="passwd">
      </form>`);

    expect(evalFill(target, [primary])).toBe(true);
    expect(valueOf(target, 'input[name="passwd"]')).toBe('secret');
  });

  it('switches the password when a different saved username is typed', () => {
    const target = page(`
      <form>
        <input type="text" name="j_username">
        <input type="password" name="j_password">
      </form>`);
    const second: FillCredential = { username: 'author', password: 'author-secret' };

    evalFill(target, [primary, second]);
    expect(valueOf(target, 'input[name="j_password"]')).toBe('secret');

    typeInto(target, 'input[name="j_username"]', 'author');
    expect(valueOf(target, 'input[name="j_password"]')).toBe('author-secret');
  });

  it('never replaces a password the user typed while switching usernames', () => {
    const target = page(`
      <form>
        <input type="text" name="j_username">
        <input type="password" name="j_password">
      </form>`);
    const second: FillCredential = { username: 'author', password: 'author-secret' };
    evalFill(target, [primary, second]);

    typeInto(target, 'input[name="j_password"]', 'hand-typed');
    typeInto(target, 'input[name="j_username"]', 'author');

    expect(valueOf(target, 'input[name="j_password"]')).toBe('hand-typed');
  });

  it('retires the previous run when injected twice into one document', () => {
    const target = page(`
      <form>
        <input type="text" name="j_username">
        <input type="password" name="j_password">
      </form>`);

    evalFill(target, [primary]);
    typeInto(target, 'input[name="j_password"]', '');
    evalFill(target, [{ username: 'other', password: 'other-secret' }]);

    // The second run owns the document: a typed username now resolves against
    // the second run's list, and the first run's listener is gone.
    typeInto(target, 'input[name="j_username"]', 'admin');
    expect(valueOf(target, 'input[name="j_password"]')).toBe('other-secret');
  });

  it('waits for a form that renders after the script ran', async () => {
    const target = page('<div id="root"></div>');

    expect(evalFill(target, [primary])).toBe(false);

    const form = target.document.createElement('form');
    form.innerHTML =
      '<input type="text" name="j_username"><input type="password" name="j_password">';
    target.document.querySelector('#root')?.append(form);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(valueOf(target, 'input[name="j_username"]')).toBe('admin');
    expect(valueOf(target, 'input[name="j_password"]')).toBe('secret');
  });

  it('does nothing with an empty credential list', () => {
    const target = page(`
      <form><input type="password" name="j_password"></form>`);

    expect(evalFill(target, [])).toBe(false);
    expect(valueOf(target, 'input[name="j_password"]')).toBe('');
  });
});

describe('the username suggestion list', () => {
  const suggestions = ['me@example.com', 'admin', 'someone@example.com'];

  function focusField(target: Page, selector: string): HTMLInputElement {
    const field = target.document.querySelector<HTMLInputElement>(selector);
    if (field === null) throw new Error(`no ${selector}`);
    field.dispatchEvent(new target.window.FocusEvent('focusin', { bubbles: true }));
    return field;
  }

  function press(target: Page, field: HTMLInputElement, key: string): void {
    field.dispatchEvent(
      new target.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  }

  function suggestionHost(target: Page): Element | null {
    return target.document.querySelector(`[${SUGGESTION_HOST_ATTRIBUTE}]`);
  }

  it('offers the remembered usernames on focus and fills the chosen one', () => {
    const target = page(`
      <form>
        <input type="email" name="username">
        <button type="submit">Continue</button>
      </form>`);
    evalFill(target, [], suggestions);

    const field = focusField(target, 'input[name="username"]');
    expect(suggestionHost(target)).not.toBeNull();

    press(target, field, 'ArrowDown');
    press(target, field, 'Enter');

    expect(field.value).toBe('me@example.com');
  });

  it('filters the list as the user types', () => {
    const target = page(`
      <form>
        <input type="email" name="username">
        <button type="submit">Continue</button>
      </form>`);
    evalFill(target, [], suggestions);

    const field = focusField(target, 'input[name="username"]');
    field.value = 'some';
    field.dispatchEvent(new target.window.Event('input', { bubbles: true }));
    press(target, field, 'ArrowDown');
    press(target, field, 'Enter');

    expect(field.value).toBe('someone@example.com');
  });

  it('never opens on a password field', () => {
    const target = page(`
      <form>
        <input type="text" name="user">
        <input type="password" name="password">
        <button type="submit">Sign in</button>
      </form>`);
    evalFill(target, [], suggestions);

    const field = focusField(target, 'input[name="password"]');
    press(target, field, 'ArrowDown');
    press(target, field, 'Enter');

    expect(suggestionHost(target)).toBeNull();
    expect(field.value).toBe('');
  });

  it('retires its list and listeners when the script is injected again', () => {
    const target = page(`
      <form>
        <input type="email" name="username">
        <button type="submit">Continue</button>
      </form>`);
    evalFill(target, [], suggestions);
    focusField(target, 'input[name="username"]');
    expect(suggestionHost(target)).not.toBeNull();

    evalFill(target, [], suggestions);
    expect(suggestionHost(target)).toBeNull();
  });
});
