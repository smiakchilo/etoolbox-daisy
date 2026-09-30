import {
  type JsonValue,
  type ToolCallDetails,
  type ToolCallParameter,
  type ToolRendererModule,
  asStringArray,
} from '../../../shared';

function describeCall(args: Readonly<Record<string, JsonValue>>): ToolCallDetails {
  const path = typeof args['path'] === 'string' ? args['path'] : undefined;
  const includeChildren = args['includeChildren'] === true;
  const properties = asStringArray(args['properties']);

  const parameters: ToolCallParameter[] = [];
  parameters.push({ label: 'Path', value: path ?? '(not provided)' });
  if (path !== undefined) {
    // The effective request: `.0.json` reads the node, `.1.json` reads its
    // children too.
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

export const renderer: ToolRendererModule = { toolName: 'aem_get_json', describeCall };
