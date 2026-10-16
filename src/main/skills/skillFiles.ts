import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { SkillFailure } from '../../shared';

/**
 * Confined path resolution for a skill's own files (plan section 4). The model
 * names a path *inside* a skill; this module either returns a real path that is
 * provably inside that skill's real folder, or a failure. Nothing here reads
 * the file.
 */

const MAX_REQUEST_LENGTH = 260;
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export interface ResolvedSkillPath {
  /** The real path of the target (symlinks and junctions followed), inside the skill's real root. */
  readonly realPath: string;
  /** The normalised `/`-separated path relative to the skill folder; `''` for the folder itself. */
  readonly relative: string;
}

export type SkillPathResolution =
  | { readonly ok: true; readonly value: ResolvedSkillPath }
  | { readonly ok: false; readonly failure: SkillFailure };

function invalid(message: string): SkillPathResolution {
  return { ok: false, failure: { code: 'INVALID_ARGUMENT', message } };
}

/**
 * Lexical validation. Returns the normalised segments, or the reason the path
 * is refused before any filesystem access.
 */
export function normaliseSkillRelativePath(
  requested: string,
): { readonly segments: readonly string[] } | { readonly reason: string } {
  if (requested.length === 0) return { reason: 'The path is empty.' };
  if (requested.length > MAX_REQUEST_LENGTH) return { reason: 'The path is too long.' };
  if (requested.includes('\0')) return { reason: 'The path contains a NUL character.' };

  const slashed = requested.replace(/\\/g, '/');
  if (slashed.startsWith('/')) {
    return { reason: 'Use a path relative to the skill folder, not an absolute or UNC path.' };
  }
  if (slashed.includes(':')) {
    return { reason: 'A path may not contain ":" (no drive letters or alternate data streams).' };
  }

  const segments: string[] = [];
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { reason: 'A path may not leave the skill folder ("..").' };
    if (segment.startsWith('.')) return { reason: 'A path segment may not start with ".".' };
    if (/[. ]$/.test(segment)) return { reason: 'A path segment may not end with "." or a space.' };
    if (DEVICE_NAME.test(segment)) return { reason: 'A path may not name a reserved device.' };
    if (/[<>"|?*]/.test(segment)) return { reason: 'A path contains a character Windows refuses.' };
    segments.push(segment);
  }
  return { segments };
}

function isInside(root: string, candidate: string): boolean {
  const fold = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const normalisedRoot = fold(root);
  const normalisedCandidate = fold(candidate);
  if (normalisedCandidate === normalisedRoot) return true;
  const prefix = normalisedRoot.endsWith(path.sep) ? normalisedRoot : normalisedRoot + path.sep;
  return normalisedCandidate.startsWith(prefix);
}

/**
 * Resolves `requested` against the skill folder `skillRoot`. A target that does
 * not exist is `NOT_FOUND`; one whose real path leaves the real skill folder
 * (a symlink or a junction pointing outside) is `ACCESS_DENIED`, with a message
 * that does not reveal where it points.
 */
export async function resolveSkillPath(
  skillRoot: string,
  requested: string,
): Promise<SkillPathResolution> {
  const normalised = normaliseSkillRelativePath(requested);
  if ('reason' in normalised) return invalid(normalised.reason);

  let realRoot: string;
  try {
    realRoot = await realpath(skillRoot);
  } catch {
    return {
      ok: false,
      failure: { code: 'NOT_FOUND', message: 'The skill folder is not available.' },
    };
  }

  const joined = path.join(realRoot, ...normalised.segments);
  let realTarget: string;
  try {
    realTarget = await realpath(joined);
  } catch {
    return {
      ok: false,
      failure: { code: 'NOT_FOUND', message: `No such file in the skill: ${requested}` },
    };
  }
  if (!isInside(realRoot, realTarget)) {
    return {
      ok: false,
      failure: { code: 'ACCESS_DENIED', message: 'That path resolves outside the skill folder.' },
    };
  }
  return { ok: true, value: { realPath: realTarget, relative: normalised.segments.join('/') } };
}
