/**
 * The page-path rewrite rule a project may attach to its author and publish
 * hosts, used when the browser pane carries the open page to another host
 * (see `resolveContextualHostUrl` in `navigation.ts`).
 *
 * A rule is one line written as `find -> replace`, where `find` is the *body*
 * of a JavaScript regular expression (no `/.../` delimiters, no flags) and
 * `replace` is a JavaScript replacement string (`$1`/`$2` reference `find`'s
 * capture groups; empty strips). It is applied to the carried pathname with
 * `pathname.replace(new RegExp(find), replace)`; when `find` does not match,
 * the pathname is carried unchanged. This is the same pair-of-shapes the user
 * described as "two RegExps delimited by `->`", framed precisely: the first
 * half is *one* regular expression that is simultaneously the condition (does
 * it match?) and the source of the capture groups, the second half is the
 * replacement string.
 *
 * Pure and dependency-free (no Electron, no Node built-ins, no browser
 * globals), so it runs unchanged in main, preload and renderer.
 */

import { type Result, err, ok } from '../../result';

/** Why a written rule was rejected. Shown inline by the Settings "Projects" tab. */
export type PathTransformRejection =
  'missing_arrow' | 'empty_find' | 'invalid_regex' | 'invalid_replacement';

/** A parsed rule: a regex body and its replacement string, both as written. */
export interface PathTransform {
  /** The regular-expression body (`find`), compiled with no flags at apply time. */
  readonly find: string;
  /** The replacement string (`replace`); `$n` references `find`'s groups, empty strips. */
  readonly replace: string;
}

const ARROW = '->';

/**
 * Parses a non-empty rule into its two halves, validating that it is actually
 * usable. The caller treats empty/whitespace text as "no rule" and never calls
 * this with it.
 *
 * The split is on the **first** `->` and both halves are trimmed, so the spaces
 * a reader naturally puts around the arrow are tolerated. `find` must be
 * non-empty and compile as `new RegExp(find)` (no flags); `replace` must be a
 * well-formed replacement string - `$$` for a literal dollar, or `$n` naming a
 * capture group `find` actually has, with no bare `$`.
 */
export function parsePathTransform(text: string): Result<PathTransform, PathTransformRejection> {
  const source = text.trim();
  if (source.length === 0) return err('missing_arrow');

  const arrow = source.indexOf(ARROW);
  if (arrow === -1) return err('missing_arrow');

  const find = source.slice(0, arrow).trim();
  const replace = source.slice(arrow + ARROW.length).trim();

  if (find.length === 0) return err('empty_find');

  try {
    // Compiles just to prove `find` is a valid pattern body. `no-control-regex`
    // has nothing to do here (there is no literal), and the regex is
    // application-owned, not user-supplied for execution against anything but a
    // pathname, so no flag or timeout guard is warranted beyond this compile.
    new RegExp(find);
  } catch {
    return err('invalid_regex');
  }

  if (!isValidReplacement(replace, countCaptureGroups(find))) {
    return err('invalid_replacement');
  }

  return ok({ find, replace });
}

/**
 * Counts the capturing groups of a pattern body well enough to validate `$n`
 * references. A `(` that is not backslash-escaped and not immediately followed
 * by `?` (so not `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` or a named `(?<name>`)
 * is one capturing group. A `(` inside a character class would be miscounted,
 * but that is out of scope for a page-path rule.
 */
function countCaptureGroups(source: string): number {
  let count = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '(') continue;
    if (index > 0 && source[index - 1] === '\\') continue;
    if (source[index + 1] === '?') continue;
    count += 1;
  }
  return count;
}

/**
 * True when `replacement` is a well-formed JavaScript replacement string for a
 * pattern with `groupCount` capturing groups: every `$` is either `$$` (a
 * literal dollar) or `$n` naming a group that exists (`1..groupCount`). A bare
 * `$`, a `$0`, or a `$n` beyond the pattern's groups is rejected rather than
 * silently producing the wrong pathname at apply time.
 */
function isValidReplacement(replacement: string, groupCount: number): boolean {
  for (let index = 0; index < replacement.length; index += 1) {
    if (replacement[index] !== '$') continue;
    const next = replacement[index + 1];
    if (next === '$') {
      index += 1;
      continue;
    }
    if (next === undefined || !isDigit(next)) return false;
    let digits = '';
    let cursor = index + 1;
    while (cursor < replacement.length) {
      const char = replacement[cursor];
      if (char === undefined || !isDigit(char)) break;
      digits += char;
      cursor += 1;
    }
    const number = Number(digits);
    if (number === 0 || number > groupCount) return false;
    index = cursor - 1;
  }
  return true;
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

/** Applies a parsed rule to a pathname; an unmatched `find` leaves it unchanged. */
export function applyPathTransform(transform: PathTransform, pathname: string): string {
  return pathname.replace(new RegExp(transform.find), transform.replace);
}

/** The two rule fields a project may carry, as a structural bag. */
export interface ProjectPathTransforms {
  readonly authorTransform?: string | undefined;
  readonly publishTransform?: string | undefined;
}

/**
 * The rule to apply when the pane switches to a host of `hostType`, resolved
 * from that host's project: the `authorTransform` for an author, the
 * `publishTransform` for a publish, and none when the host has no role or its
 * project writes no rule for that role. An unparseable rule degrades to
 * `undefined` (the page is carried unchanged), matching the carry feature's
 * "only ever an enhancement" posture.
 */
export function resolvePathTransform(
  hostType: 'author' | 'publish' | undefined,
  transforms: ProjectPathTransforms | undefined,
): PathTransform | undefined {
  if (transforms === undefined) return undefined;
  const text =
    hostType === 'author'
      ? transforms.authorTransform
      : hostType === 'publish'
        ? transforms.publishTransform
        : undefined;
  if (text === undefined || text.trim().length === 0) return undefined;
  const parsed = parsePathTransform(text);
  return parsed.ok ? parsed.value : undefined;
}
