import { describe, expect, it } from 'vitest';
import { describeNetworkError } from '../../../../src/main/browser/networkErrorCopy';

/**
 * The message a user sees in the browser pane (browserToolbar.ts renders
 * `error.message`) must be *humanised* copy - a laconic statement naming the
 * address, never the raw Chromium `ERR_*` string, and never the low-level
 * rejection message ("ERR_CONNECTION_REFUSED (-102) loading '...'" is what
 * headless Chromium gives us, with the code buried inside prose). Guidance
 * ("check ... then try again") is deliberately absent because the error row
 * already carries a "Reload" that retries the failed navigation; the proxy
 * hint is the one exception, since no control on the row fixes a proxy. The
 * exact code still rides on `BrowserIpcError.errorCode` for programmatic
 * branching. No message ends with a full stop.
 */
const NEVER_SEEN = ['ERR_', '(-', 'loading ', 'setting proxy'];
const CHECK_ADDRESS = 'http://127.0.0.1:4502/';

describe('describeNetworkError', () => {
  it('names the address in the message for every kind of failure', () => {
    for (const code of [
      'ERR_CONNECTION_REFUSED',
      'ERR_NAME_NOT_RESOLVED',
      'ERR_TIMED_OUT',
      'ERR_CONNECTION_RESET',
      'ERR_PROXY_CONNECTION_FAILED',
      'ERR_CERT_AUTHORITY_INVALID',
      'ERR_SOME_FUTURE_CODE',
    ]) {
      expect(describeNetworkError(code, CHECK_ADDRESS)).toContain(CHECK_ADDRESS);
    }
  });

  it('never leaks a Chromium code, a bracketed code, or a raw rejection string into copy', () => {
    const codes = [
      'ERR_CONNECTION_REFUSED',
      'ERR_NAME_NOT_RESOLVED',
      'ERR_TIMED_OUT',
      'ERR_CONNECTION_RESET',
      'ERR_PROXY_CONNECTION_FAILED',
      'ERR_CERT_AUTHORITY_INVALID',
      'ERR_TOTALLY_UNKNOWN',
    ];
    for (const code of codes) {
      const message = describeNetworkError(code, CHECK_ADDRESS);
      for (const forbidden of NEVER_SEEN) {
        expect(message).not.toContain(forbidden);
      }
    }
  });

  it('never ends a message with a full stop', () => {
    const codes = [
      'ERR_CONNECTION_REFUSED',
      'ERR_NAME_NOT_RESOLVED',
      'ERR_CONNECTION_TIMED_OUT',
      'ERR_TIMED_OUT',
      'ERR_CONNECTION_RESET',
      'ERR_CONNECTION_CLOSED',
      'ERR_EMPTY_RESPONSE',
      'ERR_PROXY_CONNECTION_FAILED',
      'ERR_CERT_AUTHORITY_INVALID',
      'ERR_TOTALLY_UNKNOWN',
    ];
    for (const code of codes) {
      expect(describeNetworkError(code, CHECK_ADDRESS).endsWith('.')).toBe(false);
    }
  });
});
