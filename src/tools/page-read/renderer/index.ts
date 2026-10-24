import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  asCount,
  asRecord,
  asStringArray,
  asText,
  parameterRows,
} from '../../../shared';

function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const selector = asText(args['selector']);
  const attributes = asStringArray(args['attributes'])?.join(', ');
  const result = asRecord(data);
  const items = result?.['items'];

  return {
    summary: selector ?? '',
    parameters: parameterRows([
      ['Selector', selector ?? '(not provided)'],
      ['Include', asText(args['include'])],
      ['Attributes', attributes === '' ? undefined : attributes],
      ['Limit', asCount(args['limit'])],
      ['Frame', asText(args['frame'])],
      ['Matched', asCount(result?.['matched'])],
      ['Returned', Array.isArray(items) ? String(items.length) : undefined],
    ]),
  };
}

export const renderer: ToolRendererModule = { toolName: 'page_read', describeCall };
