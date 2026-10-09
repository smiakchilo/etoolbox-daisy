import { z } from 'zod';
import {
  type AemToolExecutor,
  type JsonValue,
  type RequestId,
  type Result,
  type ToolDescriptor,
  type ToolError,
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
 * The one place the chat renders a table. The model hands it the JSON it
 * already holds - an array of rows, or an object with a `rows` array (the
 * `aem_query` result) - and the application paints it as an **assistant
 * message**: an optional total line above a Spectrum table, the identifying
 * path made clickable, every cell escaped. The model never authors markup, and
 * the transcript never uses `innerHTML` for a cell.
 *
 * Like `ask_user` it does **not** go through `createToolExecutor`: it needs no
 * AEM server (it only reformats data the model already has), and the search
 * skills call it with no AEM request of its own. It is hand-rolled, but still
 * validates its arguments and returns the same `Result<JsonValue, ToolError>`
 * shape every executor does.
 *
 * The row/column/total normalisation lives here (pure) so the executor's
 * acknowledgement and the renderer's message are computed by the same code -
 * the renderer imports {@link normalizeFormatTable} from this file.
 */

export const FORMAT_TABLE_TOOL_NAME = 'format_table';
export const FORMAT_TABLE_ALLOWLIST_ENTRY = 'custom:format_table';

/**
 * `'new'` starts a fresh table; `'append'` adds this page's rows to the current
 * one. The transcript groups consecutive `format_table` calls into one rendered
 * table per run - see `transcriptView.ts`.
 */
export const formatTableModeSchema = z.enum(['new', 'append']);

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
  })
  .strict();

export type FormatTableArgs = z.infer<typeof formatTableArgsSchema>;

export const FORMAT_TABLE_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: FORMAT_TABLE_TOOL_NAME,
  description:
    'Presents results as the chat\u2019s own table. Pass the `aem_query` result exactly as you ' +
    'received it as `data` - the whole result object, or its text with the `Rows: [...]` line - ' +
    'or an array of row objects. Do not extract, reformat, rename, or pre-render anything: the ' +
    'application finds the rows itself, builds the table, keeps the identifying path clickable, ' +
    'and escapes every cell. Set `mode: "new"` for the first page of a table and `mode: "append"` ' +
    'to add a later page to it. This tool does not read AEM itself; it only displays data you ' +
    'already have.',
  // Hand-written rather than `z.toJSONSchema(jsonValueSchema)`: `data` is
  // arbitrary JSON (a recursive schema), and a plain, readable description
  // teaches the model the shape better than a `$ref` graph would.
  parameters: {
    type: 'object',
    properties: {
      data: {
        description:
          'The `aem_query` result exactly as received (object or text), or an array of row objects.',
      },
      mode: {
        type: 'string',
        enum: ['new', 'append'],
        default: 'new',
        description:
          '"new" (default) starts a fresh table; "append" adds this page\'s rows to the current one.',
      },
    },
    required: ['data'],
    additionalProperties: false,
  },
};

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
  const estimated = /approximately (\d+) match\(es\) in total/.exec(text);
  const exact = /(\d+) match\(es\) in total/.exec(text);
  if (estimated?.[1] !== undefined) {
    pagination['total'] = { accuracy: 'estimated', value: Number(estimated[1]) };
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
 * semantic-search keys get their agreed names (`Property`, `Citation`); any
 * other key is title-cased.
 */
function headerFor(key: string): string {
  switch (key) {
    case 'jcr:path':
    case 'path':
      return 'Path';
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
 * estimated case. With `p.guessTotal` the server stops counting at the page
 * size, so an estimate reported beside `hasMore: true` is a **lower bound**, not
 * a near-total: "20+" is honest where "approximately 20" would read as a
 * finished count ("there are twenty, and that's all").
 */
function describeTotal(total: JsonValue, hasMore: JsonValue | undefined): string | undefined {
  if (typeof total === 'number') return `${String(total)} result${total === 1 ? '' : 's'}`;
  if (typeof total === 'string') return total;
  if (!isRecord(total)) return undefined;
  const accuracy = total['accuracy'];
  const value = total['value'];
  if (accuracy === 'unknown') return 'an unknown number of results';
  if (typeof value !== 'number') return undefined;
  if (accuracy === 'exact') return `${String(value)} result${value === 1 ? '' : 's'}`;
  if (accuracy === 'estimated') {
    return hasMore === true
      ? `${String(value)}+ results`
      : `approximately ${String(value)} results`;
  }
  return undefined;
}

/**
 * The total line, from `aem_query`'s `pagination.total` or a top-level `total`.
 * An estimate is never presented as a fact - and, when `pagination.hasMore` is
 * true, it is shown as an open-ended lower bound ("900+ results") rather than a
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
  readonly rows: readonly (readonly string[])[];
  readonly total: string | undefined;
  readonly mode: FormatTableMode;
}

/**
 * Turns `data` into the table the transcript paints, or `undefined` when it is
 * neither an array of rows nor an object with a `rows` array.
 *
 * Columns are the union of the rows' keys in first-seen order, with the
 * identifying path hoisted first; a key whose header would collide with an
 * earlier one is dropped so a node carrying both `jcr:path` and `path` still
 * yields one Path column.
 */
export function normalizeFormatTable(
  data: JsonValue,
  mode: FormatTableMode,
): NormalizedTable | undefined {
  const resolved = resolveTable(data);
  if (resolved === undefined) return undefined;
  const { rows, container } = resolved;

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
    rows: rows.map((row) => columnKeys.map((key) => renderCell(row[key]))),
    total: totalLine(container),
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

function invalidArgument(message: string, requestId: RequestId): Result<JsonValue, ToolError> {
  return err(createToolError('INVALID_ARGUMENT', message, requestId));
}

/**
 * Builds the executor. It validates the arguments, normalises the rows/columns/
 * total with {@link normalizeFormatTable}, and returns a small acknowledgement
 * carrying the row count - the table itself is painted by the renderer from the
 * call's own arguments, so nothing large crosses back.
 */
export function createFormatTableExecutor(host: ToolHost): AemToolExecutor {
  return (rawArgs): Promise<Result<JsonValue, ToolError>> => {
    const requestId = newRequestId(host.idGenerator);

    const parsed = formatTableArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid format_table arguments';
      return Promise.resolve(invalidArgument(message, requestId));
    }

    const normalized = normalizeFormatTable(parsed.data.data, parsed.data.mode);
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
