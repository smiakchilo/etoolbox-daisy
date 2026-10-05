/**
 * User-facing copy for browser-pane network failures (implementation-plan.md
 * step 05's "network errors are explicit").
 *
 * `ServerSwitchController` classifies a rejected `loadURL`/`switchProxy`
 * into a structured `network_error` outcome carrying the Chromium `ERR_*`
 * code and the raw rejection message. That raw message is Chromium's own
 * closed `net::Error` vocabulary ("ERR_CONNECTION_REFUSED (-102) loading
 * 'http://localhost:4502/'") - precise for an engineer, but the user looking
 * at the browser pane needs only a laconic statement of what failed, naming
 * the address they asked for.
 *
 * This module turns the code plus that address into that copy. Guidance is
 * deliberately not appended: the error row already carries a "Reload" that
 * retries the failed navigation, so "check ... then try again" only repeats
 * the button. The two exceptions are the proxy hint - there is no control on
 * the row that fixes a proxy - and the certificate reason. No message ends
 * with a full stop. The `ERR_*` code still travels on the `BrowserIpcError`
 * (`errorCode`) so the renderer or a log can branch on the precise cause;
 * only the message is humanised here.
 */
export function describeNetworkError(errorCode: string, url: string): string {
  switch (errorCode) {
    case 'ERR_CONNECTION_REFUSED':
      return `Can't connect to ${url}`;
    case 'ERR_NAME_NOT_RESOLVED':
      return `No server found at ${url}`;
    case 'ERR_CONNECTION_TIMED_OUT':
    case 'ERR_TIMED_OUT':
      return `Timed out reaching ${url}`;
    case 'ERR_CONNECTION_RESET':
    case 'ERR_CONNECTION_CLOSED':
    case 'ERR_EMPTY_RESPONSE':
      return `Connection to ${url} was interrupted`;
    case 'ERR_PROXY_CONNECTION_FAILED':
      return `Couldn't connect to ${url} through the proxy. Check the proxy settings`;
    default:
      // Certificate failures are usually handled by the certificate-exception
      // flow (certificatePrompt.ts), but a rejected load can still surface as
      // a plain network_error - say the exact problem in that case rather than
      // falling through to the generic "couldn't load".
      if (errorCode.startsWith('ERR_CERT_')) {
        return `Couldn't verify the certificate for ${url}. It may be expired or untrusted`;
      }
      return `Couldn't load ${url}`;
  }
}
