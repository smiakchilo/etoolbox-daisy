import { z } from 'zod';
import { requestIdSchema } from './ids';
import { toolErrorSchema } from './errors';
import { originSchema } from './origin';
import { jcrPathSchema } from './toolContracts';
import { err, ok, type Result } from '../result';

/**
 * The tool result union (implementation-plan.md step 03,
 * requirements-decisions.md section 6).
 *
 * The plan's hard rule is "never return `[]` in place of an error": an empty
 * array means the query ran and matched nothing, a failure means the
 * application does not know what matched. Those are opposite claims about the
 * world, and an agent that cannot tell them apart will confidently tell a
 * user "there are no results" when the true state is "AEM could not be
 * reached". The two arms below are therefore structurally different object
 * shapes - success has `rows`/`data`, error has `error` and nothing else -
 * rather than one shape where an empty/absent array plays double duty.
 */

// ---------------------------------------------------------------------------
// Selection metadata
// ---------------------------------------------------------------------------

/**
 * States which properties actually appear in `data`/`rows`, distinguishing
 * "the agent selected specific properties" from "AEM returned everything it
 * has". Without this, an agent that asked for `["jcr:title"]` and got back an
 * object containing only that key cannot tell whether the node genuinely has
 * no other properties or whether the rest were simply not requested.
 *
 * The type is derived from the schema (`.readonly()` on the array), not
 * hand-written next to it: a hand-written `readonly string[]` here
 * previously drifted from the schema's plain `string[]` output, so a value
 * built from the exported type could not be assigned to the field it
 * documents without a cast. Deriving makes that drift impossible to
 * reintroduce.
 */
const propertySelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('selected'), properties: z.array(z.string()).readonly() }).strict(),
]);

export type PropertySelection = z.infer<typeof propertySelectionSchema>;

// ---------------------------------------------------------------------------
// Pagination metadata
// ---------------------------------------------------------------------------

/**
 * Whether more results exist beyond the returned page. `"unknown"` is a first
 * -class value, not a fallback that collapses to `false`: AEM's own
 * QueryBuilder response can itself be an estimate (`p.guessTotal`), and a
 * transport-level result may be produced before that accuracy is known.
 * Reporting `false` when the true answer is "we cannot tell" would be exactly
 * the silent-truncation failure section 6 forbids, just relocated into this
 * field instead of into `rows`.
 *
 * Derived from the schema rather than hand-written alongside it, matching
 * {@link PropertySelection} - there is no scalar-union shape here that isn't
 * already expressed by `hasMoreSchema`.
 */
const hasMoreSchema = z.union([z.literal(true), z.literal(false), z.literal('unknown')]);

export type HasMore = z.infer<typeof hasMoreSchema>;

/**
 * The total number of matches, together with how much that number can be
 * trusted (implementation-plan.md step 08: "Preserve offset/limit/more/total
 * and an accuracy indicator in the response").
 *
 * Modelled as a discriminated union rather than a `total: number` beside a
 * separate `totalIsEstimate: boolean`, because those two fields can disagree
 * - a count with no accuracy, or an accuracy with no count - and every such
 * combination is a claim the application cannot actually make. Here the
 * accuracy *is* the discriminant, so `"unknown"` carries no number at all
 * and neither of the counted arms can omit one.
 *
 * `"estimated"` is the normal case, not a degraded one: the application
 * always sends `p.guessTotal=true`, so QueryBuilder is explicitly permitted
 * to stop counting early and report an approximation. Presenting that as an
 * exact figure would be the same silent-truncation lie as returning `[]` for
 * an error, relocated into a number.
 */
const totalMatchesSchema = z.discriminatedUnion('accuracy', [
  z.object({ accuracy: z.literal('exact'), value: z.number().int().nonnegative() }).strict(),
  z.object({ accuracy: z.literal('estimated'), value: z.number().int().nonnegative() }).strict(),
  z.object({ accuracy: z.literal('unknown') }).strict(),
]);

export type TotalMatches = z.infer<typeof totalMatchesSchema>;

const paginationMetadataSchema = z
  .object({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(200),
    returned: z.number().int().nonnegative(),
    hasMore: hasMoreSchema,
    total: totalMatchesSchema,
  })
  .strict();

export type PaginationMetadata = z.infer<typeof paginationMetadataSchema>;

/**
 * `aem_get_json` has no offset/limit of its own (implementation-plan.md gives
 * it none), yet a node's immediate children are exactly the kind of
 * "uncontrolled recursive node output" section 6 forbids if the count is
 * large and the list is silently cut down somewhere in the transport for
 * size/model-limit reasons. `requested: false` needs no count - the agent
 * did not ask - but `requested: true` must carry `returned`/`hasMore` for the
 * same reason `PaginationMetadata` does: a bare `includesChildren: true`
 * cannot distinguish "this node has exactly N children" from "we returned
 * the first N and there are more", which is precisely the ambiguity this
 * type exists to remove.
 */
const childrenMetadataSchema = z.discriminatedUnion('requested', [
  z.object({ requested: z.literal(false) }).strict(),
  z
    .object({
      requested: z.literal(true),
      returned: z.number().int().nonnegative(),
      hasMore: hasMoreSchema,
    })
    .strict(),
]);

export type ChildrenMetadata = z.infer<typeof childrenMetadataSchema>;

// ---------------------------------------------------------------------------
// Success arms
// ---------------------------------------------------------------------------

const aemGetJsonSuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('aem_get_json'),
    requestId: requestIdSchema,
    sourceOrigin: originSchema,
    serverRevision: z.number().int().nonnegative(),
    path: jcrPathSchema,
    fetchedAt: z.number().int().nonnegative(),
    data: z.unknown(),
    selection: propertySelectionSchema,
    children: childrenMetadataSchema,
  })
  .strict();

const aemQuerySuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('aem_query'),
    requestId: requestIdSchema,
    sourceOrigin: originSchema,
    serverRevision: z.number().int().nonnegative(),
    predicates: z.record(z.string(), z.string()),
    fetchedAt: z.number().int().nonnegative(),
    rows: z.array(z.unknown()),
    selection: propertySelectionSchema,
    pagination: paginationMetadataSchema,
  })
  .strict();

const toolSuccessSchema = z.discriminatedUnion('operation', [
  aemGetJsonSuccessSchema,
  aemQuerySuccessSchema,
]);

export type AemGetJsonSuccess = z.infer<typeof aemGetJsonSuccessSchema>;
export type AemQuerySuccess = z.infer<typeof aemQuerySuccessSchema>;
export type ToolSuccess = AemGetJsonSuccess | AemQuerySuccess;

// ---------------------------------------------------------------------------
// Error arm
// ---------------------------------------------------------------------------

const toolErrorResultSchema = z
  .object({
    ok: z.literal(false),
    error: toolErrorSchema,
  })
  .strict();

export type ToolErrorResult = z.infer<typeof toolErrorResultSchema>;

// ---------------------------------------------------------------------------
// Union, schema, round trip
// ---------------------------------------------------------------------------

/**
 * Discriminated on `ok` first, then on `operation` within the success arm.
 * Both are boolean/string *literals* per branch, so an object cannot satisfy
 * more than one arm at once: `ok: false` together with a `rows` key is
 * rejected outright by the error arm's `.strict()`, not silently accepted as
 * "a success with zero rows and some extra noise".
 */
export const toolResultSchema = z.discriminatedUnion('ok', [
  toolSuccessSchema,
  toolErrorResultSchema,
]);

export type ToolResult = ToolSuccess | ToolErrorResult;

export function serializeToolResult(result: ToolResult): string {
  return JSON.stringify(result);
}

/**
 * `parseToolResult` returns just a value (a validated {@link ToolResult}) or
 * just an error (a message) - exactly the shape the shared `Result` helper
 * exists for, so it is reused here rather than a second parse-outcome type.
 * `ToolResult` itself stays a bespoke union: it is the domain payload that
 * crosses the IPC boundary, carrying far more than one value/error pair
 * (origin, revision, pagination, `fetchedAt`), which is why it still
 * discriminates on `ok` but is not itself a `Result`.
 */
export function parseToolResult(serialized: string): Result<ToolResult, string> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized);
  } catch {
    return err('malformed JSON');
  }
  const parsed = toolResultSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(parsed.error.issues[0]?.message ?? 'does not match the tool result schema');
  }
  return ok(parsed.data);
}

// ---------------------------------------------------------------------------
// Model-facing rendering
// ---------------------------------------------------------------------------

function renderSelection(selection: PropertySelection): string {
  return selection.kind === 'all'
    ? 'all properties'
    : `selected properties only (${selection.properties.join(', ')})`;
}

function renderHasMore(hasMore: HasMore): string {
  if (hasMore === 'unknown') {
    return 'whether more results exist beyond this page is unknown';
  }
  return hasMore
    ? 'more results exist beyond this page - request the next page at a higher offset'
    : 'no further results exist beyond this page';
}

/**
 * Renders the total alongside its accuracy in the same breath, never the bare
 * number. A model told "42 matches" after being handed 50 rows will report
 * that as a complete count; told "approximately 42", it has what it needs to
 * qualify the answer instead.
 */
function renderTotal(total: TotalMatches): string {
  switch (total.accuracy) {
    case 'exact':
      return `${String(total.value)} match(es) in total`;
    case 'estimated':
      return `approximately ${String(total.value)} match(es) in total (estimated, not an exact count)`;
    case 'unknown':
      return 'the total number of matches is unknown';
  }
}

/**
 * Renders a {@link ToolResult} into the text the SDK actually hands the
 * model. The "more data exists" signal - from {@link PaginationMetadata} in
 * the query branch and from {@link ChildrenMetadata} in the get-json branch -
 * is always included in prose rather than only in a field the model might
 * not read - losing it here would recreate the silent-truncation problem one
 * layer up, in the boundary that matters most because it is what the model
 * actually sees.
 */
export function renderToolResultForModel(result: ToolResult): string {
  if (!result.ok) {
    const { error } = result;
    return (
      `AEM tool error [${error.code}]: ${error.message} ` +
      `(requestId=${error.requestId}, retryable=${String(error.retryable)}, ` +
      `requiredAction=${error.requiredAction})`
    );
  }

  if (result.operation === 'aem_get_json') {
    const childrenLine = result.children.requested
      ? `Children: ${String(result.children.returned)} returned; ` +
        `${renderHasMore(result.children.hasMore)}.`
      : 'Children: not requested.';
    return [
      `AEM node ${result.path} (origin ${result.sourceOrigin}, revision ` +
        `${String(result.serverRevision)}, fetched at ${String(result.fetchedAt)}).`,
      `Selection: ${renderSelection(result.selection)}.`,
      childrenLine,
      `Data: ${JSON.stringify(result.data)}`,
    ].join('\n');
  }

  const { pagination } = result;
  return [
    `AEM query against ${result.sourceOrigin} (revision ${String(result.serverRevision)}, ` +
      `fetched at ${String(result.fetchedAt)}).`,
    `Returned ${String(pagination.returned)} row(s) at offset ${String(pagination.offset)} ` +
      `with limit ${String(pagination.limit)}; ${renderHasMore(pagination.hasMore)}; ` +
      `${renderTotal(pagination.total)}.`,
    `Selection: ${renderSelection(result.selection)}.`,
    `Rows: ${JSON.stringify(result.rows)}`,
  ].join('\n');
}
