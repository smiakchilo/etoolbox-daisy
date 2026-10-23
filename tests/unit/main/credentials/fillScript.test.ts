import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCredentialFillScript,
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
  for (const dom of pages.splice(0)) dom.window.close();
});

const primary: FillCredential = { username: 'admin', password: 'secret' };

function evalFill(target: Page, credentials: readonly FillCredential[]): unknown {
  return target.window.eval(buildCredentialFillScript(credentials));
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

  it('does nothing on a username-only page (there is no password field to fill)', () => {
    const target = page(`
      <form>
        <input type="email" name="loginfmt">
        <button type="submit">Next</button>
      </form>`);

    // No password field: nothing to fill, and the page is not reported as a
    // sign-in form. The two-step password page is a separate document.
    expect(evalFill(target, [primary])).toBe(false);
    expect(valueOf(target, 'input[name="loginfmt"]')).toBe('');
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
