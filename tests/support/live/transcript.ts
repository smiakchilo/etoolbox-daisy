import { type Journal, toolCalls, type ToolCallEntry } from './journal';

export const RESULT_TRUNCATE_BYTES = 2048;
const ARGUMENT_SUMMARY_CHARS = 300;

/** Cuts text to at most `maxChars` characters and says how much was dropped. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} more characters]`;
}

function summarizeArguments(args: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(args);
  return text.length <= ARGUMENT_SUMMARY_CHARS
    ? text
    : `${text.slice(0, ARGUMENT_SUMMARY_CHARS)}... (${text.length} chars)`;
}

/** `ok`/`error CODE`/`no result recorded`: the status word of a call. */
export function describeToolStatus(call: ToolCallEntry): string {
  if (call.outcome === undefined) return 'no result recorded';
  return call.outcome.ok ? 'ok' : `error ${call.outcome.error.code}`;
}

function renderToolCall(call: ToolCallEntry): string[] {
  const lines = [
    `- tool \`${call.toolName}\` ${summarizeArguments(call.arguments)} -> ${describeToolStatus(call)}`,
  ];
  const { outcome } = call;
  if (outcome === undefined) return lines;
  if (outcome.ok) {
    const data = typeof outcome.data === 'string' ? outcome.data : JSON.stringify(outcome.data);
    lines.push(
      '',
      '  ```',
      ...truncate(data, RESULT_TRUNCATE_BYTES)
        .split('\n')
        .map((l) => `  ${l}`),
      '  ```',
    );
  } else {
    lines.push(`  ${outcome.error.message}`);
  }
  return lines;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * Renders a journal as the conversation a person would read: prompts,
 * assistant text, tool calls with a status and a truncated result, questions,
 * errors and per-turn summaries. Pure and secret-unaware - the caller redacts.
 */
export function renderTranscript(journal: Journal, heading = 'Transcript'): string {
  const calls = new Map(toolCalls(journal).map((call) => [call.toolCallId, call]));
  const out: string[] = [`# ${heading}`, ''];
  let turn = 0;
  for (const record of journal.records) {
    switch (record.recordType) {
      case 'user.prompt':
        turn += 1;
        out.push(`## Turn ${turn}`, '', '**User**', '', indent(record.prompt), '');
        break;
      case 'assistant.message.partial':
        out.push('**Assistant (interrupted)**', '', indent(record.content), '');
        break;
      case 'interruption':
        out.push(`_Interrupted: ${record.reason}_`, '');
        break;
      case 'turn.summary': {
        const tokens =
          record.inputTokens === undefined && record.outputTokens === undefined
            ? ''
            : `, tokens in/out ${record.inputTokens ?? '?'}/${record.outputTokens ?? '?'}`;
        out.push(
          `_Turn ${record.outcome} in ${record.durationMs} ms, ${record.toolCallCount} tool call(s), ${record.modelCallCount} model call(s)${tokens}_`,
          '',
        );
        break;
      }
      case 'agent.event': {
        const { event } = record;
        if (event.type === 'assistant.message.completed' && event.content.trim() !== '') {
          out.push('**Assistant**', '', indent(event.content), '');
        } else if (event.type === 'tool.call.requested') {
          const call = calls.get(event.toolCallId);
          if (call !== undefined) out.push(...renderToolCall(call), '');
        } else if (event.type === 'user.input.requested') {
          const choices = [...(event.options ?? []), ...(event.actions ?? [])];
          out.push(
            `**Question to user**${event.question === undefined ? '' : `: ${event.question}`}`,
            choices.length === 0 ? '' : `Choices: ${choices.join(' | ')}`,
            '',
          );
        } else if (event.type === 'error') {
          out.push(`**Error** ${event.error.code}: ${event.error.message}`, '');
        } else if (event.type === 'model.call.failed') {
          out.push(
            `**Model call failed** ${[event.failureKind, event.statusCode, event.errorCode, event.errorType].filter((part) => part !== undefined).join(' ')}`,
            '',
          );
        }
        break;
      }
      default:
        break;
    }
  }
  return out.join('\n');
}
