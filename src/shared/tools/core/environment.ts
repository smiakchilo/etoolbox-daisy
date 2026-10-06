/**
 * The "environment facts" of one AEM host: its origin plus the JCR roots the
 * application should scope content and component work to.
 *
 * These are per-host settings the user maintains in the Settings "Hosts"
 * section ("Content roots" / "Component roots"). They are free text - several
 * roots may be written on one line, separated by commas or semicolons -
 * so this module owns the one interpretation of that text every consumer
 * shares: the query tool's root fan-out, the model-facing current-page context
 * block, and the `aem_environment_facts` tool.
 *
 * Pure and dependency-free (no Electron, no Node built-ins, no browser
 * globals), so it runs unchanged in main, preload and renderer.
 */

/** Where content lives when a host configures no content roots. */
export const CONTENT_ROOT_DEFAULT = '/content';

/** Where components live when a host configures no component roots. */
export const COMPONENT_ROOT_DEFAULT = '/apps';

export interface EnvironmentFacts {
  /** The canonical origin of the host that matched the live pane URL. */
  readonly origin: string;
  /** Effective content roots, in written order, never empty (defaults to `/content`). */
  readonly contentRoots: readonly string[];
  /** Effective component roots, in written order, never empty (defaults to `/apps`). */
  readonly componentRoots: readonly string[];
}

/**
 * Cleans one root token: trims surrounding whitespace, drops anything that is
 * not a repository path (must begin with `/`), and normalizes a trailing slash
 * away so `/content/` and `/content` are the same root. Returns `undefined`
 * for a token that names no usable root.
 */
function normalizeRoot(token: string): string | undefined {
  let value = token.trim();
  if (value.length === 0) return undefined;
  if (!value.startsWith('/')) return undefined;
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

/**
 * Splits a written roots line into normalized roots. A comma anywhere in the
 * line makes commas the separator (so a semicolon may still appear inside a
 * token); otherwise semicolons separate. Chunks are trimmed, unusable chunks
 * are dropped, and duplicates are removed preserving the order written.
 */
export function parseRootText(text: string | undefined): string[] {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const separator = trimmed.includes(',') ? ',' : ';';
  const roots: string[] = [];
  for (const chunk of trimmed.split(separator)) {
    const root = normalizeRoot(chunk);
    if (root === undefined || roots.includes(root)) continue;
    roots.push(root);
  }
  return roots;
}

/** True when `candidate` is a strict descendant of `ancestor` in JCR path terms. */
function isDescendantOf(candidate: string, ancestor: string): boolean {
  if (ancestor === '/') return candidate !== '/';
  return candidate.startsWith(`${ancestor}/`);
}

/**
 * The roots a query actually needs to cover: normalized, de-duplicated, and
 * with any root nested inside another dropped (querying the ancestor already
 * reaches the descendant). Order is preserved, so a fan-out reads roots in the
 * order the user wrote them.
 */
export function effectiveRoots(roots: readonly string[]): string[] {
  const unique: string[] = [];
  for (const raw of roots) {
    const root = normalizeRoot(raw);
    if (root === undefined || unique.includes(root)) continue;
    unique.push(root);
  }
  return unique.filter(
    (candidate) => !unique.some((other) => other !== candidate && isDescendantOf(candidate, other)),
  );
}

export interface ResolvedEnvironmentRoots {
  readonly contentRoots: readonly string[];
  readonly componentRoots: readonly string[];
}

/**
 * Applies the defaults: a host that writes no content roots is scoped to
 * `/content`, and one that writes no component roots to `/apps`. The result is
 * always non-empty, so a consumer never has to special-case "no roots".
 */
export function resolveEnvironmentRoots(
  contentRootText: string | undefined,
  componentRootText: string | undefined,
): ResolvedEnvironmentRoots {
  const content = effectiveRoots(parseRootText(contentRootText));
  const component = effectiveRoots(parseRootText(componentRootText));
  return {
    contentRoots: content.length > 0 ? content : [CONTENT_ROOT_DEFAULT],
    componentRoots: component.length > 0 ? component : [COMPONENT_ROOT_DEFAULT],
  };
}
