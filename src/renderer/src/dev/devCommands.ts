import type { AgentEvent, ChatId, MessageId, TurnId } from '../../../shared';
import { ASK_USER_PREVIEW_HELP, ASK_USER_PREVIEW_PREFIX } from './askUserPreview';
import { OPEN_CHAT_BY_ID_HELP, OPEN_CHAT_BY_ID_PREFIX } from './openChatById';
import { UPDATE_PREVIEW_HELP, UPDATE_PREVIEW_PREFIX } from './updatePreview';

/**
 * The dev-only `!!` command registry, and the one mechanism that answers a
 * lone `?` argument for every command.
 *
 * Each command keeps its own parser and its own usage lines; this module is the
 * single place that knows which commands exist, so `!!<name> ?` prints that
 * command's arguments (`!!ask ?`, `!!open ?`) and `!!?` (or `!!help`) lists
 * them all - without each parser repeating the mechanism. It is deliberately
 * checked *before* the parsers run (see `chatPane.ts`'s `onDevCommand`), so `?`
 * can never be mistaken for a command's own argument.
 *
 * Add a command by exporting its `[form, description]` lines from its own
 * module and adding one entry below.
 */

/** One command's forms, each as `[form, description]`; the descriptions are optional sugar. */
export type DevCommandUsage = ReadonlyArray<readonly [string, string]>;

export interface DevCommandDefinition {
  /** The command's own prefix, including `!!`, e.g. `!!ask`. */
  readonly prefix: string;
  readonly usage: DevCommandUsage;
}

export const DEV_COMMANDS: readonly DevCommandDefinition[] = [
  { prefix: ASK_USER_PREVIEW_PREFIX, usage: ASK_USER_PREVIEW_HELP },
  { prefix: OPEN_CHAT_BY_ID_PREFIX, usage: OPEN_CHAT_BY_ID_HELP },
  { prefix: UPDATE_PREVIEW_PREFIX, usage: UPDATE_PREVIEW_HELP },
];

/** The words that, as a lone argument, ask for a command's help. */
const HELP_WORDS: ReadonlySet<string> = new Set(['?', 'help']);

/** Placeholder chat id: the transcript store routes by the events it is handed and never reads `chatId`. */
const DEV_CHAT_ID = 'dev' as ChatId;

/** The widest form in `usage`, for column alignment. */
function widestForm(usage: DevCommandUsage): number {
  return usage.reduce((widest, [form]) => Math.max(widest, form.length), 0);
}

/** Renders `[form, description]` pairs as lines, each form padded to `width`. */
function formatUsage(usage: DevCommandUsage, width: number): readonly string[] {
  return usage.map(([form, description]) => `${form.padEnd(width)}  ${description}`);
}

/** A fenced code block, so the transcript keeps the columns aligned (see `renderMarkdown`). */
function asCodeBlock(lines: readonly string[]): string {
  return ['```', ...lines, '```'].join('\n');
}

/**
 * The help text a `!!` input asks for, or `undefined` when it is not a help
 * request - so the ordinary parsers, and (for an unknown `!!word`) the model,
 * still see it unchanged. `!!<name> ?` (or `!!<name> help`) prints that
 * command; `!!?` / `!!help` prints them all.
 */
export function matchDevHelp(input: string): string | undefined {
  const tokens = input.trim().split(/\s+/);
  const head = tokens[0];
  if (head === undefined || !head.startsWith('!!')) return undefined;
  const rest = tokens.slice(1);

  // `!!?` / `!!help` - every command, aligned to one column.
  if (HELP_WORDS.has(head.slice(2))) {
    if (rest.length !== 0) return undefined;
    const width = DEV_COMMANDS.reduce(
      (widest, command) => Math.max(widest, widestForm(command.usage)),
      0,
    );
    return asCodeBlock(DEV_COMMANDS.flatMap((command) => formatUsage(command.usage, width)));
  }

  const command = DEV_COMMANDS.find((candidate) => candidate.prefix === head);
  if (command === undefined) return undefined;
  return rest.length === 1 && HELP_WORDS.has(rest[0] ?? '')
    ? asCodeBlock(formatUsage(command.usage, widestForm(command.usage)))
    : undefined;
}

/**
 * The synthetic assistant message a help request paints into the transcript.
 * `index` makes each help message its own transcript item (message ids are
 * unique per conversation); the pane owns the counter and feeds this through
 * its store exactly as it feeds the preview's synthetic tool-call events.
 */
export function buildDevHelpMessage(text: string, index: number): AgentEvent {
  const suffix = String(index);
  return {
    type: 'assistant.message.completed',
    chatId: DEV_CHAT_ID,
    sequence: 0,
    turnId: `dev-help-turn-${suffix}` as TurnId,
    messageId: `dev-help-message-${suffix}` as MessageId,
    content: text,
  };
}
