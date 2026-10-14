import { z } from 'zod';
import { type RequestId, type ToolError, createToolError, newRequestId } from '../../contracts';
import { type Result, err, ok } from '../../result';
import { CONTENT_ROOT_DEFAULT, effectiveRoots } from './environment';
import { jcrPathSchema } from './jcrPath';
import { MAX_SEARCH_ROOTS } from './search';
import type { ToolExecutionContext, ToolHost } from './toolModule';

/**
 * What a search's `roots` may hold, and how a partial one becomes a path.
 *
 * The roots are a convenience, never a boundary: a user may search any path.
 * What a model must not do is *build* a path for a phrase the user wrote
 * ("us/en") - so a root is either a full JCR path, passed through as written,
 * or a path **fragment**, exactly as the user wrote it, which the application
 * resolves to a full path ({@link resolveSearchScope}) and, when that is
 * ambiguous or finds nothing, asks the user about. The model never guesses.
 */

const FORBIDDEN_FRAGMENT_CHARACTERS = /[\s*?[\]|\\]/;
const FRAGMENT_MAX_LENGTH = 200;
const MESSAGE_ECHO_MAX_LENGTH = 80;

/** One `roots` entry, classified. */
export type ScopeEntry =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'fragment'; readonly segments: readonly string[] }
  | { readonly kind: 'invalid'; readonly message: string };

function invalidEntry(raw: string, detail?: string): ScopeEntry {
  const echoed =
    raw.length > MESSAGE_ECHO_MAX_LENGTH ? `${raw.slice(0, MESSAGE_ECHO_MAX_LENGTH)}...` : raw;
  return {
    kind: 'invalid',
    message:
      `'${echoed}' is not a JCR path or a path fragment${detail === undefined ? '' : ` (${detail})`}. ` +
      'Pass the path or fragment exactly as the user wrote it; if they described a place in ' +
      'words, ask the user which path they mean (ask_user)',
  };
}

/**
 * A value starting with `/` is a full path, validated as a path; anything else
 * is a fragment: slash-separated segments with no whitespace or wildcards. A
 * description in words ("the US site") is neither.
 */
export function classifyScopeEntry(raw: string): ScopeEntry {
  const value = raw.trim();
  if (value.startsWith('/')) {
    const parsed = jcrPathSchema.safeParse(value);
    if (!parsed.success) return invalidEntry(raw, parsed.error.issues[0]?.message);
    return { kind: 'path', path: value };
  }
  const withoutTrailingSlash = value.replace(/\/+$/, '');
  if (withoutTrailingSlash.length === 0 || withoutTrailingSlash.length > FRAGMENT_MAX_LENGTH) {
    return invalidEntry(raw);
  }
  if (FORBIDDEN_FRAGMENT_CHARACTERS.test(withoutTrailingSlash)) return invalidEntry(raw);
  const segments = withoutTrailingSlash.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return invalidEntry(raw);
  }
  return { kind: 'fragment', segments };
}

/** One entry of a composite search's `roots`: a full path, or a fragment to resolve. */
export const searchRootSchema = z.string().superRefine((value, ctx) => {
  const entry = classifyScopeEntry(value);
  if (entry.kind === 'invalid') ctx.addIssue({ code: 'custom', message: entry.message });
});

/** A composite search's `roots`. */
export const searchRootsSchema = z.array(searchRootSchema).min(1).max(MAX_SEARCH_ROOTS);

/** `aem_query`'s `roots`: full, valid JCR paths only - a fragment is resolved before it gets here. */
export const queryRootsSchema = z.array(jcrPathSchema).min(1).max(MAX_SEARCH_ROOTS);

/** Whether the path's trailing segments are exactly `segments` (`/a/b/us/en` ends with `us/en`). */
export function pathEndsWithSegments(path: string, segments: readonly string[]): boolean {
  const own = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0 || own.length < segments.length) return false;
  const offset = own.length - segments.length;
  return segments.every((segment, index) => own[offset + index] === segment);
}

// ---------------------------------------------------------------------------
// Resolving a fragment
// ---------------------------------------------------------------------------

/** The most pages the lookup reads; also `aem_query`'s own per-call maximum. */
const LOOKUP_LIMIT = 200;

/** The most candidates offered as options; the user can always type a path instead. */
const MAX_SCOPE_OPTIONS = 20;

const OPTION_MAX_LENGTH = 200;

const lookupResultSchema = z.looseObject({
  rows: z.array(z.looseObject({ 'jcr:path': z.string().optional() })),
  pagination: z.looseObject({ hasMore: z.union([z.boolean(), z.literal('unknown')]) }),
});

const answerSchema = z.looseObject({
  selections: z.array(z.string()),
  freeform: z.string().nullable().optional(),
});

