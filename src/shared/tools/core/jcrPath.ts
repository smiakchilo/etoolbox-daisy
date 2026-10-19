import { z } from 'zod';
import { err, ok, type Result } from '../../result';

/**
 * JCR/Sling path validation, shared by every tool that accepts a repository path.
 * Tool-agnostic: it validates a path and says nothing about what a tool does with it.
 */

/**
 * Bounds a path to something a JCR repository would plausibly contain. Not a
 * security boundary by itself - it exists so a pathological input cannot turn
 * later string scanning/logging into unbounded work.
 */
const JCR_PATH_MAX_LENGTH = 1000;

export const JCR_PATH_REJECTION_REASONS = [
  'empty',
  'too_long',
  'malformed_percent_encoding',
  'contains_double_percent_encoding',
  'contains_control_character',
  'protocol_relative',
  'not_absolute',
  'contains_scheme',
  'contains_query',
  'contains_fragment',
  'contains_backslash',
  'contains_traversal_segment',
  'contains_request_path_parameter',
  'contains_empty_segment',
  'contains_dot_terminated_segment',
  'contains_sling_selector',
  'contains_json_extension',
] as const;

export type JcrPathRejectionReason = (typeof JCR_PATH_REJECTION_REASONS)[number];

/**
 * Matches a trailing Sling response-format extension, with or without a
 * preceding depth selector (`.json`, `.1.json`, `.99.json`, `.-1.json`,
 * `.infinity.json`, case-insensitive). The application appends the URL's
 * extension and depth selector when it builds the actual request; a path
 * already carrying one is an attempt to choose the output format/depth the
 * agent is not trusted with. Banning only this suffix - not dots in general -
 * is deliberate: `/content/dam/my.file.pdf` is an ordinary DAM path.
 */
const JSON_EXTENSION_PATTERN = /\.json$/i;

/**
 * A bare numeric or signed-numeric dot-token (`99`, `-1`) is a Sling depth
 * selector, not part of a node name - `-1`, like `infinity`, requests
 * unbounded depth.
 */
const NUMERIC_SELECTOR_TOKEN_PATTERN = /^-?\d+$/;

/**
 * Word-form Sling selectors worth rejecting even without a following
 * extension, because the application - not the agent - chooses both the
 * selector chain and the extension when it builds the request.
 */
const SLING_SELECTOR_KEYWORDS = new Set(['infinity', 'tidy', 'harray', 'blocks']);

/**
 * A `%XX` sequence surviving a single `decodeURIComponent` pass only occurs
 * when the caller encoded the percent sign itself (`%25`), i.e. a
 * double-encoding attempt aimed at surviving this validator's one decode pass.
 */
const PERCENT_ENCODED_OCTET_PATTERN = /%[0-9a-fA-F]{2}/;

/**
 * True if the path's final segment carries a dot-token, after the first (the
 * node name itself), that looks like a Sling selector rather than part of that
 * name. Only the final segment is checked: selectors are meaningful only on
 * the terminal resource of a Sling URL.
 *
 * Deliberately over-inclusive: at validation time there is no way to tell
 * `/content/dam/report.2024` apart from `report` plus a `2024` depth selector.
 * A false rejection the user can see and retry is the correct failure mode; a
 * silently accepted unbounded-depth fetch is not recoverable.
 */
function containsSlingSelectorToken(candidate: string): boolean {
  const finalSegment = candidate.slice(candidate.lastIndexOf('/') + 1);
  const [, ...suffixTokens] = finalSegment.split('.');
  return suffixTokens.some(
    (token) =>
      NUMERIC_SELECTOR_TOKEN_PATTERN.test(token) ||
      SLING_SELECTOR_KEYWORDS.has(token.toLowerCase()),
  );
}

/**
 * Validates a candidate JCR/Sling path without rewriting it. A bad path must be
 * rejected, not sanitised: silently stripping `..` or a scheme would make the
 * eventual request address something other than what the agent (and the
 * user reading its answer) believes was asked for.
 *
 * CONTRACT FOR CALLERS: every structural check runs against the
 * percent-decoded form of `candidate`, because that is what a servlet
 * container hands to Sling. Whatever builds the real request URL must
 * reproduce exactly the same single `decodeURIComponent` pass performed here,
 * then percent-encode the result per path segment.
 */
