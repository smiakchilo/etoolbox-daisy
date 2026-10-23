import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_DEDUPE_MS,
  installCredentialCapture,
  readCredentialFrom,
  type CredentialCapturePayload,
} from '../../../src/preload/credentialCapture';
import { installJsdomGlobals } from '../../support/jsdomGlobals';

/**
 * The page-side capture rules, executed against jsdom. Each case here is a
 * promise the feature makes about the forms it will and will not remember; the
 * main-side origin decision is `tests/unit/main/credentials/capture.test.ts`.
 */

let dom: JSDOM;
let restoreGlobals: () => void;

const send = vi.fn<(payload: CredentialCapturePayload) => void>();

beforeEach(() => {
  send.mockReset();
  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
});

afterEach(() => {
  restoreGlobals();
});

function form(markup: string): HTMLFormElement {
  dom.window.document.body.innerHTML = markup;
  const element = dom.window.document.querySelector('form');
  if (element === null) throw new Error('fixture has no form');
  return element;
}

function submit(element: HTMLFormElement): void {
  element.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

const GRANITE_FORM = `
  <form method="post" action="/j_security_check">
    <input type="text" name="j_username" value="">
    <input type="password" name="j_password" value="">
    <button type="submit">Sign in</button>
  </form>`;

describe('installCredentialCapture', () => {
  it('reports the submitted pair once, on submit', () => {
    const element = form(GRANITE_FORM);
    installCredentialCapture(dom.window.document, send);
    (dom.window.document.querySelector('input[name="j_username"]') as HTMLInputElement).value =
      'admin';
    (dom.window.document.querySelector('input[name="j_password"]') as HTMLInputElement).value =
      'admin';

    submit(element);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ username: 'admin', password: 'admin' });
  });

  it('collapses one submission reported by submit, Enter and a button click', () => {
    const element = form(GRANITE_FORM);
    (dom.window.document.querySelector('input[name="j_username"]') as HTMLInputElement).value =
      'admin';
    const password = dom.window.document.querySelector(
      'input[name="j_password"]',
    ) as HTMLInputElement;
    password.value = 'admin';
    installCredentialCapture(dom.window.document, send);

    submit(element);
    password.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    (dom.window.document.querySelector('button') as HTMLButtonElement).click();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports again when the same pair is submitted after the dedupe window', () => {
    let nowMs = 1_000;
    const element = form(GRANITE_FORM);
    (dom.window.document.querySelector('input[name="j_username"]') as HTMLInputElement).value =
      'admin';
    (dom.window.document.querySelector('input[name="j_password"]') as HTMLInputElement).value =
      'admin';
    installCredentialCapture(dom.window.document, send, () => nowMs);

    submit(element);
    nowMs += CAPTURE_DEDUPE_MS + 1;
    submit(element);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never reports a change-password form (two password fields)', () => {
    const element = form(`
      <form>
        <input type="password" name="current">
        <input type="password" name="new">
        <button type="submit">Change</button>
      </form>`);
    installCredentialCapture(dom.window.document, send);
    (dom.window.document.querySelector('input[name="current"]') as HTMLInputElement).value = 'a';
    (dom.window.document.querySelector('input[name="new"]') as HTMLInputElement).value = 'b';

    submit(element);

    expect(send).not.toHaveBeenCalled();
  });

  it('never reports a new-password field', () => {
    const element = form(`
      <form>
        <input type="text" name="user" value="admin">
        <input type="password" name="secret" autocomplete="new-password" value="fresh">
      </form>`);
    installCredentialCapture(dom.window.document, send);

    submit(element);

    expect(send).not.toHaveBeenCalled();
  });

  it('never reports a new-password form', () => {
    // noinspection HtmlWrongAttributeValue
    const element = form(`
      <form autocomplete="new-password">
        <input type="text" name="user" value="admin">
        <input type="password" name="secret" value="fresh">
      </form>`);
    installCredentialCapture(dom.window.document, send);

    submit(element);

    expect(send).not.toHaveBeenCalled();
  });

  it('never reports an empty password', () => {
    const element = form(GRANITE_FORM);
    installCredentialCapture(dom.window.document, send);
    (dom.window.document.querySelector('input[name="j_username"]') as HTMLInputElement).value =
      'admin';

    submit(element);

    expect(send).not.toHaveBeenCalled();
  });

  it('reports an empty username when the password step omits it (main fills it in)', () => {
    const element = form(`
      <form>
        <input type="password" name="passwd" value="secret">
        <button type="submit">Sign in</button>
      </form>`);
    installCredentialCapture(dom.window.document, send);

    submit(element);

    expect(send).toHaveBeenCalledWith({ username: '', password: 'secret' });
  });

  it('prefers the nearest text input before the password field as the username', () => {
    const element = form(`
      <form>
        <input type="text" name="search" value="not-a-username">
        <input type="text" name="loginfmt" value="someone@example.com">
        <input type="password" name="passwd" value="secret">
      </form>`);
    installCredentialCapture(dom.window.document, send);

    submit(element);

    expect(send).toHaveBeenCalledWith({ username: 'someone@example.com', password: 'secret' });
  });

  it('stops reporting once disposed', () => {
    const element = form(GRANITE_FORM);
    const dispose = installCredentialCapture(dom.window.document, send);
    (dom.window.document.querySelector('input[name="j_password"]') as HTMLInputElement).value =
      'admin';

    dispose();
    submit(element);

    expect(send).not.toHaveBeenCalled();
  });
});

describe('readCredentialFrom', () => {
  it('reads the live value rather than the markup attribute', () => {
    form(GRANITE_FORM);
    const password = dom.window.document.querySelector(
      'input[name="j_password"]',
    ) as HTMLInputElement;
    password.value = 'typed';
    expect(readCredentialFrom(dom.window.document, password)).toEqual({
      username: '',
      password: 'typed',
    });
  });

  it('reads an empty username as empty rather than failing', () => {
    form(GRANITE_FORM);
    const password = dom.window.document.querySelector(
      'input[name="j_password"]',
    ) as HTMLInputElement;
    password.value = 'typed';
    const result = readCredentialFrom(dom.window.document, password);
    expect(result?.username).toBe('');
  });

  it('falls back to the value attribute for a field no script has touched', () => {
    form(`
      <form>
        <input type="text" name="user" value="admin">
        <input type="password" name="secret" value="markup-password">
      </form>`);
    const password = dom.window.document.querySelector('input[name="secret"]') as HTMLInputElement;
    expect(readCredentialFrom(dom.window.document, password)).toEqual({
      username: 'admin',
      password: 'markup-password',
    });
  });
});

describe('the document it sees', () => {
  it('ignores a submission with no password field at all', () => {
    const element = form(`
      <form><input type="text" name="q" value="hello"><button type="submit">Go</button></form>`);
    installCredentialCapture(dom.window.document, send);

    submit(element);

    expect(send).not.toHaveBeenCalled();
  });
});
