import { z } from 'zod';
import {
  type JsonValue,
  type RequestId,
  type Result,
  type TableCellKind,
  type ToolDescriptor,
  type ToolError,
  type ToolExecutor,
  type ToolHost,
  createToolError,
  err,
  jsonValueSchema,
  newRequestId,
  ok,
} from '../../shared';

/**
 * The `format_table` tool, self-contained.
 *
 * The one place the chat renders a table. The model may call it with rows of its
 * own, and the search composites (`aem_query_format_ask`, `aem_semantic_search`)
 * call it through the tool-to-tool bridge with the JSON they hold - an array of
 * rows, or an object with a `rows` array (the `aem_query` result) - and the
 * application paints it as an **assistant message**: a Spectrum table over an
 * optional total line, the identifying
 * path made clickable, every cell escaped. The model never authors markup, and
 * the transcript never uses `innerHTML` for a cell.
 *
 * Like `ask_user` it does **not** go through `createToolExecutor`: it needs no
 * AEM server (it only reformats data it is handed), and the search composites
 * call it with no AEM request of its own. It is hand-rolled, but still
 * validates its arguments and returns the same `Result<JsonValue, ToolError>`
 * shape every executor does.
 *
 * The row/column/total normalisation lives here (pure) so the executor's
 * acknowledgement and the renderer's message are computed by the same code -
 * the renderer imports {@link normalizeFormatTable} from this file.
 */

export const FORMAT_TABLE_TOOL_NAME = 'format_table';

/**
 * `'new'` starts a fresh table; `'append'` adds this page's rows to the current
 * one. The transcript groups consecutive `format_table` calls into one rendered
 * table per run - see `transcriptView.ts`.
 */
export const formatTableModeSchema = z.enum(['new', 'append']);

const MAX_TABLE_COLUMNS = 20;

