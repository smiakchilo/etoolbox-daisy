import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  asStringArray,
  parameterRows,
} from '../../../shared';

function describeCall(args: Readonly<Record<string, JsonValue>>): ToolCallDetails {
  const path = typeof args['path'] === 'string' ? args['path'] : undefined;
  const includeChildren = args['includeChildren'] === true;
  const properties = asStringArray(args['properties']);

  let propertiesValue: string | undefined;
  if (properties !== undefined) {
    propertiesValue = properties.length > 0 ? properties.join(', ') : '(none)';
  }

  return {
    summary: path,
    // `parameterRows` (the one rendering pattern): identifying row first, then
    // the derived request, then the options - an absent option is omitted.
    parameters: parameterRows([
      ['Path', path ?? '(not provided)'],
      // The effective request: `.0.json` reads the node, `.1.json` reads its
      // children too.
      ['Request', path !== undefined ? `${path}.${includeChildren ? '1' : '0'}.json` : undefined],
      ['Properties', propertiesValue],
      [
        'Include children',
        args['includeChildren'] !== undefined ? (includeChildren ? 'Yes' : 'No') : undefined,
      ],
    ]),
  };
}

export const renderer: ToolRendererModule = { toolName: 'aem_get_json', describeCall };
