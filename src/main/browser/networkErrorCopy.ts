/**
 * User-facing copy for browser-pane network failures (implementation-plan.md
 * step 05's "network errors are explicit").
 *
 * `ServerSwitchController` classifies a rejected `loadURL`/`switchProxy`
 * into a structured `network_error` outcome carrying the Chromium `ERR_*`
 * code and the raw rejection message. That raw message is Chromium's own
 * closed `net::Error` vocabulary ("ERR_CONNECTION_REFUSED (-102) loading
 * 'http://localhost:4502/'") - precise for an engineer, but what the user
 * looking at the browser pane actually needs to hear is *what to check*:
 * "is the server running?", "is the address right?", "is the proxy OK?".
 *
 * This module turns the code plus the address the user actually asked for
 * into that copy. The `ERR_*` code still travels on the `BrowserIpcError`
 * (`errorCode`) so the renderer or a log can branch on the precise cause;
 * only the message is humanised here.
 */
export function describeNetworkError(errorCode: string, url: string): string {
  switch (errorCode) {
    case 'ERR_CONNECTION_REFUSED':
      return `Can't connect to ${url}. Check that the server is running, then try again`;
    case 'ERR_NAME_NOT_RESOLVED':
      return `Couldn't find a server at ${url}. Check the address, then try again`;
    case 'ERR_CONNECTION_TIMED_OUT':
    case 'ERR_TIMED_OUT':
      return `Timed out while trying to reach ${url}. Check the address, then try again`;
    case 'ERR_CONNECTION_RESET':
    case 'ERR_CONNECTION_CLOSED':
    case 'ERR_EMPTY_RESPONSE':
      return `The connection to ${url} was interrupted. Check the server, then try again`;
    case 'ERR_PROXY_CONNECTION_FAILED':
      return `Couldn't connect through the proxy while trying to reach ${url}. Check the proxy settings`;
    default:
      // Certificate failures are usually handled by the certificate-exception
      // flow (certificatePrompt.ts), but a rejected load can still surface as
      // a plain network_error - say the exact problem in that case rather than
      // falling through to the generic "couldn't load".
      if (errorCode.startsWith('ERR_CERT_')) {
        return `Couldn't verify the security certificate for ${url}. The certificate may be expired or untrusted`;
      }
      return `Couldn't load ${url}. Check that the server is running and the address is correct`;
  }
}