interface ResolveParams {
  readonly host: ToolHost;
  readonly context: ToolExecutionContext;
  readonly requestId: RequestId;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Pages whose path ends with the fragment, found with one `aem_query`
 * (`cq:Page` by the fragment's last segment, under the content roots) and then
 * filtered by the whole fragment. `complete` is false when the query could not
 * prove it saw every page, so a single match is not trusted as the only one.
 * Only a cancellation is an error; a failed lookup just finds nothing.
 */
async function lookupPages(
  params: ResolveParams,
  contentRoots: readonly string[],
  segments: readonly string[],
): Promise<Result<{ paths: string[]; complete: boolean }, ToolError>> {
  const roots = effectiveRoots(contentRoots).slice(0, MAX_SEARCH_ROOTS);
  const lastSegment = segments[segments.length - 1] ?? '';
  const lookup = await params.host.invokeTool(
    'aem_query',
    {
      predicates: { type: 'cq:Page', nodename: lastSegment },
      roots,
      properties: [],
      limit: LOOKUP_LIMIT,
    },
    params.context,
  );
  if (!lookup.ok) {
    return lookup.error.code === 'CANCELLED' ? lookup : ok({ paths: [], complete: false });
  }
  const parsed = lookupResultSchema.safeParse(lookup.value);
  if (!parsed.success) return ok({ paths: [], complete: false });
  const paths = parsed.data.rows
    .map((row) => row['jcr:path'])
    .filter((path): path is string => path !== undefined && pathEndsWithSegments(path, segments));
  return ok({ paths: unique(paths).sort(), complete: parsed.data.pagination.hasMore === false });
}

/**
 * Puts the question to the user: pick one of the candidates, or type a path.
 * The application asks, never the model, so a search can neither guess a branch
 * nor end silently while the model's text is hidden.
 */
async function askForPath(
  params: ResolveParams,
  label: string,
  candidates: readonly string[],
): Promise<Result<string, ToolError>> {
  const options = candidates
    .filter((path) => path.length <= OPTION_MAX_LENGTH)
    .slice(0, MAX_SCOPE_OPTIONS);
  const question =
    options.length === 0
      ? `I could not find a branch matching "${label}". Which path should I search?`
      : `Which branch does "${label}" mean?`;
  const asked = await params.host.invokeTool(
    'ask_user',
    { question, ...(options.length === 0 ? {} : { options }), freeInput: true },
    params.context,
  );
  if (!asked.ok) return asked;
  const answer = answerSchema.safeParse(asked.value);
  if (!answer.success) {
    return err(
      createToolError(
        'UNEXPECTED_RESPONSE',
        'ask_user returned an unexpected result',
        params.requestId,
      ),
    );
  }
  const typed = (answer.data.freeform ?? '').trim();
  if (typed.length > 0) {
    const entry = classifyScopeEntry(typed);
    if (entry.kind === 'path') return ok(entry.path);
    return err(
      createToolError(
        'INVALID_ARGUMENT',
        `"${typed.slice(0, MESSAGE_ECHO_MAX_LENGTH)}" is not a full JCR path (it must start with "/"); ` +
          'the search was not run. Tell the user and stop',
        params.requestId,
      ),
    );
  }
  const chosen = answer.data.selections[0];
  if (chosen !== undefined && options.includes(chosen)) return ok(chosen);
  return err(createToolError('CANCELLED', 'No branch was chosen', params.requestId));
}

/**
 * Resolves one fragment to a full path:
 *
 * 1. the host's priority paths that end with it, then its content roots that do
 *    (configuration, free) - one match is used;
 * 2. otherwise one `aem_query` for pages named like its last segment, filtered
 *    by the whole fragment - one proved match is used;
 * 3. otherwise (several, none, or not provably all) the user is asked.
 */
async function resolveFragment(
  params: ResolveParams,
  label: string,
  segments: readonly string[],
): Promise<Result<string, ToolError>> {
  const facts = params.host.environmentFacts();
  const matching = (paths: readonly string[]): string[] =>
    unique(paths.filter((path) => pathEndsWithSegments(path, segments)));

  let candidates = matching(facts?.contentPriorityPaths ?? []);
  if (candidates.length === 0) candidates = matching(facts?.contentRoots ?? []);
  let complete = true;
  if (candidates.length === 0) {
    const looked = await lookupPages(
      params,
      facts?.contentRoots ?? [CONTENT_ROOT_DEFAULT],
      segments,
    );
    if (!looked.ok) return looked;
    candidates = looked.value.paths;
    complete = looked.value.complete;
  }
  const only = candidates[0];
  if (candidates.length === 1 && complete && only !== undefined) return ok(only);
  return askForPath(params, label, candidates);
}

/**
 * Turns a search's `roots` into full paths. A full path passes through as the
 * user wrote it; a fragment is resolved (see {@link resolveFragment}). Fails
 * with `INVALID_ARGUMENT` for an entry that is neither, `CANCELLED` when the
 * user dismisses a question or the turn ends.
 */
export async function resolveSearchScope(params: {
  readonly host: ToolHost;
  readonly context: ToolExecutionContext;
  readonly requestId?: RequestId | undefined;
  readonly roots: readonly string[];
}): Promise<Result<string[], ToolError>> {
  const requestId = params.requestId ?? newRequestId(params.host.idGenerator);
  const base: ResolveParams = { host: params.host, context: params.context, requestId };
  const resolved: string[] = [];
  for (const raw of params.roots) {
    const entry = classifyScopeEntry(raw);
    if (entry.kind === 'invalid') {
      return err(createToolError('INVALID_ARGUMENT', entry.message, requestId));
    }
    if (entry.kind === 'path') {
      resolved.push(entry.path);
      continue;
    }
    const outcome = await resolveFragment(base, raw.trim(), entry.segments);
    if (!outcome.ok) return outcome;
    resolved.push(outcome.value);
  }
  return ok(resolved);
}
