/**
 * Host (origin) HTTP authentication, answered from the saved-sign-in vault.
 *
 * `src/main/webview/proxyAuth.ts` answers a *proxy* challenge and deliberately
 * declines everything else. This is the sibling for the other half: an
 * `isProxy: false` challenge is the origin itself asking for credentials -
 * an AEM instance configured for Basic auth, or a reverse proxy in front of
 * one. The app used to leave those unanswered, which cancels Chromium's
 * authentication and returns the 401 to the page (see the note in
 * `proxyAuth.ts`): a host that used Basic auth simply could not be opened.
 *
 * The credential comes from the same vault the pane's login forms fill, keyed
 * by the challenge's **origin**, so a saved sign-in works whether the host asks
 * through a form or through a `WWW-Authenticate` header. It is only ever
 * supplied for the origin the challenge names; a stored credential for another
 * origin is never reused here.
 *
 * The two listeners coexist because each declines the other's challenges, and
 * because neither touches `preventDefault`/`callback` unless it actually
 * supplies - `login`'s callback is one-time and calling it twice throws.
 */
export interface HostAuthChallenge {
  readonly isProxy: boolean;
  readonly host: string;
  readonly port: number;
  /**
   * The HTTP authentication scheme (`basic`, `digest`, `ntlm`, `negotiate`) -
   * *not* the URL scheme. Only schemes that actually take a password are
   * answered; a `negotiate` challenge is Kerberos' own exchange and handing it
   * a stored password would be wrong (and, on a host that only offers
   * Negotiate, an invitation to loop).
   */
  readonly scheme: string;
}

const PASSWORD_SCHEMES: ReadonlySet<string> = new Set(['basic', 'digest', 'ntlm']);

/** The credential for an origin, or `undefined` when none is saved. */
export type HostCredentialLookup = (
  origin: string,
) => { readonly username: string; readonly password: string } | undefined;

const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 };

/**
 * The canonical origin a host authentication challenge belongs to, or
 * `undefined` when this challenge is not an origin's own.
 *
 * `requestUrl` is the URL that produced the challenge
 * (`authenticationResponseDetails.url`), which is what tells us the *scheme* -
 * `authInfo.scheme` is the HTTP authentication scheme (`basic`, `digest`, ...),
 * not `http`/`https`. Without a URL there is nothing honest to match on, so the
 * challenge is declined rather than guessed at over both schemes: answering an
 * `https` challenge with the `http` origin's stored password would hand a
 * credential to a different origin than the one the user saved it for.
 */
export function hostAuthOrigin(
  requestUrl: string | undefined,
  challenge: HostAuthChallenge,
): string | undefined {
  if (challenge.isProxy) return undefined;
  if (!PASSWORD_SCHEMES.has(challenge.scheme.toLowerCase())) return undefined;
  if (requestUrl === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (parsed.hostname.toLowerCase() !== challenge.host.toLowerCase()) return undefined;
  // `parsed.port` is empty for a default port; `authInfo.port` carries the real
  // number, so compare effective ports rather than their spellings.
  const effectivePort = parsed.port === '' ? DEFAULT_PORTS[parsed.protocol] : Number(parsed.port);
  if (challenge.port > 0 && effectivePort !== challenge.port) return undefined;
  return parsed.origin;
}

export interface HostLoginEventLike {
  preventDefault(): void;
}

export type HostLoginListener = (
  event: HostLoginEventLike,
  webContents: unknown,
  authenticationResponseDetails: { readonly url?: string } | undefined,
  authInfo: HostAuthChallenge,
  callback: (username?: string, password?: string) => void,
) => void;

/**
 * Builds the `app.on('login', ...)` listener. Mirrors `createProxyLoginListener`
 * exactly: it *supplies* or it does nothing at all, so a lone listener and a
 * pair of listeners behave identically.
 */
export function createHostLoginListener(deps: {
  readonly lookup: HostCredentialLookup;
}): HostLoginListener {
  return (event, _webContents, details, authInfo, callback) => {
    const origin = hostAuthOrigin(details?.url, authInfo);
    if (origin === undefined) return;
    const credential = deps.lookup(origin);
    if (credential === undefined) return;
    event.preventDefault();
    callback(credential.username, credential.password);
  };
}