export function parseJcrPath(candidate: string): Result<void, JcrPathRejectionReason> {
  if (candidate.length === 0) return err('empty');
  if (candidate.length > JCR_PATH_MAX_LENGTH) return err('too_long');

  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return err('malformed_percent_encoding');
  }
  if (PERCENT_ENCODED_OCTET_PATTERN.test(decoded)) {
    return err('contains_double_percent_encoding');
  }

  if ([...decoded].some((char) => char.codePointAt(0)! < 0x20 || char === '\u007f')) {
    return err('contains_control_character');
  }
  if (decoded.startsWith('//')) return err('protocol_relative');
  if (!decoded.startsWith('/')) return err('not_absolute');
  if (decoded.includes('://')) return err('contains_scheme');
  if (decoded.includes('?')) return err('contains_query');
  if (decoded.includes('#')) return err('contains_fragment');
  if (decoded.includes('\\')) return err('contains_backslash');
  if (decoded.split('/').some((segment) => segment === '..')) {
    return err('contains_traversal_segment');
  }
  // Sling parses `;key=value` after the resource path (or extension) as a
  // request path parameter, not part of a node name. The documented `;v=1.0`
  // parameter selects a different VERSION of the resource.
  if (decoded.includes(';')) {
    return err('contains_request_path_parameter');
  }
  if (decoded !== '/' && decoded.slice(1).split('/').includes('')) {
    return err('contains_empty_segment');
  }
  // A segment ending in `.` is a suffix hazard: for `/a/b./c/d` Sling resolves
  // resource `/a/b` with suffix `/c/d` and no extension, routing to the stream
  // rendering instead of the JSON servlet.
  if (decoded.split('/').some((segment) => segment.length > 0 && segment.endsWith('.'))) {
    return err('contains_dot_terminated_segment');
  }
  if (containsSlingSelectorToken(decoded)) {
    return err('contains_sling_selector');
  }
  if (JSON_EXTENSION_PATTERN.test(decoded)) {
    return err('contains_json_extension');
  }
  return ok(undefined);
}

function jcrPathRejectionMessage(reason: JcrPathRejectionReason): string {
  switch (reason) {
    case 'empty':
      return 'must not be empty';
    case 'too_long':
      return `must be at most ${String(JCR_PATH_MAX_LENGTH)} characters`;
    case 'malformed_percent_encoding':
      return "must not contain a malformed percent-encoded sequence (e.g. '%ZZ' or a truncated '%2')";
    case 'contains_double_percent_encoding':
      return (
        "must not contain a double percent-encoded sequence (e.g. '%252E' encoding a " +
        "literal '%'); the application decodes the path exactly once"
      );
    case 'contains_control_character':
      return 'must not contain control characters';
    case 'protocol_relative':
      return "must not start with '//' (that resolves as a network-path reference, not a repository path)";
    case 'not_absolute':
      return "must be an absolute repository path starting with '/'";
    case 'contains_scheme':
      return "must not contain a URL scheme ('://')";
    case 'contains_query':
      return "must not contain a query string ('?')";
    case 'contains_fragment':
      return "must not contain a fragment ('#')";
    case 'contains_backslash':
      return 'must not contain a backslash';
    case 'contains_traversal_segment':
      return "must not contain a '..' path segment";
    case 'contains_request_path_parameter':
      return (
        "must not contain ';' (Sling reads ';key=value' after a resource path as a request " +
        "path parameter - for example ';v=1.0' selects a different version of the content - " +
        'so it would change which content is returned)'
      );
    case 'contains_empty_segment':
      return "must not contain an empty path segment (a trailing '/' or a '//' run)";
    case 'contains_dot_terminated_segment':
      return (
        "must not contain a path segment ending in '.' (Sling would treat the rest of the " +
        'path as a suffix and drop the extension, routing the request to a different ' +
        'renderer than the JSON one)'
      );
    case 'contains_sling_selector':
      return (
        "must not contain a Sling selector in its final segment (a numeric or '-1' depth " +
        "selector, 'infinity', 'tidy', 'harray', or 'blocks'); the application chooses " +
        'selectors and extensions itself - if this is a genuine node name, it cannot be ' +
        'addressed through this tool'
      );
    case 'contains_json_extension':
      return (
        "must not include a '.json' extension or Sling depth selector (e.g. '.json', " +
        "'.99.json', '.-1.json', '.infinity.json'); the application appends its own " +
        'response format and depth'
      );
  }
}

export const jcrPathSchema = z.string().superRefine((value, ctx) => {
  const result = parseJcrPath(value);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: `path ${jcrPathRejectionMessage(result.error)}` });
  }
});
