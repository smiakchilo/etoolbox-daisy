import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { toChatFileName } from '../../../src/main/chatJournalPaths';
import {
  type AgentEvent,
  type ChatJournalRecord,
  type ChatJournalTurnSummaryRecord,
  type ChatJournalUserPromptRecord,
  chatJournalRecordSchema,
  SKILL_TOOL_NAME,
} from '../../../src/shared';

type EventOf<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;

/** A parsed journal. `skippedLines` counts lines that were not valid records (a partial last line included). */
export interface Journal {
  readonly records: readonly ChatJournalRecord[];
  readonly skippedLines: number;
}

export type ToolOutcome = EventOf<'tool.result'>['outcome'];

/** One tool call: the request joined with its result, if the journal holds one. */
export interface ToolCallEntry {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly requestedAt: number;
  /** Zero-based index of the user prompt the call belongs to; -1 before the first prompt. */
  readonly promptIndex: number;
  /** Absent when the journal never recorded a result (the app died, or the runtime reports none). */
  readonly outcome?: ToolOutcome;
  readonly resolvedAt?: number;
}

export interface AssistantMessage {
  readonly at: number;
  readonly messageId: string;
  readonly content: string;
  readonly promptIndex: number;
}

export interface ModelUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly reasoningTokens: number;
  readonly calls: number;
}

/**
 * Parses journal text line by line. Like the application's own reader it is
 * tolerant: a blank, malformed or schema-invalid line (the last one may be
 * half-written while the app is still running) is counted and skipped.
 */
export function parseJournalText(text: string): Journal {
  const records: ChatJournalRecord[] = [];
  let skippedLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    const parsed = chatJournalRecordSchema.safeParse(candidate);
    if (parsed.success) records.push(parsed.data);
    else skippedLines += 1;
  }
  return { records, skippedLines };
}

export function readJournalFile(filePath: string): Journal {
  return parseJournalText(readFileSync(filePath, 'utf8'));
}

/** The journal path of a chat; throws on an id that is not a safe file name. */
export function journalPathFor(chatsDir: string, chatId: string): string {
  return path.join(chatsDir, toChatFileName(chatId));
}

/** Chat ids that currently have a journal file (the file name without `.jsonl`). */
export function listJournalChatIds(chatsDir: string): readonly string[] {
  try {
    return readdirSync(chatsDir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length));
  } catch {
    return [];
  }
}

export function agentEvents(journal: Journal): readonly (AgentEvent & { readonly at: number })[] {
  const events: (AgentEvent & { readonly at: number })[] = [];
  for (const record of journal.records) {
    if (record.recordType === 'agent.event') events.push({ ...record.event, at: record.at });
  }
  return events;
}

export function userPrompts(journal: Journal): readonly ChatJournalUserPromptRecord[] {
  return journal.records.filter(
    (record): record is ChatJournalUserPromptRecord => record.recordType === 'user.prompt',
  );
}

export function turnSummaries(journal: Journal): readonly ChatJournalTurnSummaryRecord[] {
  return journal.records.filter(
    (record): record is ChatJournalTurnSummaryRecord => record.recordType === 'turn.summary',
  );
}

/** Tool calls in request order, each joined with its result; filtered by name when given. */
export function toolCalls(journal: Journal, toolName?: string): readonly ToolCallEntry[] {
  const calls = new Map<string, ToolCallEntry>();
  let promptIndex = -1;
  for (const record of journal.records) {
    if (record.recordType === 'user.prompt') {
      promptIndex += 1;
      continue;
    }
    if (record.recordType !== 'agent.event') continue;
    const { event } = record;
    if (event.type === 'tool.call.requested') {
      calls.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        arguments: event.arguments,
        requestedAt: record.at,
        promptIndex,
      });
    } else if (event.type === 'tool.result') {
      const call = calls.get(event.toolCallId);
      if (call !== undefined) {
        calls.set(event.toolCallId, { ...call, outcome: event.outcome, resolvedAt: record.at });
      }
    }
  }
  const all = [...calls.values()];
  return toolName === undefined ? all : all.filter((call) => call.toolName === toolName);
}

/** The `skill` calls, with the skill name read from the call's arguments. */
export function skillCalls(
  journal: Journal,
): readonly (ToolCallEntry & { readonly skillName: string | undefined })[] {
  return toolCalls(journal, SKILL_TOOL_NAME).map((call) => {
    const value = call.arguments['name'];
    return { ...call, skillName: typeof value === 'string' ? value : undefined };
  });
}

