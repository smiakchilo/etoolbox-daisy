import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  SKILL_RESOURCE_TOOL_NAME,
  asCount,
  asRecord,
  asText,
  describeGenericArgs,
  parameterRows,
} from '../../../shared';

/**
 * `skill_resource`'s transcript composition: the collapsed line names the
 * skill and the file; expanding shows the skill, the file, the lines returned
 * and the file's size. The lines and size come from the succeeded payload.
 */
function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const skill = asText(args['skill']);
  const path = asText(args['path']);
  if (skill === undefined || path === undefined) return describeGenericArgs(args);

  const record = asRecord(data);
  const succeeded = record?.['operation'] === SKILL_RESOURCE_TOOL_NAME;
  const start = succeeded ? asCount(record['startLine']) : undefined;
  const end = succeeded ? asCount(record['endLine']) : undefined;
  const total = succeeded ? asCount(record['totalLines']) : undefined;
  const lines =
    start !== undefined && end !== undefined && total !== undefined && end !== '0'
      ? `${start}-${end} of ${total}`
      : undefined;
  const size = succeeded ? asCount(record['size']) : undefined;
  const entries = succeeded ? asCount(record['entryCount']) : undefined;

  return {
    summary: path === '.' ? `List ${skill}` : `Read ${skill}/${path}`,
    parameters: parameterRows([
      ['Skill', skill],
      ['File', path],
      ['Lines', lines],
      ['Size', size === undefined ? undefined : `${size} B`],
      ['Entries', entries],
    ]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: SKILL_RESOURCE_TOOL_NAME,
  describeCall,
};
