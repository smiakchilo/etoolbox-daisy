/**
 * The "environment facts" of one AEM host: its origin plus the JCR roots the
 * application should scope content, component and DAM work to.
 *
 * These are per-host settings the user maintains in the Settings "Projects"
 * section ("Content roots" / "Component roots" / "DAM roots"). They are free
 * text - several roots may be written on one line, separated by commas or
 * semicolons - so this module owns the one interpretation of that text every
 * consumer shares: the query tool's root fan-out, the model-facing current-page
 * context block, and the `environment_facts` tool.
 *
 * Pure and dependency-free (no Electron, no Node built-ins, no browser
 * globals), so it runs unchanged in main, preload and renderer.
 */

/** Where content lives when a host configures no content roots. */
export const CONTENT_ROOT_DEFAULT = '/content';

/** Where components live when a host configures no component roots. */
export const COMPONENT_ROOT_DEFAULT = '/apps';

/** Where DAM assets live when a host configures no DAM roots. */
export const DAM_ROOT_DEFAULT = '/content/dam';

export interface EnvironmentFacts {
  /** The canonical origin of the host that matched the live pane URL. */
  readonly origin: string;
  /** Effective content roots, in written order, never empty (defaults to `/content`). */
  readonly contentRoots: readonly string[];
  /** Effective component roots, in written order, never empty (defaults to `/apps`). */
  readonly componentRoots: readonly string[];
  /** Effective DAM roots, in written order, never empty (defaults to `/content/dam`). */
  readonly damRoots: readonly string[];
  /** Content priority paths, in written order; empty when the project names none. */
  readonly contentPriorityPaths: readonly string[];
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

/**
 * Interprets a project's "Priority paths" text: the same splitting and
 * normalization as the roots, but the written order is the priority order and
 * is kept. A path that equals, or sits inside, an *earlier* priority is
 * dropped - the earlier one already covers it. A later path that contains an
 * earlier one is kept (`/a/b/en` before `/a/b` is meaningful). There is no
 * default: empty text means no priorities.
 */
export function parsePriorityPathText(text: string | undefined): string[] {
  const priorities: string[] = [];
  for (const path of parseRootText(text)) {
    if (priorities.some((earlier) => path === earlier || isDescendantOf(path, earlier))) continue;
    priorities.push(path);
  }
  return priorities;
}

/** One slice of a priority-ordered query: a path minus the paths excluded from it. */
export interface PrioritySegment {
  readonly path: string;
  readonly exclude: readonly string[];
}

/**
 * Splits a query scope into the ordered, disjoint segments a priority-ordered
 * search reads one after another: first one segment per applicable priority
 * (in written order, each minus the earlier priorities nested inside it), then
 * the remainder of every scope root (minus the priorities inside it).
 *
 * A priority applies when it sits strictly inside some scope root; one outside
 * every scope, or equal to a scope root (which would not reorder anything), is
 * ignored. Returns `undefined` when nothing applies, meaning the ordinary,
 * unsegmented query is used.
 */
export function planPrioritySegments(
  scopeRoots: readonly string[],
  priorities: readonly string[],
): PrioritySegment[] | undefined {
  const applicable = priorities.filter((priority) =>
    scopeRoots.some((root) => isDescendantOf(priority, root)),
  );
  if (applicable.length === 0) return undefined;

  const segments: PrioritySegment[] = applicable.map((path, index) => ({
    path,
    exclude: applicable.slice(0, index).filter((earlier) => isDescendantOf(earlier, path)),
  }));
  for (const root of scopeRoots) {
    segments.push({
      path: root,
      exclude: applicable.filter((priority) => isDescendantOf(priority, root)),
    });
  }
  return segments;
}

export interface ResolvedEnvironmentRoots {
  readonly contentRoots: readonly string[];
  readonly componentRoots: readonly string[];
  readonly damRoots: readonly string[];
  readonly contentPriorityPaths: readonly string[];
}

/**
 * The free-text root families a project may write, as one bag. Named rather
 * than positional because all four are optional strings: position alone would
 * make them trivially interchangeable at a call site.
 */
export interface EnvironmentRootTexts {
  readonly contentRoots?: string | undefined;
  readonly componentRoots?: string | undefined;
  readonly damRoots?: string | undefined;
  readonly contentPriorityPaths?: string | undefined;
}

/**
 * Applies the defaults: a host that writes no content roots is scoped to
 * `/content`, one that writes no component roots to `/apps`, and one that
 * writes no DAM roots to `/content/dam`. The result is always non-empty, so a
 * consumer never has to special-case "no roots". Priority paths have no
 * default.
 */
export function resolveEnvironmentRoots(texts: EnvironmentRootTexts): ResolvedEnvironmentRoots {
  const content = effectiveRoots(parseRootText(texts.contentRoots));
  const component = effectiveRoots(parseRootText(texts.componentRoots));
  const dam = effectiveRoots(parseRootText(texts.damRoots));
  return {
    contentRoots: content.length > 0 ? content : [CONTENT_ROOT_DEFAULT],
    componentRoots: component.length > 0 ? component : [COMPONENT_ROOT_DEFAULT],
    damRoots: dam.length > 0 ? dam : [DAM_ROOT_DEFAULT],
    contentPriorityPaths: parsePriorityPathText(texts.contentPriorityPaths),
  };
}

/**
 * The roots a *search* composite (`aem_query_format_ask`,
 * `aem_semantic_search`) defaults to: the host's content roots followed by its
 * DAM roots, in written order, collapsed (a DAM root nested inside a content
 * root adds nothing, so the `/content`/`/content/dam` defaults overlap to just
 * `/content`). Only a search covers DAM this way; a plain `aem_query` keeps to
 * the roots the model passes, so DAM is not traversed on every query. Falls
 * back to the `/content` default when the host's facts are unavailable.
 */
export function resolveSearchRoots(
  facts: Pick<EnvironmentFacts, 'contentRoots' | 'damRoots'> | undefined,
): string[] {
  if (facts === undefined) return [CONTENT_ROOT_DEFAULT];
  const roots = effectiveRoots([...facts.contentRoots, ...facts.damRoots]);
  return roots.length > 0 ? roots : [CONTENT_ROOT_DEFAULT];
}

/**
 * The minimum shape of a host needed to resolve its project: a host may name a
 * project by id, or none (the "(Default)" selection). Kept structural rather
 * than importing `ServerConfig` so this module stays free of the contracts -
 * the same discipline the rest of `tools/core` follows.
 */
export interface HostProjectRef {
  readonly projectId?: string | undefined;
}

/**
 * The minimum shape of a project entry needed to resolve a host's roots. Kept
 * structural for the same reason as {@link HostProjectRef}.
 */
export interface ProjectRoots {
  readonly id: string;
  readonly contentRoots?: string | undefined;
  readonly componentRoots?: string | undefined;
  readonly contentPriorityPaths?: string | undefined;
  readonly damRoots?: string | undefined;
}

/**
 * Resolves a host's effective content/component/DAM roots from its selected
 * project. A host with no project - or one naming a project that no longer
 * exists - falls back to the `/content`/`/apps`/`/content/dam` defaults (the
 * same as a project that writes no roots), which is exactly what "(Default)"
 * means in Settings.
 */
export function resolveHostEnvironmentRoots(
  host: HostProjectRef,
  projects: readonly ProjectRoots[],
): ResolvedEnvironmentRoots {
  const project =
    host.projectId === undefined
      ? undefined
      : projects.find((candidate) => candidate.id === host.projectId);
  return resolveEnvironmentRoots({
    contentRoots: project?.contentRoots,
    componentRoots: project?.componentRoots,
    damRoots: project?.damRoots,
    contentPriorityPaths: project?.contentPriorityPaths,
  });
}