/** Completed assistant messages in order, tool-only (empty) messages included. */
export function assistantMessages(journal: Journal): readonly AssistantMessage[] {
  const messages: AssistantMessage[] = [];
  let promptIndex = -1;
  for (const record of journal.records) {
    if (record.recordType === 'user.prompt') promptIndex += 1;
    else if (
      record.recordType === 'agent.event' &&
      record.event.type === 'assistant.message.completed'
    ) {
      messages.push({
        at: record.at,
        messageId: record.event.messageId,
        content: record.event.content,
        promptIndex,
      });
    }
  }
  return messages;
}

/** All non-empty assistant text, joined; the text to search when asking "did it say X". */
export function assistantText(journal: Journal): string {
  return assistantMessages(journal)
    .map((message) => message.content)
    .filter((content) => content.trim() !== '')
    .join('\n\n');
}

/** `error` events (turn and tool level) plus `model.call.failed` diagnostics. */
export function errorEvents(
  journal: Journal,
): readonly (EventOf<'error'> | EventOf<'model.call.failed'>)[] {
  const found: (EventOf<'error'> | EventOf<'model.call.failed'>)[] = [];
  for (const record of journal.records) {
    if (record.recordType !== 'agent.event') continue;
    if (record.event.type === 'error' || record.event.type === 'model.call.failed') {
      found.push(record.event);
    }
  }
  return found;
}

/** Every `ask_user` question the model put to the user (`user.input.requested`). */
export function userInputRequests(journal: Journal): readonly EventOf<'user.input.requested'>[] {
  const found: EventOf<'user.input.requested'>[] = [];
  for (const record of journal.records) {
    if (record.recordType === 'agent.event' && record.event.type === 'user.input.requested') {
      found.push(record.event);
    }
  }
  return found;
}

export function modelChanges(journal: Journal): readonly EventOf<'model.changed'>[] {
  const found: EventOf<'model.changed'>[] = [];
  for (const record of journal.records) {
    if (record.recordType === 'agent.event' && record.event.type === 'model.changed') {
      found.push(record.event);
    }
  }
  return found;
}

/** Summed `model.usage` events; a field a provider never reported counts as zero. */
export function modelUsageTotals(journal: Journal): ModelUsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let reasoningTokens = 0;
  let calls = 0;
  for (const record of journal.records) {
    if (record.recordType !== 'agent.event' || record.event.type !== 'model.usage') continue;
    calls += 1;
    inputTokens += record.event.inputTokens ?? 0;
    outputTokens += record.event.outputTokens ?? 0;
    cacheReadTokens += record.event.cacheReadTokens ?? 0;
    reasoningTokens += record.event.reasoningTokens ?? 0;
  }
  return { inputTokens, outputTokens, cacheReadTokens, reasoningTokens, calls };
}

/** The model the chat ran on: the last `model.changed`, else the last turn summary that names one. */
export function modelOf(journal: Journal): string | undefined {
  const last = modelChanges(journal).at(-1);
  if (last !== undefined) return last.model;
  return turnSummaries(journal)
    .map((summary) => summary.model)
    .findLast((model) => model !== undefined);
}

/** The host id the chat recorded: the header's, else the first prompt that named one. */
export function serverIdOf(journal: Journal): string | undefined {
  for (const record of journal.records) {
    if (record.recordType === 'header' && record.serverId !== undefined) return record.serverId;
  }
  return userPrompts(journal).find((prompt) => prompt.serverId !== undefined)?.serverId;
}

/**
 * Whether the newest prompt is blocked on an `ask_user` question: a
 * `user.input.requested` that no later result, message, summary or prompt has
 * closed (the answer arrives as the `ask_user` call's `tool.result`).
 */
export function isAwaitingUserInput(journal: Journal): boolean {
  let awaiting = false;
  for (const record of journal.records) {
    if (record.recordType === 'user.prompt' || record.recordType === 'turn.summary') {
      awaiting = false;
    } else if (record.recordType === 'agent.event') {
      const { type } = record.event;
      if (type === 'user.input.requested') awaiting = true;
      else if (type === 'tool.result' || type === 'assistant.message.completed') awaiting = false;
    }
  }
  return awaiting;
}
