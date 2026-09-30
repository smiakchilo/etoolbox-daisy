import {
  type JsonValue,
  type ToolCallDetails,
  type ToolCallParameter,
  type ToolRendererModule,
  asStringArray,
} from '../../../shared';
import { readQueryResultTable } from './queryResultViewModel';

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

export const renderer: ToolRendererModule = {
  toolName: 'aem_query',
  describeCall,
  readResultTable: (data) => readQueryResultTable('aem_query', data),
};
