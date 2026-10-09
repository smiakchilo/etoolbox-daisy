import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  asStringArray,
  parameterRows,
} from '../../../shared';

function asPredicates(value: JsonValue | undefined): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries: [string, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined;
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

/**
 * The QueryBuilder query as the user reads it: `key=value` pairs joined by
 * `&`, in the order the model supplied them. Values are shown decoded rather
 * than percent-encoded - this is the human-facing "what was asked", not the
 * wire request; `buildQueryUrl` in `../aemQuery.ts` remains the authority on
 * the exact encoded URL.
 */
function formatQuery(predicates: Readonly<Record<string, string>>): string {
  return Object.entries(predicates)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function describeCall(args: Readonly<Record<string, JsonValue>>): ToolCallDetails {
  const predicates = asPredicates(args['predicates']);
  const query = predicates === undefined ? undefined : formatQuery(predicates);
  const properties = asStringArray(args['properties']);
  const roots = asStringArray(args['roots']);

  let rootsValue: string | undefined;
  if (roots !== undefined) {
    rootsValue = roots.length > 0 ? roots.join(', ') : '(none)';
  }
  let propertiesValue: string | undefined;
  if (properties !== undefined) {
    propertiesValue = properties.length > 0 ? properties.join(' ') : '(none)';
  }

  return {
    summary: query,
    // `parameterRows` (the one rendering pattern): the query first, then the
    // options in a stable order, each absent option omitted.
    parameters: parameterRows([
      ['Query', query ?? '(no predicates)'],
      ['Roots', rootsValue],
      ['Offset', typeof args['offset'] === 'number' ? String(args['offset']) : undefined],
      ['Limit', typeof args['limit'] === 'number' ? String(args['limit']) : undefined],
      ['Properties', propertiesValue],
    ]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: 'aem_query',
  describeCall,
};
