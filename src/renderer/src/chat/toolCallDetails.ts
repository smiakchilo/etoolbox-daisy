import type { JsonValue } from '../../../shared';

/**
 * The standard "what was actually called" view of a tool call: a short
 * one-line summary for the collapsed billet plus the label/value rows revealed
 * when the billet is expanded (`transcriptView.ts`).
 *
 * This is the renderer's single, tool-agnostic hook for exposing a call's
 * parameters. Every tool gets *some* representation: a tool with no case in
 * `describeToolCall` still renders its entire argument object
 * (`describeGenericArgs`), so a future tool can never be silently invisible in
 * the transcript.
 *
 * That fallback is a safety net, **not** a finished design. Adding a tool
 * requires a deliberate case here (AGENTS.md §5): the command and/or
 * parameters a reader actually needs, chosen with the user rather than
 * guessed. An agent that adds a tool must ask what to expose.
 *
 * Only display strings are produced here - never DOM, never HTML. The view
 * sets every value through `textContent` for the same reason
 * `queryResultViewModel.ts` does: these are model-authored strings crossing a
 * process boundary, and one of them may be an AEM path an author influenced.
 */
export interface ToolCallParameter {
  readonly label: string;
  readonly value: string;
}

export interface ToolCallDetails {
  /**
   * A short summary of the request shown beside the tool name while the billet
   * is collapsed (a path, a query string). `undefined` when the call is
   * already fully described by its name alone.
   */
  readonly summary: string | undefined;
  /** The rows revealed on expansion. Never empty. */
  readonly parameters: readonly ToolCallParameter[];
}

/** A predicate map read defensively out of a `JsonValue` argument. */
function asPredicates(value: JsonValue | undefined): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries: [string, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined;
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

function asStringArray(value: JsonValue | undefined): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The QueryBuilder query as the user reads it: `key=value` pairs joined by
 * `&`, in the order the model supplied them. Values are shown decoded rather
 * than percent-encoded - this is the human-facing "what was asked", not the
 * wire request, and `buildQueryUrl` in `src/shared/tools/aemQuery.ts` remains
 * the one authority on the exact encoded URL the app actually sends.
 */
function formatQuery(predicates: Readonly<Record<string, string>>): string {
  return Object.entries(predicates)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/** One argument value as display text; objects and arrays are JSON-stringified rather than dropped. */
function renderArgValue(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // `JsonValue` excludes the values (`undefined`, functions, symbols) for
  // which `JSON.stringify` returns `undefined` or nothing, so the stringified
  // form is always a string here.
  return JSON.stringify(value);
}

function describeGetJson(args: Readonly<Record<string, JsonValue>>): ToolCallDetails {
  const path = typeof args['path'] === 'string' ? args['path'] : undefined;
  const includeChildren = args['includeChildren'] === true;
  const properties = asStringArray(args['properties']);

  const parameters: ToolCallParameter[] = [];
  parameters.push({ label: 'Path', value: path ?? '(not provided)' });
  if (path !== undefined) {
    // The effective resource path, matching the selector `buildResourceUrl`
    // appends: `.0.json` reads the node, `.1.json` reads its children too.
    parameters.push({
      label: 'Request',
      value: `${path}.${includeChildren ? '1' : '0'}.json`,
    });
  }
  if (properties !== undefined) {
    parameters.push({
      label: 'Properties',
      value: properties.length > 0 ? properties.join(', ') : '(none)',
    });
  }
  if (args['includeChildren'] !== undefined) {
    parameters.push({ label: 'Include children', value: includeChildren ? 'Yes' : 'No' });
  }

  return { summary: path, parameters };
}

function describeQuery(args: Readonly<Record<string, JsonValue>>): ToolCallDetails {
  const predicates = asPredicates(args['predicates']);
  const query = predicates === undefined ? undefined : formatQuery(predicates);
  const properties = asStringArray(args['properties']);

  const parameters: ToolCallParameter[] = [];
  parameters.push({ label: 'Query', value: query ?? '(no predicates)' });
  if (typeof args['offset'] === 'number') {
    parameters.push({ label: 'Offset', value: String(args['offset']) });
  }
  if (typeof args['limit'] === 'number') {
    parameters.push({ label: 'Limit', value: String(args['limit']) });
  }
  if (properties !== undefined) {
    parameters.push({
      label: 'Properties',
      value: properties.length > 0 ? properties.join(' ') : '(none)',
    });
  }

  return { summary: query, parameters };
}

/** The universal fallback: every argument, verbatim. */
function describeGenericArgs(args: Readonly<Record<string, JsonValue>>): ToolCallDetails {
  const entries = Object.entries(args);
  if (entries.length === 0) {
    return { summary: undefined, parameters: [{ label: 'Arguments', value: '(none)' }] };
  }
  return {
    summary: undefined,
    parameters: entries.map(([key, value]) => ({ label: key, value: renderArgValue(value) })),
  };
}

/**
 * The standard details representation for a tool call. Unknown tools - including
 * any tool added to `src/shared/tools` after this build - fall through to
 * `describeGenericArgs`, so the expanded billet always shows what was sent.
 */
export function describeToolCall(
  toolName: string,
  args: Readonly<Record<string, JsonValue>>,
): ToolCallDetails {
  switch (toolName) {
    case 'aem_get_json':
      return describeGetJson(args);
    case 'aem_query':
      return describeQuery(args);
    default:
      return describeGenericArgs(args);
  }
}
