import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  asStringArray,
  describeGenericArgs,
  parameterRows,
} from '../../../shared';

/**
 * `aem_environment_facts` takes no arguments, so its interesting detail lives in
 * its *result*: the host origin and the effective content/component roots. The
 * renderer therefore reads them from the result payload - `describeCall`'s
 * second argument (see `toolRenderer.ts`) - rather than from its (empty)
 * arguments. That makes those facts ordinary collapsible parameter rows:
 * collapsing the billet hides them, and the collapsed summary is the host URL
 * rather than a fixed "Environment facts" label. Composed with the user
 * (AGENTS.md section 5).
 */
function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, JsonValue>>;
}

function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const record = asRecord(data);
  if (record?.['operation'] !== 'aem_environment_facts') {
    // Pending, failed, or a shape this build does not recognise: fall back to
    // the generic (empty) argument view rather than inventing facts.
    return describeGenericArgs(args);
  }

  const origin = typeof record['sourceOrigin'] === 'string' ? record['sourceOrigin'] : '';
  const contentRoots = asStringArray(record['contentRoots']) ?? [];
  const componentRoots = asStringArray(record['componentRoots']) ?? [];

  return {
    summary: origin.length > 0 ? origin : undefined,
    parameters: parameterRows([
      ['Host', origin],
      ['Content roots', contentRoots.join(', ')],
      ['Component roots', componentRoots.join(', ')],
    ]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: 'aem_environment_facts',
  describeCall,
};
