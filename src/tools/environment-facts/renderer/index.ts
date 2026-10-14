import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  describeGenericArgs,
  parameterRows,
} from '../../../shared';

/**
 * `environment_facts` takes no arguments, so its interesting detail lives in
 * its *result*: every configured host, with the live pane's host flagged. The
 * renderer reads them from the result payload - `describeCall`'s second
 * argument (see `toolRenderer.ts`) - rather than from its (empty) arguments,
 * so the hosts are ordinary collapsible parameter rows.
 */
function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, JsonValue>>;
}

interface HostFact {
  readonly label: string;
  readonly origin: string;
  readonly contentRoots: readonly string[];
  readonly componentRoots: readonly string[];
  readonly damRoots: readonly string[];
  readonly priorityPaths: readonly string[];
  readonly current: boolean;
}

function asStringList(value: JsonValue | undefined): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value as readonly JsonValue[]) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

function asHosts(value: JsonValue | undefined): readonly HostFact[] {
  if (!Array.isArray(value)) return [];
  const hosts: HostFact[] = [];
  for (const entry of value as readonly JsonValue[]) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const label = typeof record['label'] === 'string' ? record['label'] : '';
    const origin = typeof record['origin'] === 'string' ? record['origin'] : '';
    if (label === '' || origin === '') continue;
    hosts.push({
      label,
      origin,
      contentRoots: asStringList(record['contentRoots']),
      componentRoots: asStringList(record['componentRoots']),
      damRoots: asStringList(record['damRoots']),
      priorityPaths: asStringList(record['priorityPaths']),
      current: record['current'] === true,
    });
  }
  return hosts;
}

function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const record = asRecord(data);
  if (record?.['operation'] !== 'environment_facts') {
    // Pending, failed, or a shape this build does not recognise: fall back to
    // the generic (empty) argument view rather than inventing facts.
    return describeGenericArgs(args);
  }

  const hosts = asHosts(record['hosts']);
  const current = hosts.find((host) => host.current);
  const hostList = hosts
    .map((host) => `${host.label}${host.current ? ' (current)' : ''}: ${host.origin}`)
    .join('; ');

  return {
    summary: current?.origin,
    parameters: parameterRows([
      ['Current host', current?.origin],
      ['Content roots', current?.contentRoots.join(', ')],
      ['Component roots', current?.componentRoots.join(', ')],
      [
        'DAM roots',
        current !== undefined && current.damRoots.length > 0
          ? current.damRoots.join(', ')
          : undefined,
      ],
      [
        'Priority paths',
        current !== undefined && current.priorityPaths.length > 0
          ? current.priorityPaths.join(', ')
          : undefined,
      ],
      ['Hosts', hostList.length > 0 ? hostList : undefined],
    ]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: 'environment_facts',
  describeCall,
};
