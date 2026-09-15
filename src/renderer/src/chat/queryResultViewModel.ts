import type { JsonValue } from '../../../shared';

/**
 * Turns the `data` payload of a succeeded `aem_query` tool call into
 * everything the transcript needs to render a table and a pagination status
 * line (implementation-plan.md step 08: "renders the actual result rows" and
 * "shows the pagination status").
 *
 * The input is typed `JsonValue` rather than the main process's `ToolResult`
 * on purpose. From the renderer's point of view a tool result is arbitrary
 * JSON that crossed a process boundary: the store records whatever arrived.
 * Parsing defensively here means a payload that does not match the expected
 * shape degrades to "no table" - the existing text rendering - instead of
 * throwing inside a repaint and taking the whole transcript down.
 */

/** Columns are ordered, and `jcr:path` is always first - see `orderColumns`. */
export interface QueryResultTable {
  readonly columns: readonly string[];
  /** One entry per row, aligned to `columns`; a missing property renders as `""`. */
  readonly rows: readonly (readonly string[])[];
  /** One sentence stating what was shown, out of how many, and whether more exist. */
  readonly status: string;
  /**
   * True when this page is not the whole result set, by either `hasMore` or
   * an unknown `hasMore`. Callers use it to decide whether to show the "more
   * results" affordance - they must not re-derive it from `rows.length`.
   */
  readonly mayHaveMore: boolean;
}

function isRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Renders one JCR property value as a table cell. Objects and arrays are
 * JSON-stringified rather than dropped: a multi-valued JCR property (`String[]`
 * in the repository) arrives as an array, and showing `["a","b"]` is honest
 * where showing `[object Object]` or an empty cell is not.
 */
function renderCell(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * `jcr:path` first, then every other key in first-seen order across the rows.
 *
 * First-seen order rather than alphabetical because the row objects preserve
 * the order AEM returned, which follows the requested projection; re-sorting
 * would silently discard the ordering the query asked for. `jcr:path` is
 * hoisted because it is the one column guaranteed to be present (the main
 * process forces it into every projection) and the one the user identifies a
 * result by.
 */
function orderColumns(rows: readonly Readonly<Record<string, JsonValue>>[]): readonly string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  const rest = [...seen].filter((key) => key !== 'jcr:path');
  return seen.has('jcr:path') ? ['jcr:path', ...rest] : rest;
}

/**
 * Describes the total using the accuracy the main process classified it with.
 * An estimate is never presented as a fact - the word "approximately" is the
 * whole point of carrying an accuracy indicator through four layers.
 */
function describeTotal(total: JsonValue | undefined): string | undefined {
  if (!isRecord(total)) return undefined;
  const accuracy = total['accuracy'];
  const value = total['value'];
  if (accuracy === 'unknown') return 'an unknown number of matches';
  if (typeof value !== 'number') return undefined;
  if (accuracy === 'exact') return `${String(value)} match${value === 1 ? '' : 'es'}`;
  if (accuracy === 'estimated') return `approximately ${String(value)} matches`;
  return undefined;
}

/**
 * The pagination status line. Built from `offset`/`returned` rather than from
 * the rendered row count so that a rendering bug cannot make the sentence
 * agree with a wrong table.
 */
function describeStatus(pagination: Readonly<Record<string, JsonValue>>, rowCount: number): string {
  const offset = typeof pagination['offset'] === 'number' ? pagination['offset'] : 0;
  const returned = typeof pagination['returned'] === 'number' ? pagination['returned'] : rowCount;
  const hasMore = pagination['hasMore'];
  const total = describeTotal(pagination['total']);

  const shown =
    returned === 0
      ? 'No matches on this page'
      : `Showing ${String(offset + 1)}\u2013${String(offset + returned)}`;
  const outOf = total === undefined ? '' : ` of ${total}`;
  const more =
    hasMore === true
      ? ' More results exist.'
      : hasMore === false
        ? ' This is the last page.'
        : ' Whether more results exist is unknown.';
  return `${shown}${outOf}.${more}`;
}

/**
 * Returns the table for a succeeded `aem_query` result, or `undefined` when
 * `data` is anything else - including a successful `aem_get_json` result, an
 * error payload, or a shape this build does not recognise.
 */
export function readQueryResultTable(
  toolName: string,
  data: JsonValue | undefined,
): QueryResultTable | undefined {
  if (toolName !== 'aem_query') return undefined;
  if (!isRecord(data)) return undefined;
  if (data['operation'] !== 'aem_query') return undefined;

  const rawRows = data['rows'];
  if (!Array.isArray(rawRows)) return undefined;
  const rows = rawRows.filter(isRecord);

  const pagination = isRecord(data['pagination']) ? data['pagination'] : {};
  const columns = orderColumns(rows);

  return {
    columns,
    rows: rows.map((row) => columns.map((column) => renderCell(row[column]))),
    status: describeStatus(pagination, rows.length),
    mayHaveMore: pagination['hasMore'] !== false,
  };
}
