import { describe, expect, it } from 'vitest';
import { decideWindowOpen } from '../../../../src/main/browser/windowOpenPolicy';

/**
 * The popup/tab matrix, pinned to what Chromium actually reports as
 * `disposition` (measured against a real page - see `docs/verification.md`):
 *
 * | call                                          | disposition    |
 * | --------------------------------------------- | -------------- |
 * | `window.open(u,'n','noopener')`               | foreground-tab |
 * | `window.open(u,'n','noreferrer')`             | foreground-tab |
 * | `window.open(u,'n','width=420,height=520')`   | new-window     |
 * | `window.open(u,'n','popup=yes')`              | new-window     |
 * | `window.open(u,'n')`                          | foreground-tab |
 * | `window.open(u,'n','width=...,noopener')`     | new-window     |
 * | `<a target="_blank">` click                   | foreground-tab |
 */
describe('decideWindowOpen', () => {
  it('treats a new-window disposition (window.open with window features) as a popup', () => {
    expect(
      decideWindowOpen({
        url: 'https://idp.example.com/authorize',
        disposition: 'new-window',
      }),
    ).toEqual({ kind: 'popup' });
  });

  it.each(['default', 'foreground-tab', 'background-tab', 'other'] as const)(
    'routes a %s request in place',
    (disposition) => {
      expect(
        decideWindowOpen({
          url: 'https://author.example/content/next.html',
          disposition,
        }),
      ).toEqual({ kind: 'navigate-in-place' });
    },
  );

  it("does not mistake the 'noopener'/'noreferrer' feature tokens for a popup", () => {
    // AEM's own Sites "Edit" action is
    // `window.open(url, name, 'noopener')` and Chromium reports it as
    // foreground-tab; classifying on `features !== ''` used to open a window.
    expect(
      decideWindowOpen({
        url: 'https://author.example/bin/wcmcommand?cmd=open&path=/content/site',
        disposition: 'foreground-tab',
      }),
    ).toEqual({ kind: 'navigate-in-place' });
  });

  it('denies a non-http(s) target even when it looks like a popup', () => {
    expect(decideWindowOpen({ url: 'file:///C:/secret.txt', disposition: 'new-window' })).toEqual({
      kind: 'deny',
    });
    expect(decideWindowOpen({ url: 'javascript:alert(1)', disposition: 'foreground-tab' })).toEqual(
      { kind: 'deny' },
    );
  });

  it('denies a malformed URL', () => {
    expect(decideWindowOpen({ url: 'not a url', disposition: 'default' })).toEqual({
      kind: 'deny',
    });
  });
});
