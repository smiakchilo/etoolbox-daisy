import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  SKILL_SCRIPT_TOOL_NAME,
  asCount,
  asRecord,
  asText,
  describeGenericArgs,
  parameterRows,
} from '../../../shared';

const PREVIEW_LIMIT = 200;

function preview(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}...` : text;
}

/**
 * `skill_script`'s transcript composition: the collapsed line names the skill
 * and the script; expanding shows the input the model passed and, once the call
 * has succeeded, the duration, a bounded preview of the result and the logs.
 */
function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const skill = asText(args['skill']);
  const script = asText(args['script']);
  if (skill === undefined || script === undefined) return describeGenericArgs(args);

  const record = asRecord(data);
  const succeeded = record?.['operation'] === SKILL_SCRIPT_TOOL_NAME;
  const duration = succeeded ? asCount(record['durationMs']) : undefined;
  return {
    summary: `Run ${skill}/${script}`,
    parameters: parameterRows([
      ['Skill', skill],
      ['Script', script],
      ['Input', preview(args['input'])],
      ['Duration', duration === undefined ? undefined : `${duration} ms`],
      ['Result', succeeded ? preview(record['output']) : undefined],
      ['Logs', succeeded ? asText(record['logs']) : undefined],
    ]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: SKILL_SCRIPT_TOOL_NAME,
  describeCall,
};