export const formatTableColumnsSchema = z
  .array(
    z
      .object({
        key: z.string().min(1).max(200),
        label: z.string().trim().min(1).max(60).optional(),
        type: z.enum(['text', 'status']).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(MAX_TABLE_COLUMNS)
  .refine((columns) => new Set(columns.map((column) => column.key)).size === columns.length, {
    message: 'format_table `columns` must not repeat a key',
  });

export type FormatTableMode = z.infer<typeof formatTableModeSchema>;

export const formatTableArgsSchema = z
  .object({
    /**
     * The JSON to present, verbatim: an array of row objects, or an object
     * carrying a `rows` array (typically the whole `aem_query` result). Every
     * value is treated as data - never markup.
     */
    data: jsonValueSchema,
    mode: formatTableModeSchema.default('new'),
    /**
     * Replaces the total line verbatim (e.g. "Total: 3 so far", or "Did not
     * find any relevant results so far"). Without it the line is derived from
     * the data's `pagination.total` / `total`.
     */
    totalLine: z.string().trim().min(1).max(200).optional(),
    /**
     * Whether an exact total is still being counted for this run, so the
     * transcript shows a spinner before the total line. The run's last call
     * decides it (see `transcriptView.ts`'s `planTableRuns`); a search composite
     * passes `true` on every page while its background count is in flight and
     * `false` on the settle call.
     */
    totalPending: z.boolean().optional(),
    /**
     * Which row keys to show, in order, with an optional header and a cell type.
     * Without it the columns are inferred from the rows' keys. A `status` cell
     * is drawn as a coloured status light.
     */
    columns: formatTableColumnsSchema.optional(),
    /** A caption shown above the table. */
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type FormatTableArgs = z.infer<typeof formatTableArgsSchema>;

const FORMAT_TABLE_INPUT_SCHEMA: Record<string, unknown> & { properties?: unknown } = {
  ...z.toJSONSchema(formatTableArgsSchema, { io: 'input' }),
};
// The model-facing schema is self-contained, so the generator's definitions table is dropped.
delete FORMAT_TABLE_INPUT_SCHEMA['$defs'];

export const FORMAT_TABLE_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: FORMAT_TABLE_TOOL_NAME,
  description:
    'Shows rows to the user as a table in the chat. `data` is an array of row objects. ' +
    '`columns` picks which keys to show, in order, with an optional `label` (the header) and ' +
    'a cell `type`: "text" (default) or "status", which draws a coloured status light for ' +
    'values such as pass / warn / fail. Without `columns` every key is shown. `title` is a ' +
    'caption above the table and `totalLine` replaces the line under it. ' +
    '`mode: "append"` adds rows to the table the previous call started. ' +
    'Cell values are shown as text, never as markup. Give the user the table instead of ' +
    'repeating its rows in your reply.',
  parameters: {
    ...FORMAT_TABLE_INPUT_SCHEMA,
    properties: {
      ...(FORMAT_TABLE_INPUT_SCHEMA.properties as Record<string, unknown>),
      data: { type: 'array', items: { type: 'object' } },
    },
  },
};

export const FORMAT_TABLE_ALLOWLIST_ENTRY = `custom:${FORMAT_TABLE_TOOL_NAME}`;

/** One value rendered as a table cell. Objects/arrays are JSON-stringified rather than dropped. */
function renderCell(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Row = Readonly<Record<string, JsonValue>>;

/** Keys a weaker model may nest the real payload under (the tool-result envelope, or its own). */
const WRAPPER_KEYS = ['result', 'data', 'payload', 'output', 'content'] as const;
const MAX_UNWRAP_DEPTH = 4;
const ROWS_MARKER = 'Rows: ';

/**
 * Reads the pagination facts out of `aem_query`'s rendered text, so a model that
 * pastes the text it was shown (rather than the structured result) still gets a
 * total line.
 */
function paginationFromText(text: string): JsonValue | undefined {
  const pagination: Record<string, JsonValue> = {};
  if (text.includes('more results exist beyond this page')) pagination['hasMore'] = true;
  else if (text.includes('no further results exist')) pagination['hasMore'] = false;
  // `at least N` is the current form; `approximately N` is a pre-change
  // rendered-text fallback, read as the same lower bound.
  const atLeast = /(?:at least|approximately) (\d+) match\(es\) in total/.exec(text);
  const exact = /(\d+) match\(es\) in total/.exec(text);
  if (atLeast?.[1] !== undefined) {
    pagination['total'] = { accuracy: 'atLeast', value: Number(atLeast[1]) };
  } else if (exact?.[1] !== undefined) {
    pagination['total'] = { accuracy: 'exact', value: Number(exact[1]) };
  }
  return Object.keys(pagination).length === 0 ? undefined : pagination;
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Turns a string `data` into structured data: JSON text (optionally in a code
 * fence), or `aem_query`'s rendered text, whose last line is `Rows: [...]`.
 */
function parseText(text: string): JsonValue | undefined {
  const trimmed = text
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
  const direct = parseJson(trimmed);
  if (direct !== undefined && typeof direct !== 'string') return direct;
  const markerAt = trimmed.lastIndexOf(ROWS_MARKER);
  if (markerAt < 0) return undefined;
  const rows = parseJson(trimmed.slice(markerAt + ROWS_MARKER.length).trim());
  if (!Array.isArray(rows)) return undefined;
  const pagination = paginationFromText(trimmed.slice(0, markerAt));
  return pagination === undefined ? { rows } : { rows, pagination };
}

interface ResolvedTable {
  readonly rows: readonly Row[];
  /** The object carrying the rows, where `pagination`/`total` are read from. */
  readonly container: JsonValue;
}

/**
 * Finds the rows in whatever shape the model handed over: an array of rows, an
 * object with a `rows` array (the `aem_query` result), either of those as JSON
 * text, nested under a wrapper key, or a single row object.
 */
function resolveTable(data: JsonValue, depth = 0): ResolvedTable | undefined {
  if (depth > MAX_UNWRAP_DEPTH) return undefined;
  if (typeof data === 'string') {
    const parsed = parseText(data);
    return parsed === undefined ? undefined : resolveTable(parsed, depth + 1);
  }
  if (Array.isArray(data)) return { rows: data.filter(isRecord), container: data };
  if (!isRecord(data)) return undefined;

  const rows = data['rows'];
  if (Array.isArray(rows)) return { rows: rows.filter(isRecord), container: data };
  if (typeof rows === 'string') {
    const parsed = parseText(rows);
    if (Array.isArray(parsed)) return { rows: parsed.filter(isRecord), container: data };
  }
  for (const key of WRAPPER_KEYS) {
    const inner = data[key];
    if (inner === undefined) continue;
    const resolved = resolveTable(inner, depth + 1);
    if (resolved !== undefined) return resolved;
  }
  if (typeof data['jcr:path'] === 'string' || typeof data['path'] === 'string') {
    return { rows: [data], container: data };
  }
  return undefined;
}

/**
 * The header for a source key. `jcr:path`/`path` is the identifying column; the
 * semantic-search keys get their agreed names (`Property`, `Citation`); the
 * common page/asset title property reads as `Title`; any other key is
 * title-cased.
 */
function headerFor(key: string): string {
  switch (key) {
    case 'jcr:path':
    case 'path':
      return 'Path';
    case 'jcr:title':
      return 'Title';
    case 'property':
      return 'Property';
    case 'citation':
      return 'Citation';
    case 'value':
      return 'Value';
    default:
      return key
        .replace(/[_:.-]+/g, ' ')
        .trim()
        .split(/\s+/)
        .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
        .join(' ');
  }
}

/**
 * Renders a total value (a bare number/string, or `aem_query`'s
 * `{accuracy, value}`) as text.
 *
 * `hasMore` - the sibling of the total under `pagination` - refines the
 * `atLeast` case. QueryBuilder is told to stop counting at the numeric
 * `p.guessTotal` cap, so a lower bound reported beside `hasMore: true` is shown
 * open-ended: "20+" is honest where "at least 20" would read as a finished
 * count. `"estimated"` is a pre-change journal value, read as the same lower
 * bound.
 */
function describeTotal(total: JsonValue, hasMore: JsonValue | undefined): string | undefined {
  if (typeof total === 'number') return String(total);
  if (typeof total === 'string') return total;
  if (!isRecord(total)) return undefined;
  const accuracy = total['accuracy'];
  const value = total['value'];
  if (accuracy === 'unknown') return 'an unknown number of results';
  if (typeof value !== 'number') return undefined;
  if (accuracy === 'exact') return String(value);
  if (accuracy === 'atLeast' || accuracy === 'estimated') {
    return hasMore === true ? `${String(value)}+` : `at least ${String(value)}`;
  }
  return undefined;
}

/**
 * The total line, from `aem_query`'s `pagination.total` or a top-level `total`.
 * An estimate is never presented as a fact - and, when `pagination.hasMore` is
 * true, it is shown as an open-ended lower bound ("900+") rather than a
 * count.
 */
function totalLine(data: JsonValue): string | undefined {
  if (!isRecord(data)) return undefined;
  const pagination = isRecord(data['pagination']) ? data['pagination'] : undefined;
  const raw = pagination?.['total'] ?? data['total'];
  if (raw === undefined) return undefined;
  const described = describeTotal(raw, pagination?.['hasMore']);
  return described === undefined ? undefined : `Total: ${described}`;
}

/** The normalised table: headers, string cells aligned to them, and an optional total line. */
export interface NormalizedTable {
  readonly columns: readonly string[];
  /** The cell type of each column, aligned to `columns`. */
  readonly columnKinds: readonly TableCellKind[];
  readonly title: string | undefined;
  readonly rows: readonly (readonly string[])[];
  readonly total: string | undefined;
  readonly totalPending: boolean;
  readonly mode: FormatTableMode;
}

/** The caller-chosen presentation of a table: its columns (keys, headers, cell types) and caption. */
export interface NormalizeFormatTableOptions {
  readonly columns?: readonly {
    readonly key: string;
    readonly label?: string | undefined;
    readonly type?: TableCellKind | undefined;
  }[];
  readonly title?: string | undefined;
}

/**
 * Turns `data` into the table the transcript paints, or `undefined` when it is
 * neither an array of rows nor an object with a `rows` array.
 *
 * Columns are the union of the rows' keys in first-seen order, with the
 * identifying path hoisted first; a key whose header would collide with an
 * earlier one is dropped so a node carrying both `jcr:path` and `path` still
 * yields one Path column.
 *
 * With `options.columns` the caller picks the keys, headers and cell types
 * instead; a key no row carries is still a (blank) column, so the shape is
 * what the caller asked for.
 */
export function normalizeFormatTable(
  data: JsonValue,
  mode: FormatTableMode,
  totalOverride?: string,
  totalPending = false,
  options: NormalizeFormatTableOptions = {},
): NormalizedTable | undefined {
  const resolved = resolveTable(data);
  if (resolved === undefined) return undefined;
  const { rows, container } = resolved;
  const total =
    totalOverride !== undefined && totalOverride.trim().length > 0
      ? totalOverride.trim()
      : totalLine(container);
  const title = options.title?.trim() ? options.title.trim() : undefined;

  if (options.columns !== undefined && options.columns.length > 0) {
    const chosen = options.columns;
    return {
      columns: chosen.map((column) => column.label ?? headerFor(column.key)),
      columnKinds: chosen.map((column) => column.type ?? 'text'),
      title,
      rows: rows.map((row) => chosen.map((column) => renderCell(row[column.key]))),
      total,
      totalPending,
      mode,
    };
  }

  const seen = new Set<string>();
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  const orderedKeys = seen.has('jcr:path')
    ? ['jcr:path', ...keys.filter((key) => key !== 'jcr:path')]
    : seen.has('path')
      ? ['path', ...keys.filter((key) => key !== 'path')]
      : keys;

  const columnKeys: string[] = [];
  const columns: string[] = [];
  const usedHeaders = new Set<string>();
  for (const key of orderedKeys) {
    const header = headerFor(key);
    if (usedHeaders.has(header)) continue;
    usedHeaders.add(header);
    columnKeys.push(key);
    columns.push(header);
  }

  return {
    columns,
    columnKinds: columns.map(() => 'text' as const),
    title,
    rows: rows.map((row) => columnKeys.map((key) => renderCell(row[key]))),
    total,
    totalPending,
    mode,
  };
}

export const formatTableSuccessSchema = z
  .object({
    operation: z.literal(FORMAT_TABLE_TOOL_NAME),
    requestId: z.string().min(1),
    rowCount: z.number().int().nonnegative(),
    mode: formatTableModeSchema,
    textResultForLlm: z.string(),
    resultType: z.literal('success'),
  })
  .strict();

/**
 * The presentation options of a call's arguments, with an absent member omitted
 * (not `undefined`). From the renderer, which holds raw arguments, an unusable
 * `columns` falls back to inferred columns rather than hiding the table.
 */
export function readTableOptions(source: {
  readonly columns?: unknown;
  readonly title?: unknown;
}): NormalizeFormatTableOptions {
  const columns = formatTableColumnsSchema.safeParse(source.columns);
  const title = typeof source.title === 'string' ? source.title : undefined;
  return {
    ...(columns.success ? { columns: columns.data } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

function invalidArgument(message: string, requestId: RequestId): Result<JsonValue, ToolError> {
  return err(createToolError('INVALID_ARGUMENT', message, requestId));
}

/**
 * Builds the executor. It validates the arguments, normalises the rows/columns/
 * total with {@link normalizeFormatTable}, and returns a small acknowledgement
 * carrying the row count - the table itself is painted by the renderer from the
 * call's own arguments, so nothing large crosses back.
 */
export function createFormatTableExecutor(host: ToolHost): ToolExecutor {
  return (rawArgs): Promise<Result<JsonValue, ToolError>> => {
    const requestId = newRequestId(host.idGenerator);

    const parsed = formatTableArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid format_table arguments';
      return Promise.resolve(invalidArgument(message, requestId));
    }

    const normalized = normalizeFormatTable(
      parsed.data.data,
      parsed.data.mode,
      parsed.data.totalLine,
      false,
      readTableOptions(parsed.data),
    );
    if (normalized === undefined) {
      return Promise.resolve(
        invalidArgument(
          'format_table `data` must be the aem_query result (or its `rows` array); ' +
            'pass the result exactly as received',
          requestId,
        ),
      );
    }

    const rowCount = normalized.rows.length;
    return Promise.resolve(
      ok({
        operation: FORMAT_TABLE_TOOL_NAME,
        requestId,
        rowCount,
        mode: normalized.mode,
        textResultForLlm: `Presented ${String(rowCount)} row${rowCount === 1 ? '' : 's'}.`,
        resultType: 'success',
      }),
    );
  };
}
