import type { BrokerOutcome } from './types';

/**
 * How sure a bridge read is that the host stopped recognising the user.
 *
 * - `certain`: the host said so in a way no working session produces - a 401, a
 *   redirect (the bridge never follows one, and a signed-in JSON read is not
 *   redirected), or the markers of AEM's own sign-in form.
 * - `suspected`: an HTML page arrived where JSON was asked for and it carries
 *   a sign-in hint. Every login gate - an AEM page, Adobe IMS, Okta, a corporate
 *   SSO - looks different, so this is deliberately a weak, shape-independent
 *   signal. It only warns the user; it never acts.
 */
export type AuthIncidentSeverity = 'certain' | 'suspected';

/** AEM's Granite sign-in form: the one login shape recognised exactly. */
const CERTAIN_LOGIN_MARKERS = ['j_security_check', 'j_username', 'aem sign in'] as const;

/**
 * Hints that an HTML body is some sign-in or identity-provider page. Any one is
 * enough for `suspected`; none of them is proof, which is why a match alone
 * never reloads the pane or stops the agent.
 */
const SUSPECTED_LOGIN_HINTS: readonly RegExp[] = [
  /type\s*=\s*["']?password\b/i,
  /\bsign[\s-]?in\b/i,
  /\blog[\s-]?in\b/i,
  /\bsso\b/i,
  /\b(?:saml(?:request|response)?|relaystate|okta|oauth2?|openid|adobelogin)\b/i,
];

function isHtmlMediaType(contentType: string | null): boolean {
  if (contentType === null) return false;
  return (contentType.split(';')[0] ?? '').trim().toLowerCase() === 'text/html';
}

/**
 * Judges one bridge outcome for an authentication loss. Pure and total: any
 * outcome that is not evidence of one - including an empty HTML body, which is
 * the signature of an aborted server-side read, not of a sign-in gate - is
 * `undefined`.
 */
export function classifyAuthIncident(outcome: BrokerOutcome): AuthIncidentSeverity | undefined {
  if (outcome.kind === 'blocked') {
    return outcome.reason === 'redirect_blocked' ? 'certain' : undefined;
  }
  if (outcome.kind !== 'response') return undefined;

  const { status } = outcome;
  if (status === 401) return 'certain';
  // 300 is Sling's too-many-results alternatives answer and 304 is not a
  // redirect to anywhere; every other 3xx sends the browser elsewhere.
  if (status >= 300 && status < 400)
    return status === 300 || status === 304 ? undefined : 'certain';
  if (status !== 200 || !isHtmlMediaType(outcome.contentType)) return undefined;

  const lowercased = outcome.bodyText.toLowerCase();
  if (lowercased.trim().length === 0) return undefined;
  if (CERTAIN_LOGIN_MARKERS.some((marker) => lowercased.includes(marker))) return 'certain';
  return SUSPECTED_LOGIN_HINTS.some((hint) => hint.test(outcome.bodyText))
    ? 'suspected'
    : undefined;
}

const LOGIN_URL_WORDS =
  /(?:^|[/?&=._-])(?:log[-_]?in|sign[-_]?in|sso|saml\d*|oauth2?|authorize|auth|j_security_check)(?:$|[/?&=._-])/;

/** Query parameters a gate adds to remember where the user was going. */
const LOGIN_URL_PARAMETERS = ['resource', 'redirect', 'redirect_uri', 'relaystate', 'samlrequest'];

/**
 * Whether a page URL looks like a sign-in or identity-provider page, judged by
 * its path and query alone. Used to avoid reloading a pane that is already
 * showing a login screen.
 */
export function looksLikeLoginUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const haystack = `${parsed.pathname}${parsed.search}`.toLowerCase();
  if (LOGIN_URL_WORDS.test(haystack)) return true;
  for (const name of parsed.searchParams.keys()) {
    if (LOGIN_URL_PARAMETERS.includes(name.toLowerCase())) return true;
  }
  return false;
}
