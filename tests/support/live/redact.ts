/**
 * Redaction for everything a live run writes to disk or prints. The journal and
 * the tool results are the app's own records, but they can still carry a
 * bearer token, a cookie or a password (an AEM page's JSON, an error echoing a
 * request), and the evidence folders get shared - so nothing is written raw.
 */

export const REDACTED = '[REDACTED]';

const SENSITIVE_WORDS =
  'token|password|passwd|secret|secretRef|api[-_]?key|credentials?|authorization|cookie';

// A key is sensitive when it ENDS in one of the words: `accessToken`, `x-api-key`,
// `Set-Cookie` - but not `inputTokens`, a count that merely contains "token".
const SENSITIVE_KEY = new RegExp(`(?:${SENSITIVE_WORDS})$`, 'i');
const KEY = String.raw`[\w.-]*(?:${SENSITIVE_WORDS})`;

const COOKIE_HEADER = /\b((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi;
const AUTHORIZATION =
  /\b(authorization\\*["']?\s*[:=]\s*\\*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;\\]+/gi;
const BEARER = /\b(bearer\s+)[\w.~+/=-]{8,}/gi;
const QUOTED_VALUE = new RegExp(
  String.raw`(\b${KEY}["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\\])*\2`,
  'gi',
);
const ESCAPED_QUOTED_VALUE = new RegExp(
  String.raw`(\b${KEY}\\+"\s*[:=]\s*\\+")[^"\\]*(\\+")`,
  'gi',
);
const BARE_VALUE = new RegExp(String.raw`(\b${KEY}["']?\s*[:=]\s*)(?!["'\\])[^\s,;&}"']+`, 'gi');
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
const TOKEN_SHAPES =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})/g;

/** Redacts secrets in free text (a JSONL line, a markdown transcript, an error message). */
export function redactText(text: string): string {
  return text
    .replace(COOKIE_HEADER, `$1${REDACTED}`)
    .replace(AUTHORIZATION, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(
      QUOTED_VALUE,
      (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
    )
    .replace(ESCAPED_QUOTED_VALUE, `$1${REDACTED}$2`)
    .replace(BARE_VALUE, `$1${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(TOKEN_SHAPES, REDACTED);
}

/**
 * Redacts a JSONL document line by line, structurally, so every line stays valid
 * JSON (a text pattern such as a cookie header runs to the end of its line and
 * would eat a record's closing braces). A line that is not JSON is redacted as text.
 */
export function redactJsonl(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line;
      try {
        return JSON.stringify(redactValue(JSON.parse(line)));
      } catch {
        return redactText(line);
      }
    })
    .join('\n');
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Redacts a JSON-like value: sensitive keys lose their value, every string goes through {@link redactText}. */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = isSensitiveKey(key) && entry !== null ? REDACTED : redactValue(entry);
    }
    return redacted;
  }
  return value;
}
