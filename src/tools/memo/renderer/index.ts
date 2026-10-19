import {
  type JsonValue,
  type ToolCallAction,
  type ToolCallDetails,
  type ToolRendererModule,
  MEMO_TOOL_NAME,
  asRecord,
  asText,
  describeGenericArgs,
  parameterRows,
} from '../../../shared';

/** The longest memo text the expanded billet shows before it is cut with an ellipsis. */
export const MEMO_PREVIEW_MAX_LENGTH = 240;

const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  request: 'You asked',
  correction: 'Your correction',
  error: 'An error',
  loop: 'A repeated attempt',
};

function clampPreview(text: string): string {
  return text.length <= MEMO_PREVIEW_MAX_LENGTH
    ? text
    : `${text.slice(0, MEMO_PREVIEW_MAX_LENGTH - 1)}…`;
}

function succeededRecord(data?: JsonValue): Readonly<Record<string, JsonValue>> | undefined {
  const record = asRecord(data);
  return record?.['operation'] === MEMO_TOOL_NAME ? record : undefined;
}

/**
 * `memo`'s transcript composition: the collapsed line says a memo was saved
 * (and for which skill); the rows show the title, scope, why it was written,
 * the text and the file. Hovering a saved memo's billet offers Reveal in folder
 * and Undo (`readActions`).
 */
function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const record = succeededRecord(data);
  const title = asText(record?.['title']) ?? asText(args['title']);
  if (title === undefined) return describeGenericArgs(args);
  const skill = asText(record?.['skill']) ?? asText(args['skill']);
  const trigger = asText(args['trigger']);
  const text = asText(args['text']);
  return {
    summary: skill === undefined ? `Memo saved: ${title}` : `Memo for ${skill}: ${title}`,
    parameters: parameterRows([
      ['Title', title],
      ['Scope', skill ?? 'Generic'],
      ['Trigger', trigger === undefined ? undefined : (TRIGGER_LABELS[trigger] ?? trigger)],
      ['Memo', text === undefined ? undefined : clampPreview(text)],
      ['File', asText(record?.['fileName'])],
    ]),
  };
}

function readActions(
  _args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): readonly ToolCallAction[] {
  const id = asText(succeededRecord(data)?.['id']);
  if (id === undefined) return [];
  return [
    { kind: 'memo.reveal', target: id },
    { kind: 'memo.undo', target: id, doneSummary: 'Memo removed' },
  ];
}

export const renderer: ToolRendererModule = {
  toolName: MEMO_TOOL_NAME,
  describeCall,
  readActions,
};
