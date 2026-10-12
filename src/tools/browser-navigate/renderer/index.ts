import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  describeGenericArgs,
  parameterRows,
} from '../../../shared';

/**
 * `browser_navigate`'s deliberate transcript composition (AGENTS.md section 5):
 * the collapsed line names the action and its target (`Open HPE DEV: /content/…`),
 * and expanding reveals the host, its origin, the path, and the outcome. The
 * result is read from the succeeded payload, so the "Result" row appears only
 * once the call has completed.
 */
function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, JsonValue>>;
}

function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const path = typeof args['path'] === 'string' ? args['path'] : '';
  const argHost = typeof args['host'] === 'string' ? args['host'] : undefined;

  const record = asRecord(data);
  const succeeded = record?.['operation'] === 'browser_navigate';
  const hostLabel =
    succeeded && typeof record['hostLabel'] === 'string' ? record['hostLabel'] : argHost;
  const origin = succeeded && typeof record['origin'] === 'string' ? record['origin'] : undefined;
  const switched = succeeded && record['switched'] === true;

  if (!succeeded && path === '' && argHost === undefined) {
    return describeGenericArgs(args);
  }

  const summary =
    path.length === 0
      ? undefined
      : hostLabel !== undefined
        ? `Open ${hostLabel}: ${path}`
        : `Open ${path}`;

  return {
    summary,
    parameters: parameterRows([
      ['Host', hostLabel],
      ['Origin', origin],
      ['Path', path.length > 0 ? path : undefined],
      ['Result', succeeded ? (switched ? 'Opened (switched hosts)' : 'Opened') : undefined],
    ]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: 'browser_navigate',
  describeCall,
};
