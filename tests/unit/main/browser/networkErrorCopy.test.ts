import { describe, expect, it } from 'vitest';
import { describeNetworkError } from '../../../../src/main/browser/networkErrorCopy';

/**
 * The message a user sees in the browser pane (browserToolbar.ts renders
 * `error.message`) must be *humanised* copy - a sentence that says what to
 * check - never the raw Chromium `ERR_*` string, and never the low-level
 * rejection message ("ERR_CONNECTION_REFUSED (-102) loading '...'" is what
 * headless Chromium gives us, with the code buried inside prose). The exact
 * code still rides on `BrowserIpcError.errorCode` for programmatic
 * branching; this module's contract is simply: friendly copy, always
 * containing the address, never leaking the code.
 */
const NEVER_SEEN = ['ERR_', '(-', 'loading ', 'setting proxy'];
const CHECK_ADDRESS = 'http://127.0.0.1:4502/';

describe('describeNetworkError', () => {
  it('turns an ERR_CONNECTION_REFUSED into a "is it running?" prompt naming the URL', () => {
    const message = describeNetworkError('ERR_CONNECTION_REFUSED', CHECK_ADDRESS);
    expect(message).toContain(CHECK_ADDRESS);
    expect(message).toMatch(/Check that the server is running, then try again$/);
  });

  it('turns an ERR_NAME_NOT_RESOLVED into a "check the address" prompt naming the URL', () => {
    const message = describeNetworkError('ERR_NAME_NOT_RESOLVED', CHECK_ADDRESS);
    expect(message).toContain(CHECK_ADDRESS);
    expect(message).toMatch(/Check the address, then try again$/);
  });

  it('handles both timeout codes the same way', () => {
    for (const code of ['ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT']) {
      const message = describeNetworkError(code, CHECK_ADDRESS);
      expect(message).toContain(CHECK_ADDRESS);
      expect(message).toMatch(
        /^Timed out while trying to reach .*Check the address, then try again$/,
      );
    }
  });

  it('handles interrupted-connection codes the same way', () => {
    for (const code of ['ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_EMPTY_RESPONSE']) {
      const message = describeNetworkError(code, CHECK_ADDRESS);
      expect(message).toContain(CHECK_ADDRESS);
      expect(message).toMatch(/Check the server, then try again$/);
    }
  });

  it('points a proxy failure at the proxy settings', () => {
    const message = describeNetworkError('ERR_PROXY_CONNECTION_FAILED', CHECK_ADDRESS);
    expect(message).toContain(CHECK_ADDRESS);
    expect(message).toMatch(/Check the proxy settings$/);
  });

  it('names the certificate problem for any ERR_CERT_* code', () => {
    for (const code of [
      'ERR_CERT_AUTHORITY_INVALID',
      'ERR_CERT_DATE_INVALID',
      'ERR_CERT_COMMON_NAME_INVALID',
    ]) {
      const message = describeNetworkError(code, 'https://author.example');
      expect(message).toContain('https://author.example');
      expect(message).toMatch(
        /^Couldn't verify the security certificate for .*expired or untrusted$/,
      );
    }
  });

  it('falls back to a generic "couldn\'t load" prompt for unknown codes', () => {
    const message = describeNetworkError('ERR_SOME_FUTURE_CODE', CHECK_ADDRESS);
    expect(message).toContain(CHECK_ADDRESS);
    expect(message).toMatch(
      /^Couldn't load .*Check that the server is running and the address is correct$/,
    );
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
});
