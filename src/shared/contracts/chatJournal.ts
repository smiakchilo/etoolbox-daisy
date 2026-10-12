import { z } from 'zod';
import { agentEventSchema } from './agentEvents';
import { modelIdSchema, reasoningEffortSchema } from './appSettings';
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
 * There is deliberately no `model`/`reasoningEffort` field here. The application
 * only knows the *configured preference* at open time, which for a resumed
 * session can differ from the model the SDK session actually runs - a value
 * written here could be wrong. The model the agent is *observed* to use is
 * journaled instead, as `model.changed` / `model.usage` agent events (and
 * summarised per turn in `turn.summary`), each at the moment it is known.
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
 * Why a turn was interrupted. `"stopped"` is a Stop the user pressed;
 * `"navigation"` is every other app-initiated abort (an AEM server switch, a
 * cross-origin navigation, a render-process-gone, a destroyed view).
 *
 * Declared in the contract layer (not in the renderer) because it is persisted
 * in a journal record and therefore crosses a process boundary.
 */
export const interruptionReasonSchema = z.enum(['stopped', 'navigation']);

export type InterruptionReason = z.infer<typeof interruptionReasonSchema>;

/**
 * A durable "this turn was interrupted" marker, written by main when it aborts a
 * turn in flight - a user Stop or an AEM-context-invalidating abort. The live
 * renderer paints its own notice from the resulting `cancelling` event - this
 * record exists so a resumed chat's transcript shows the notice too. A replayed
 * notice is *historical*: the renderer never offers its Resume action for it (see
 * `transcriptStore.ts`).
 *
 * Deliberately a record of its own rather than an `AgentEvent`: the normalized
 * event stream already carries the `cancelling` state, but only main knows
 * whether that cancellation was a user Stop or an application abort, and only
 * the notice carries that distinction.
 */
export const chatJournalInterruptionRecordSchema = z
  .object({
    recordType: z.literal('interruption'),
    at: epochMillisecondsSchema,
    chatId: chatIdSchema,
    reason: interruptionReasonSchema,
  })
  .strict();

export type ChatJournalInterruptionRecord = Readonly<
  z.infer<typeof chatJournalInterruptionRecordSchema>
>;

/**
 * How a turn ended, as the journal observed it: `completed` (the session went
 * idle), `error` (an `error` event), or `interrupted` (the turn was cancelled
 * or the chat closed under it).
 */
export const turnOutcomeSchema = z.enum(['completed', 'error', 'interrupted']);

export type TurnOutcome = z.infer<typeof turnOutcomeSchema>;

const summaryMetricSchema = z.number().nonnegative();

/**
 * One line per turn, written by the journal itself when the turn ends, from the
 * timestamps of the records it already writes - no adapter involvement. It is
 * what makes a slow or stuck turn diagnosable after the fact: where the time
 * went (waiting for the first sign of activity, for the first text, in tools)
 * and what the model calls cost. All durations are milliseconds measured from
 * the moment the user's prompt was handed to the journal. `firstActivityMs` is
 * the first event of the turn other than a session-state change (reasoning
 * counts); `firstTextMs` is the first assistant text. A missing field means
 * the turn never got there - a turn that errored before any text has no
 * `firstTextMs`. `model`/`reasoningEffort` are the last values a `model.usage`
 * event reported for the turn.
 */
export const chatJournalTurnSummaryRecordSchema = z
  .object({
    recordType: z.literal('turn.summary'),
    at: epochMillisecondsSchema,
    chatId: chatIdSchema,
    turnId: turnIdSchema,
    outcome: turnOutcomeSchema,
    durationMs: summaryMetricSchema,
    firstActivityMs: summaryMetricSchema.optional(),
    firstTextMs: summaryMetricSchema.optional(),
    toolCallCount: z.number().int().nonnegative(),
    toolDurationMs: summaryMetricSchema,
    modelCallCount: z.number().int().nonnegative(),
    modelCallFailureCount: z.number().int().nonnegative(),
    model: modelIdSchema.optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    inputTokens: summaryMetricSchema.optional(),
    outputTokens: summaryMetricSchema.optional(),
    cacheReadTokens: summaryMetricSchema.optional(),
    reasoningTokens: summaryMetricSchema.optional(),
    cost: summaryMetricSchema.optional(),
    finishReason: z.string().min(1).max(100).optional(),
  })
  .strict();

export type ChatJournalTurnSummaryRecord = Readonly<
  z.infer<typeof chatJournalTurnSummaryRecordSchema>
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
  chatJournalInterruptionRecordSchema,
  chatJournalTurnSummaryRecordSchema,
  chatJournalClosedRecordSchema,
]);

export type ChatJournalRecord = z.infer<typeof chatJournalRecordSchema>;

export function parseChatJournalRecord(candidate: unknown): ChatJournalRecord {
  return chatJournalRecordSchema.parse(candidate);
}
