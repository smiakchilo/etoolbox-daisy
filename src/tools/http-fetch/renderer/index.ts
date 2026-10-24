import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  parameterRows,
} from '../../../shared';

function describeCall(args: Readonly<Record<string, JsonValue>>): ToolCallDetails {
  const url = typeof args['url'] === 'string' ? args['url'] : undefined;
  const method = typeof args['method'] === 'string' ? args['method'] : undefined;
  const accept = typeof args['accept'] === 'string' ? args['accept'] : undefined;

  return {
    summary: url,
    parameters: parameterRows([
      ['URL', url ?? '(not provided)'],
      ['Method', method ?? (url !== undefined ? 'GET' : undefined)],
      ['Accept', accept],
    ]),
  };
}

export const renderer: ToolRendererModule = { toolName: 'http_fetch', describeCall };
