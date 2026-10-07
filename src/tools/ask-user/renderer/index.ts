import {
  type JsonValue,
  type ToolCallDetails,
  type ToolConversationItem,
  type ToolRendererModule,
  asStringArray,
  parameterRows,
} from '../../../shared';

/**
 * `ask_user` is not a read tool, so it does not render as a billet: the
 * transcript shows its question as the agent's own message and the user's
 * answer as a user message (`presentation: 'conversation'`), with no
 * icon-led call line at all. This renderer supplies that pair from the call's
 * arguments (the question and options) and, once the call has succeeded, its
 * result payload (the chosen answer). Composed with the user (AGENTS.md
 * section 5).
 *
 * `describeCall` is still provided - it is the contract's required member and
 * the safety net if this tool is ever rendered as a billet - but the transcript
 * never displays it while `presentation` is `'conversation'`.
 */

function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, JsonValue>>;
}

/** The question the model asked, from the tool call's arguments. */
function questionFromArgs(args: Readonly<Record<string, JsonValue>>): string | undefined {
  const question = args['question'];
  return typeof question === 'string' && question.length > 0 ? question : undefined;
}

/**
 * The user's answer, from the succeeded call's payload, or `undefined` while
 * the call is still pending / failed. The payload is the tool's own structured
 * success (`operation: 'ask_user'`, `selections`, `freeform`).
 */
function answerFromData(data: JsonValue | undefined): string | undefined {
  const record = asRecord(data);
  if (record?.['operation'] !== 'ask_user') return undefined;
  const freeform = record['freeform'];
  if (typeof freeform === 'string' && freeform.length > 0) return freeform;
  const selections = asStringArray(record['selections']) ?? [];
  return selections.length > 0 ? selections.join(', ') : '';
}

function describeCall(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolCallDetails {
  const question = questionFromArgs(args);
  const options = asStringArray(args['options']) ?? [];
  const answer = answerFromData(data);
  return {
    summary: question,
    parameters: parameterRows([
      ['Question', question],
      ['Options', options.length > 0 ? options.join(', ') : undefined],
      ['Answer', answer],
    ]),
  };
}

function readConversation(
  args: Readonly<Record<string, JsonValue>>,
  data?: JsonValue,
): ToolConversationItem | undefined {
  const question = questionFromArgs(args);
  if (question === undefined) {
    // A shape this build does not recognise: render nothing rather than a
    // half-empty message.
    return undefined;
  }
  return { question, answer: answerFromData(data) };
}

export const renderer: ToolRendererModule = {
  toolName: 'ask_user',
  presentation: 'conversation',
  describeCall,
  readConversation,
};
