import {
  type JsonValue,
  type ToolCallDetails,
  type ToolRendererModule,
  SKILL_TOOL_NAME,
  asCount,
  asRecord,
  asText,
  describeGenericArgs,
  parameterRows,
} from '../../../shared';

/**
 * `skill`'s transcript composition: the collapsed line names the skill, and the
 * expanded rows say where it came from and what it brought with it. The source
 * and counts come from the succeeded payload, so they appear once the call has
 * completed. A model-chosen load is shown as this billet; the controller's
 * marker for an explicit `/name` prompt is kept out of the transcript (see
 * `transcriptStore.ts`'s `revealSkillLoad`).
 */
function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const record = asRecord(data);
  const succeeded = record?.['operation'] === SKILL_TOOL_NAME;
  const name = succeeded ? asText(record['skill']) : asText(args['name']);
  if (name === undefined) return describeGenericArgs(args);

  const source = succeeded ? asText(record['source']) : undefined;
  const scripts = succeeded ? asCount(record['scriptCount']) : undefined;
  return {
    summary: `Load skill ${name}`,
    parameters: parameterRows([
      ['Skill', name],
      [
        'Source',
        source === undefined ? undefined : source === 'user' ? 'Your skills folder' : 'Built in',
      ],
      ['Files', succeeded ? asCount(record['fileCount']) : undefined],
      ['Scripts', scripts === '0' ? undefined : scripts],
    ]),
  };
}

export const renderer: ToolRendererModule = {
  toolName: SKILL_TOOL_NAME,
  describeCall,
};
