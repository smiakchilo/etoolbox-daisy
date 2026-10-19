import { z } from 'zod';
import { toolErrorSchema } from '../../contracts';

/**
 * Result pieces shared by every bridge tool: property selection, the pagination
 * "is there more" signal, and the error arm. Tool-specific success shapes
 * (children metadata for get-json, pagination totals for query) and the
 * assembled result union live with the tool that owns them.
 */

// ---------------------------------------------------------------------------
// Selection metadata
// ---------------------------------------------------------------------------

/**
 * States which properties actually appear in a tool's data/rows, distinguishing
 * "the agent selected specific properties" from "AEM returned everything it
 * has". Without this, an agent that asked for `["jcr:title"]` and got back an
 * object containing only that key cannot tell whether the node genuinely has no
 * other properties or whether the rest were simply not requested.
 *
 * Derived from the schema (`.readonly()` on the array), not hand-written next
 * to it: a hand-written `readonly string[]` previously drifted from the
 * schema's plain `string[]` output.
 */
export const propertySelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('selected'), properties: z.array(z.string()).readonly() }).strict(),
]);

export type PropertySelection = z.infer<typeof propertySelectionSchema>;

// ---------------------------------------------------------------------------
// Pagination "is there more" signal
// ---------------------------------------------------------------------------

/**
 * Whether more results exist beyond what was returned. `"unknown"` is a
 * first-class value, not a fallback that collapses to `false`: a transport-
 * level result may be produced before that accuracy is known. Reporting `false`
 * when the true answer is "we cannot tell" would be the silent-truncation
 * failure requirements-decisions.md section 6 forbids.
 */
export const hasMoreSchema = z.union([z.literal(true), z.literal(false), z.literal('unknown')]);

export type HasMore = z.infer<typeof hasMoreSchema>;

// ---------------------------------------------------------------------------
// Shared argument helpers
// ---------------------------------------------------------------------------

const PROPERTY_NAME_MAX_LENGTH = 200;

export const propertyNameSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(PROPERTY_NAME_MAX_LENGTH, `must be at most ${String(PROPERTY_NAME_MAX_LENGTH)} characters`)
  .refine(
    (value) => ![...value].some((char) => char.codePointAt(0)! < 0x20 || char === '\u007f'),
    'must not contain control characters',
  );

export const propertiesSelectionSchema = z.array(propertyNameSchema);

// ---------------------------------------------------------------------------
// Error arm
// ---------------------------------------------------------------------------

export const toolErrorResultSchema = z
  .object({
    ok: z.literal(false),
    error: toolErrorSchema,
  })
  .strict();

export type ToolErrorResult = z.infer<typeof toolErrorResultSchema>;

// ---------------------------------------------------------------------------
// Model-facing rendering helpers (shared)
// ---------------------------------------------------------------------------

export function renderSelection(selection: PropertySelection): string {
  return selection.kind === 'all'
    ? 'all properties'
    : `selected properties only (${selection.properties.join(', ')})`;
}

export function renderHasMore(hasMore: HasMore): string {
  if (hasMore === 'unknown') {
    return 'whether more results exist beyond this page is unknown';
  }
  return hasMore
    ? 'more results exist beyond this page - request the next page at a higher offset'
    : 'no further results exist beyond this page';
}
