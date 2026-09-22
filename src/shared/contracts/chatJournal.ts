import { z } from 'zod';
import { agentEventSchema } from './agentEvents';
import { epochMillisecondsSchema } from './chatMetadata';
import {
  chatIdSchema,
  messageIdSchema,
  sdkSessionIdSchema,
  serverIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from './ids';

/**
 * The on-disk chat journal (implementation-plan.md step 09: "Store UI metadata
 * and an append-only journal of normalized chat events").
 *
 * One file per application `ChatId`, `<home>/etoolbox-daisy/chats/<chatId>.jsonl`,
 * written as **JSON Lines**: a single `header` record followed by one JSON
 * object per line, append-only. The file is deliberately *not* an
 * OpenTelemetry/OTLP document - OTLP is a collector transport encoding built
 * around trace/span trees, not something a human reads or a local app appends
 * to; JSON Lines gives the same strict schema with none of that ceremony.
 *
 * The journal is a UI projection, not a replacement for the SDK's own session
 * state (the SDK session backing a chat lives under `<home>/etoolbox-daisy/copilot`).
 * Per the plan it persists complete messages and tool outcomes, and folds the
 * per-token `assistant.text.delta` events into a single
 * `assistant.message.partial` record for a turn that was interrupted before
 * completion - there is no per-delta line (the plan forbids a synchronous write
 * per delta, and a per-token file would be enormous).
 *
 * `sdkSessionId` is recorded in the `header` (the file is keyed by the
 * application-owned `chatId`, which exists before any SDK session does). A chat
 * whose SDK session is never established therefore has no journal file at all.
 */

export const CHAT_JOURNAL_SCHEMA_VERSION = 1;

/**
 * A user prompt can be up to 50k characters at the IPC boundary
 * (`agent-chat-ipc.ts`) and is stored here verbatim; this bound is deliberately
 * looser so the journal never rejects a prompt the app itself accepted.
 */
const PROMPT_MAX_LENGTH = 100_000;

/**
 * The first line of every journal file, exactly once, before any event record.
 * `startedAt` is the journal's own clock reading at open time, not a value the
 * SDK supplies.
 *
 * There is deliberately no `model`/`reasoningEffort` field. The application
 * only knows the *configured preference*, which for a resumed session can
 * differ from the model the SDK session actually runs - recording a value that
 * may be wrong would be worse than recording none. The live model is owned by
 * the SDK and is not carried by any `AgentEvent`.
 */
export const chatJournalHeaderRecordSchema = z
  .object({
    recordType: z.literal('header'),
    schemaVersion: z.literal(CHAT_JOURNAL_SCHEMA_VERSION),
    chatId: chatIdSchema,
    sdkSessionId: sdkSessionIdSchema,
    serverId: serverIdSchema.optional(),
    startedAt: epochMillisecondsSchema,
  })
  .strict();

export type ChatJournalHeaderRecord = Readonly<z.infer<typeof chatJournalHeaderRecordSchema>>;

/**
 * The user's own prompt. There is no `AgentEvent` variant for a user message
 * (the renderer is the only other place that knows the exact text - see
 * `transcriptStore.ts`'s `applyUserPrompt`), so the journal synthesizes this
 * record from the `sendMessage` call. `prompt` is what the user typed; the
 * application-prepared page context that the model additionally reads is
 * deliberately not duplicated here.
 */
export const chatJournalUserPromptRecordSchema = z
  .object({
    recordType: z.literal('user.prompt'),
    at: epochMillisecondsSchema,
    chatId: chatIdSchema,
    turnId: turnIdSchema,
    prompt: z.string().min(1).max(PROMPT_MAX_LENGTH),
  })
  .strict();

export type ChatJournalUserPromptRecord = Readonly<
  z.infer<typeof chatJournalUserPromptRecordSchema>
>;

/**
 * One normalized `AgentEvent` (`agentEvents.ts`), verbatim. Every event passes
 * through `agentEventSchema` when the journal is written, so a line can always
 * be re-validated on read. `assistant.text.delta` never appears as its own line
 * - see the module doc.
 */
export const chatJournalAgentEventRecordSchema = z
  .object({
    recordType: z.literal('agent.event'),
    at: epochMillisecondsSchema,
    event: agentEventSchema,
  })
  .strict();

export type ChatJournalAgentEventRecord = Readonly<
  z.infer<typeof chatJournalAgentEventRecordSchema>
>;

/**
 * The assistant text observed for a message that never reached
 * `assistant.message.completed` - a turn stopped, cancelled, or failed mid
 * stream. Written once, when the journal observes the turn end, from the folded
 * `assistant.text.delta` events; the deltas themselves are never written.
 */
export const chatJournalPartialMessageRecordSchema = z
  .object({
    recordType: z.literal('assistant.message.partial'),
    at: epochMillisecondsSchema,
    chatId: chatIdSchema,
    turnId: turnIdSchema,
    messageId: messageIdSchema,
    content: z.string(),
  })
  .strict();

export type ChatJournalPartialMessageRecord = Readonly<
  z.infer<typeof chatJournalPartialMessageRecordSchema>
>;

/**
 * A tool call that was requested (and usually approved) but whose turn ended
 * before any `tool.result` arrived - a turn stopped, cancelled, or failed
 * while a tool call was in flight. The normalized event stream records the
 * `tool.call.requested`/`approved` and then simply stops, so without this
 * record a reader cannot tell an abandoned call from one still running. Written
 * by the journal at the turn's end (or at close) for every tool call that never
 * produced a result, and never written for a rejected call (a
 * `tool.call.rejected` is already terminal).
 */
export const chatJournalAbandonedToolCallRecordSchema = z
  .object({
    recordType: z.literal('tool.call.abandoned'),
    at: epochMillisecondsSchema,
    chatId: chatIdSchema,
    toolCallId: toolCallIdSchema,
    toolName: z.string().min(1).max(200),
    turnId: turnIdSchema.optional(),
  })
  .strict();

export type ChatJournalAbandonedToolCallRecord = Readonly<
  z.infer<typeof chatJournalAbandonedToolCallRecordSchema>
>;

/**
 * The last line written for a chat that the application closed. A synthetic
 * marker, not an `AgentEvent`: the SDK adapter's own `closed`
 * `session.state.changed` may or may not precede it, and a reader should treat
 * this record as "the application is done with this chat".
 */
export const chatJournalClosedRecordSchema = z
  .object({
    recordType: z.literal('chat.closed'),
    at: epochMillisecondsSchema,
    chatId: chatIdSchema,
  })
  .strict();

export type ChatJournalClosedRecord = Readonly<z.infer<typeof chatJournalClosedRecordSchema>>;

export const chatJournalRecordSchema = z.discriminatedUnion('recordType', [
  chatJournalHeaderRecordSchema,
  chatJournalUserPromptRecordSchema,
  chatJournalAgentEventRecordSchema,
  chatJournalPartialMessageRecordSchema,
  chatJournalAbandonedToolCallRecordSchema,
  chatJournalClosedRecordSchema,
]);

export type ChatJournalRecord = z.infer<typeof chatJournalRecordSchema>;

export function parseChatJournalRecord(candidate: unknown): ChatJournalRecord {
  return chatJournalRecordSchema.parse(candidate);
}
