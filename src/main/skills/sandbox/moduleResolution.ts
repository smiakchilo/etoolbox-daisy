export type ModuleResolution =
  { readonly ok: true; readonly key: string } | { readonly ok: false; readonly message: string };

/** Collapses `.`/`..`/empty segments of a posix path; `undefined` when it climbs above the root. */
export function normalizeModuleKey(posixPath: string): string | undefined {
  const kept: string[] = [];
  for (const segment of posixPath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (kept.length === 0) return undefined;
      kept.pop();
      continue;
    }
    kept.push(segment);
  }
  return kept.join('/');
}

function directoryOf(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash < 0 ? '' : key.slice(0, slash);
}

/**
 * The one module-confinement rule: a specifier is accepted only when it is
 * relative and the normalised result is a key of `known`. Everything else -
 * bare specifiers, `node:` modules, absolute or drive paths, `..` escapes,
 * unknown files - is refused with a message the script author can act on.
 */
export function resolveModuleSpecifier(
  importerKey: string,
  specifier: string,
  has: (key: string) => boolean,
): ModuleResolution {
  const shown = JSON.stringify(specifier.slice(0, 200));
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return {
      ok: false,
      message: `Cannot import ${shown}: only relative imports of files in the same skill are available (no bare specifiers, node: modules or absolute paths)`,
    };
  }
  if (specifier.includes('\\') || specifier.includes('\0') || specifier.includes(':')) {
    return {
      ok: false,
      message: `Cannot import ${shown}: the path contains a forbidden character`,
    };
  }
  const resolved = normalizeModuleKey(`${directoryOf(importerKey)}/${specifier}`);
  if (resolved === undefined) {
    return { ok: false, message: `Cannot import ${shown}: it leaves the skill folder` };
  }
  if (!has(resolved)) {
    return {
      ok: false,
      message: `Cannot import ${shown}: "${resolved}" is not a file of this skill`,
    };
  }
  return { ok: true, key: resolved };
}
