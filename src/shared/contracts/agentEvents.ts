import { z } from 'zod';
import {
  chatIdSchema,
  messageIdSchema,
  reasoningIdSchema,
  toolCallIdSchema,
  turnIdSchema,
  userInputRequestIdSchema,
  type ChatId,
  type MessageId,
} from './ids';
import { modelIdSchema, reasoningEffortSchema } from './appSettings';
import { toolErrorSchema, type ToolError } from './errors';
import {
  userInputActionsSchema,
  userInputOptionsSchema,
  userInputQuestionSchema,
} from './userInput';

/**
 * The normalized Copilot agent event stream (implementation-plan.md step 03,
 * docs/compatibility.md section 6).
 *
 * The SDK runtime emits roughly 135 raw event types, carries no monotonic
 * sequence number of its own (only a uuid `id`/`parentId` chain and a
 * timestamp), and its shapes are a versioned implementation detail - not a
 * contract we own. Forwarding a raw SDK event verbatim would (a) leak
 * whatever extra fields that version happens to carry, which
 * requirements-decisions.md section 2 forbids for anything beyond content
 * the user already has access to, and (b) couple every consumer to an SDK
 * version instead of to this module. So every event below is a deliberately
 * narrow, hand-picked projection: sixteen variants, each a `.strict()` object of
 * named fields, with no `unknown`/`Record<string, unknown>` escape hatch
 * anywhere in the tree. If a caller wants something this module does not
 * expose, that is a decision to revisit here, not a reason to reach past it.
 *
 * `sequence` is assigned by our own adapter at normalization time (per chat,
 * monotonically) precisely because the SDK does not provide one - see the
 * compatibility note above. It exists so a consumer can detect duplicate or
 * out-of-order delivery; `EventSequencer` below is that consumer.
 */

/**
 * Every event must be attributable to exactly one chat: an event that cannot
 * be routed to a chat cannot be delivered anywhere, displayed anywhere, or
 * deduplicated against anything. `chatId` and `sequence` are therefore on
 * every variant and are never optional. `turnId`/`messageId` are additionally
 * required on message-scoped variants and `toolCallId` on tool-scoped
 * variants, because those events are meaningless without knowing which
 * message or tool call they belong to.
 */
const eventSequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .describe('sequence');

const baseEventFields = {
  chatId: chatIdSchema,
  sequence: eventSequenceSchema,
};

/**
 * A tool's model-facing name, e.g. `aem_get_json`. Distinct from the SDK's
 * raw `tool.execution_start` payload, which - per docs/compatibility.md -
 * carries this under `data.toolName`, not `data.name`; getting that wrong
 * silently produces an "unknown" tool label. Normalizing here means every
 * consumer reads one field, spelled once, correctly.
 */
const toolNameSchema = z.string().min(1).max(200);

const REJECTION_REASON_MAX_LENGTH = 500;

/**
 * The most a progress note may say. Deliberately short: a progress line is a
 * glance, not a sentence, and an over-long one would be the only way a tool
 * could grow the event with arbitrary text.
 */
const PROGRESS_TEXT_MAX_LENGTH = 120;

/**
 * The text explaining why a tool call was rejected. Corresponds in spirit to
 * the SDK's own `feedback` field on a `{ kind: "reject" }` permission
 * decision (src/agent/toolPolicy.ts / `PermissionDecisionRequest`), but named
 * `reason` here because that is what a rejection event carries by contract,
 * independent of which SDK field happened to produce it.
 */
const rejectionReasonSchema = z.string().min(1).max(REJECTION_REASON_MAX_LENGTH);

/**
 * A JSON-serializable value, defined recursively over exactly the types JSON
 * can express. Used for tool arguments and tool result data instead of
 * `z.unknown()`/`z.record(z.string(), z.unknown())`: those would let an
 * arbitrary SDK object (functions, class instances, anything) pass straight
 * through unexamined, which is exactly what this module exists to prevent.
 * Every level of a `JsonValue` is validated; nothing is taken on faith.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const jsonPrimitiveSchema: z.ZodType<JsonPrimitive> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

const toolArgumentsSchema = z.record(z.string(), jsonValueSchema);

/**
 * The agent-visible streaming lifecycle of a chat, i.e. what its next
 * `session.state.changed` event may report. Defined here (not in
 * `sessionState.ts`) because it is itself the payload of one of this
 * module's event variants; `sessionState.ts` imports it from here instead of
 * the other way around, so the two modules do not import each other.
 */
export const SESSION_STREAM_STATES = [
  'idle',
  'sending',
  'streaming',
  'runningTool',
  'cancelling',
  'error',
  'closed',
] as const;

export type SessionStreamState = (typeof SESSION_STREAM_STATES)[number];

export const sessionStreamStateSchema = z.enum(SESSION_STREAM_STATES);

// --- Event variants -------------------------------------------------------

const assistantMessageStartedEventSchema = z
  .object({
    type: z.literal('assistant.message.started'),
    ...baseEventFields,
    turnId: turnIdSchema,
    messageId: messageIdSchema,
  })
  .strict();

/**
 * `delta` must be non-empty: an empty chunk carries no content and would
 * only complicate duplicate/gap reasoning (a genuinely duplicate empty delta
 * would be indistinguishable from two unrelated no-op deltas). Deltas are
 * INCREMENTAL (docs/compatibility.md), so folding them is order-sensitive -
 * see `foldTextDelta` below, which is why this event carries `sequence`
 * rather than assuming in-order delivery.
 */
const assistantTextDeltaEventSchema = z
  .object({
    type: z.literal('assistant.text.delta'),
    ...baseEventFields,
    turnId: turnIdSchema,
    messageId: messageIdSchema,
    delta: z.string().min(1),
  })
  .strict();

/**
 * `content` is the full, final message text. Per docs/compatibility.md this
 * must REPLACE any text accumulated from deltas, not be appended after it -
 * the renderer duplicates the message otherwise.
 */
const assistantMessageCompletedEventSchema = z
  .object({
    type: z.literal('assistant.message.completed'),
    ...baseEventFields,
    turnId: turnIdSchema,
    messageId: messageIdSchema,
    content: z.string(),
  })
  .strict();

/**
 * One incremental chunk of extended-thinking (reasoning) text for a block
 * identified by `reasoningId`. Mirrors `assistant.text.delta`'s INCREMENTAL
 * contract: chunks accumulate, they do not replace. `delta` is non-empty for
 * the same reason `assistant.text.delta.delta` is.
 *
 * The SDK marks the corresponding `assistant.reasoning_delta` event
 * `ephemeral: true` ("transient and not persisted to the session event log on
 * disk", docs/compatibility.md section 6), and this application extends that
 * rule to its own journal: neither reasoning variant is ever written to the
 * chat journal (`chatJournal.ts`), so reasoning is displayed in the moment
 * and then disappears rather than accumulating as durable history.
 */
const assistantReasoningDeltaEventSchema = z
  .object({
    type: z.literal('assistant.reasoning.delta'),
    ...baseEventFields,
    turnId: turnIdSchema,
    reasoningId: reasoningIdSchema,
    delta: z.string().min(1),
  })
  .strict();

/**
 * The complete text of one reasoning block, the counterpart of
 * `assistant.message.completed` for the reasoning stream. `content` is
 * authoritative and REPLACES the block's folded deltas. Its arrival means the
 * block has ended, which is what erases the transient "Thinking" billet in the
 * transcript - see `transcriptStore.ts`.
 */
const assistantReasoningCompletedEventSchema = z
  .object({
    type: z.literal('assistant.reasoning.completed'),
    ...baseEventFields,
    turnId: turnIdSchema,
    reasoningId: reasoningIdSchema,
    content: z.string(),
  })
  .strict();

const toolCallRequestedEventSchema = z
  .object({
    type: z.literal('tool.call.requested'),
    ...baseEventFields,
    toolCallId: toolCallIdSchema,
    toolName: toolNameSchema,
    arguments: toolArgumentsSchema,
  })
  .strict();
const toolCallApprovedEventSchema = z
  .object({
    type: z.literal('tool.call.approved'),
    ...baseEventFields,
    toolCallId: toolCallIdSchema,
  })
  .strict();

const toolCallRejectedEventSchema = z
  .object({
    type: z.literal('tool.call.rejected'),
    ...baseEventFields,
    toolCallId: toolCallIdSchema,
    reason: rejectionReasonSchema,
  })
  .strict();

const toolOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: jsonValueSchema }).strict(),
  z.object({ ok: z.literal(false), error: toolErrorSchema }).strict(),
]);

/**
 * Reuses `ToolError` (src/shared/contracts/errors.ts) for both the failure
 * branch here and the standalone `error` event below, per the plan's explicit
 * instruction not to invent a second error shape.
 */
const toolResultEventSchema = z
  .object({
    type: z.literal('tool.result'),
    ...baseEventFields,
    toolCallId: toolCallIdSchema,
    outcome: toolOutcomeSchema,
  })
  .strict();

/**
 * `turnId`/`toolCallId` are optional here: the SDK's underlying
 * `session.error` is a session-level signal that is not always attributable
 * to one turn or tool call (docs/compatibility.md). When the adapter does
 * know which turn or tool call was in flight, it should supply them so the
 * UI can attach the error to the right place instead of only a chat-wide banner.
 */
/**
 * A live, human-readable progress note for one in-flight tool call, e.g.
 * "Reading 12 of 20". The renderer shows it on that call's billet while the
 * call runs, so a tool that takes a while (reading the content of many AEM
 * hits) is visibly working rather than apparently stalled.
 *
 * Emitted by the application, not by an agent adapter: a tool executor reports
 * it through `ToolHost.reportToolProgress`, and the chat controller injects it
 * into the stream keyed to the tool call the executor belongs to. It is
 * deliberately transient - never written to the chat journal
 * (`chatJournal.ts`) - so it lives in the moment and is gone on replay, exactly
 * like the reasoning variants. Several calls can be in flight in one turn, so
 * it names the call it belongs to.
 */
const toolCallProgressEventSchema = z
  .object({
    type: z.literal('tool.call.progress'),
    ...baseEventFields,
    toolCallId: toolCallIdSchema,
    text: z.string().min(1).max(PROGRESS_TEXT_MAX_LENGTH),
  })
  .strict();

const errorEventSchema = z
  .object({
    type: z.literal('error'),
    ...baseEventFields,
    turnId: turnIdSchema.optional(),
    toolCallId: toolCallIdSchema.optional(),
    error: toolErrorSchema,
  })
  .strict();

/**
 * The agent asked the user to choose. Emitted by the agent adapter when the
 * `ask_user` tool is invoked, once its arguments are normalized; the turn stays
 * in `runningTool` until the matching `tool.result` carries the answer back to
 * the model.
 *
 * This is a first-class event rather than a side channel because both the
 * composer (which swaps its text field for the selection UI) and the transcript
 * (which shows the question and answer as messages) need it, and because the
 * deterministic fake must be able to emit it the same way a real adapter does.
 * `requestId` is what `respondToInput` correlates the answer with; `turnId`
 * lets the ownership guard drop a late question from a turn the user has since
 * abandoned. `multiple`/`freeInput` are required (already defaulted) so no
 * consumer re-decides what an omitted field meant. `question` is optional (an
 * actions-only prompt has none), and `actions` carries the one-click buttons a
 * prompt may offer instead of a text field.
 */
const userInputRequestedEventSchema = z
  .object({
    type: z.literal('user.input.requested'),
    ...baseEventFields,
    turnId: turnIdSchema,
    requestId: userInputRequestIdSchema,
    question: userInputQuestionSchema.optional(),
    options: userInputOptionsSchema.optional(),
    actions: userInputActionsSchema.optional(),
    multiple: z.boolean(),
    freeInput: z.boolean(),
  })
  .strict();

/**
 * Normalizes `session.start`/`session.idle`/`session.resume`/
 * `session.shutdown`/`assistant.turn_start`/`assistant.turn_end`
 * (docs/compatibility.md). `turnId` is optional because `session.start` and
 * `session.shutdown` are not scoped to a turn.
 */
const sessionStateChangedEventSchema = z
  .object({
    type: z.literal('session.state.changed'),
    ...baseEventFields,
    turnId: turnIdSchema.optional(),
    state: sessionStreamStateSchema,
  })
  .strict();

const metricSchema = z.number().nonnegative();
const diagnosticTextSchema = z.string().min(1).max(100);

/**
 * The model/reasoning effort the agent is *observed* to run on, emitted when it
 * is first known for an open chat and whenever it changes afterwards. A
 * diagnostics signal: no consumer derives state from it. `cause` says where the
 * value came from - the conversation was opened/resumed (`session-open`), the
 * adapter applied a Settings change at the start of a turn
 * (`preference-change`), or the agent runtime itself switched (`runtime-reported`,
 * e.g. an automatic rate-limit fallback). `turnId` is set when the change
 * happened while a turn was being prepared or ran.
 *
 * Contract for every agent: emit it at the start of a turn whenever the model or
 * effort differs from the last report (`createModelObserver`,
 * `src/shared/agents/modelObserver.ts`, implements that rule - adapters must not
 * re-derive it). An agent that cannot know its model yet stays silent.
 */
const modelChangedEventSchema = z
  .object({
    type: z.literal('model.changed'),
    ...baseEventFields,
    turnId: turnIdSchema.optional(),
    model: modelIdSchema,
    reasoningEffort: reasoningEffortSchema.optional(),
    previousModel: modelIdSchema.optional(),
    previousReasoningEffort: reasoningEffortSchema.optional(),
    cause: z.enum(['session-open', 'preference-change', 'runtime-reported']),
  })
  .strict();

/**
 * One finished model call of a turn: how long it took, when the first token
 * arrived, how many tokens it used. A turn with tool calls makes several. Every
 * metric is optional because neither agent reports all of them; absent means
 * "not reported", never zero.
 *
 * Contract for every agent: report per model call where the SDK exposes calls;
 * an SDK that only gives per-turn totals reports one aggregate event for the
 * turn (the journal sums events into the turn summary either way).
 */
const modelUsageEventSchema = z
  .object({
    type: z.literal('model.usage'),
    ...baseEventFields,
    turnId: turnIdSchema.optional(),
    model: modelIdSchema.optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    inputTokens: metricSchema.optional(),
    outputTokens: metricSchema.optional(),
    cacheReadTokens: metricSchema.optional(),
    cacheWriteTokens: metricSchema.optional(),
    reasoningTokens: metricSchema.optional(),
    cost: metricSchema.optional(),
    durationMs: metricSchema.optional(),
    timeToFirstTokenMs: metricSchema.optional(),
    finishReason: diagnosticTextSchema.optional(),
  })
  .strict();

/**
 * A model call that failed. Carries the structured facts only (which boundary
 * failed, the HTTP status, the provider's short error code) - never the
 * provider's free-text message, which can echo request content.
 *
 * Optional per agent: an SDK that reports a failed call only through the turn's
 * terminal `error` event (OpenRouter) need not emit this; the journal's turn
 * summary still records the turn as failed.
 */
const modelCallFailedEventSchema = z
  .object({
    type: z.literal('model.call.failed'),
    ...baseEventFields,
    turnId: turnIdSchema.optional(),
    model: modelIdSchema.optional(),
    failureKind: z.enum(['api', 'transport']).optional(),
    transport: z.enum(['http', 'websocket']).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    errorCode: diagnosticTextSchema.optional(),
    errorType: diagnosticTextSchema.optional(),
    durationMs: metricSchema.optional(),
  })
  .strict();

export const agentEventSchema = z.discriminatedUnion('type', [
  modelChangedEventSchema,
  modelUsageEventSchema,
  modelCallFailedEventSchema,
  assistantMessageStartedEventSchema,
  assistantTextDeltaEventSchema,
  assistantMessageCompletedEventSchema,
  assistantReasoningDeltaEventSchema,
  assistantReasoningCompletedEventSchema,
  toolCallRequestedEventSchema,
  toolCallApprovedEventSchema,
  toolCallRejectedEventSchema,
  toolResultEventSchema,
  toolCallProgressEventSchema,
  errorEventSchema,
  sessionStateChangedEventSchema,
  userInputRequestedEventSchema,
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AssistantMessageStartedEvent = z.infer<typeof assistantMessageStartedEventSchema>;
export type AssistantTextDeltaEvent = z.infer<typeof assistantTextDeltaEventSchema>;
export type AssistantMessageCompletedEvent = z.infer<typeof assistantMessageCompletedEventSchema>;
export type AssistantReasoningDeltaEvent = z.infer<typeof assistantReasoningDeltaEventSchema>;
export type AssistantReasoningCompletedEvent = z.infer<
  typeof assistantReasoningCompletedEventSchema
>;
export type ToolCallRequestedEvent = z.infer<typeof toolCallRequestedEventSchema>;
export type ToolCallApprovedEvent = z.infer<typeof toolCallApprovedEventSchema>;
export type ToolCallRejectedEvent = z.infer<typeof toolCallRejectedEventSchema>;
export type ToolResultEvent = z.infer<typeof toolResultEventSchema>;
export type ToolCallProgressEvent = z.infer<typeof toolCallProgressEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
export type SessionStateChangedEvent = z.infer<typeof sessionStateChangedEventSchema>;
export type UserInputRequestedEvent = z.infer<typeof userInputRequestedEventSchema>;
export type ModelChangedEvent = z.infer<typeof modelChangedEventSchema>;
export type ModelUsageEvent = z.infer<typeof modelUsageEventSchema>;
export type ModelCallFailedEvent = z.infer<typeof modelCallFailedEventSchema>;

/** Re-exported so a caller building a failure event does not need a second import. */
export type { ToolError };

// --- Sequencing: duplicate and gap detection ------------------------------

export type SequenceCheckOutcome =
  | { readonly kind: 'ok'; readonly sequence: number }
  | { readonly kind: 'duplicate'; readonly sequence: number }
  | { readonly kind: 'gap'; readonly expected: number; readonly received: number }
  | { readonly kind: 'gap_abandoned'; readonly from: number; readonly to: number };

/**
 * How far ahead of a chat's contiguous low-water mark an out-of-order
 * arrival is still tracked individually. `assistant.text.delta` fires once
 * per token, so an unbounded per-chat set would grow for as long as the
 * process runs; this bounds it to a fixed number of entries per chat
 * regardless of session length. 1024 comfortably covers realistic
 * reordering (a handful of concurrent tool calls, network reordering) while
 * keeping worst-case memory per chat small and constant.
 */
const DEFAULT_SEQUENCE_WINDOW_SIZE = 1024;

interface ChatSequenceState {
  /**
   * Every sequence number below this has been confirmed seen, exactly once,
   * as part of an unbroken run starting at whichever sequence this chat was
   * first observed at (see `createChatSequenceState`) - except across a
   * `gap_abandoned` boundary, where it means "no longer individually
   * accounted for", not "definitely seen". A later arrival below this mark
   * is always reported `duplicate`: either it truly was seen before, or its
   * loss has already been reported once via `gap_abandoned` and re-reporting
   * it forever would not tell the consumer anything new.
   */
  lowWaterMark: number;
  /** The highest sequence number seen so far, used only to detect a *new* forward jump as a gap. */
  highestSeen: number;
  /**
   * Out-of-order arrivals at or above `lowWaterMark`, waiting for the gap
   * below them to be filled so they can be folded into the low-water mark.
   * Bounded to `windowSize` entries: every member satisfies
   * `member - lowWaterMark <= windowSize`, so this set cannot grow without
   * bound even if the missing sequence never arrives - see `gap_abandoned`.
   */
  outOfOrder: Set<number>;
}

/**
 * The first sequence number this class ever observes for a chat becomes
 * that chat's baseline, not sequence 0. This class only watches a live
 * stream; it has no way to know what happened to a chat before it started
 * watching, so it must not assume "unseen so far" means "lost". Two
 * ordinary situations depend on this: a process restart resuming an
 * already-persisted chat (the sequencer starts fresh, but the chat's
 * sequence counter did not), and a straggler arriving after `release`
 * dropped the chat's state (also treated as a fresh start for that chat).
 * In both cases the honest answer is "nothing to report yet, start
 * tracking from here" - reporting a fabricated `gap_abandoned` covering
 * sequences that were simply never watched would be a false alarm, and the
 * class must never claim detection it cannot actually deliver.
 */
function createChatSequenceState(firstSequence: number): ChatSequenceState {
  return { lowWaterMark: firstSequence, highestSeen: firstSequence - 1, outOfOrder: new Set() };
}

/**
 * Detects duplicate and out-of-order delivery of normalized events.
 *
 * Sequence numbers are assigned per chat (see the module doc above), so
 * tracking is keyed by `chatId`: a single shared counter/state would treat
 * chat A's `sequence: 0` and chat B's `sequence: 0` as the same slot, which
 * would misreport unrelated chats as duplicating or gapping each other. This
 * class only *reports*; it never mutates or drops the event, and a gap does
 * not stop later sequence numbers from being tracked - a late arrival that
 * fills a previously reported gap is reported `ok`, not as a second gap.
 *
 * Memory is bounded per chat (`windowSize`, see `DEFAULT_SEQUENCE_WINDOW_SIZE`).
 * An arrival more than `windowSize` ahead of the chat's low-water mark means
 * the sequence(s) still missing below it can never be waited for any
 * longer without growing that bound without limit - so this class gives up
 * on them explicitly: it forcibly advances the low-water mark past the
 * abandoned range and reports `gap_abandoned` with that exact range, once.
 * The alternative - reporting every later arrival as anomalous for the rest
 * of the chat's life, which an earlier version of this class did - makes a
 * single lost event poison detection forever: a consumer either has to
 * ignore the anomaly (silently losing duplicate detection) or treat a
 * perfectly healthy stream as permanently broken. Neither is acceptable, so
 * this class instead resumes ordinary `ok`/`duplicate`/`gap` tracking
 * immediately after reporting the abandonment. `gap_abandoned` is lossy by
 * definition - the consumer is expected to surface or log it, since it means
 * the normalized event stream was incomplete for that chat.
 *
 * Per-chat state is retained for the process lifetime unless released.
 * Callers own chat lifecycle and must call `release(chatId)` once a chat is
 * closed or deleted (see `session.state.changed` with `state: "closed"`) -
 * this class has no way to know that on its own.
 *
 * The first sequence observed for a `chatId` establishes that chat's
 * baseline and is always reported `ok` (see `createChatSequenceState`).
 * Sequences lost *before* this class started watching a chat - whether
 * because the process just restarted and the chat's counter was already
 * running, or because a straggler arrived after `release` reset tracking -
 * are undetectable by design and this class does not pretend otherwise; it
 * only detects duplicates and gaps *within what it has observed*.
 */
export class EventSequencer {
  private readonly byChatId = new Map<string, ChatSequenceState>();
  private readonly windowSize: number;

  constructor(windowSize: number = DEFAULT_SEQUENCE_WINDOW_SIZE) {
    this.windowSize = windowSize;
  }

  check(event: Pick<AgentEvent, 'chatId' | 'sequence'>): SequenceCheckOutcome {
    const { chatId, sequence } = event;
    let state = this.byChatId.get(chatId);
    if (state === undefined) {
      state = createChatSequenceState(sequence);
      this.byChatId.set(chatId, state);
    }

    if (sequence < state.lowWaterMark) {
      return { kind: 'duplicate', sequence };
    }

    if (sequence === state.lowWaterMark) {
      state.lowWaterMark += 1;
      while (state.outOfOrder.delete(state.lowWaterMark)) {
        state.lowWaterMark += 1;
      }
      if (sequence > state.highestSeen) state.highestSeen = sequence;
      return { kind: 'ok', sequence };
    }

    if (state.outOfOrder.has(sequence)) {
      return { kind: 'duplicate', sequence };
    }

    if (sequence - state.lowWaterMark > this.windowSize) {
      return this.abandonGapAndAdmit(state, sequence);
    }

    const previousHighest = state.highestSeen;
    if (sequence > previousHighest) state.highestSeen = sequence;
    state.outOfOrder.add(sequence);

    if (sequence > previousHighest + 1) {
      return { kind: 'gap', expected: previousHighest + 1, received: sequence };
    }
    return { kind: 'ok', sequence };
  }

  /**
   * Handles a `sequence` too far past the low-water mark to track normally.
   * Reports the exact range being given up on once, then leaves the chat's
   * state fully caught up (as far as what is already known permits) so the
   * very next call resumes ordinary tracking instead of anomaly after
   * anomaly.
   */
  private abandonGapAndAdmit(state: ChatSequenceState, sequence: number): SequenceCheckOutcome {
    const from = state.lowWaterMark;
    const newLowWaterMark = sequence - this.windowSize;
    const to = newLowWaterMark - 1;

    for (const tracked of state.outOfOrder) {
      if (tracked < newLowWaterMark) state.outOfOrder.delete(tracked);
    }
    state.lowWaterMark = newLowWaterMark;
    while (state.outOfOrder.delete(state.lowWaterMark)) {
      state.lowWaterMark += 1;
    }

    if (sequence === state.lowWaterMark) {
      state.lowWaterMark += 1;
      while (state.outOfOrder.delete(state.lowWaterMark)) {
        state.lowWaterMark += 1;
      }
    } else if (sequence > state.lowWaterMark) {
      state.outOfOrder.add(sequence);
    }

    if (sequence > state.highestSeen) state.highestSeen = sequence;
    if (state.lowWaterMark - 1 > state.highestSeen) state.highestSeen = state.lowWaterMark - 1;

    return { kind: 'gap_abandoned', from, to };
  }

  /** Frees a chat's tracking state. Call once the chat closes - see the class doc above. */
  release(chatId: ChatId): void {
    this.byChatId.delete(chatId);
  }
}

// --- Delta folding ---------------------------------------------------------

/**
 * Accumulates `assistant.text.delta` events for one message into its full
 * text. Deltas are stored keyed by `sequence` rather than appended as they
 * arrive: consecutive deltas for the same message are not guaranteed
 * consecutive sequence numbers (other event types for the same chat can be
 * interleaved between them), so "sort what we have by sequence" is the only
 * correct reassembly rule - not "append on arrival" and not "wait for
 * sequence N+1". A duplicate delta (same sequence redelivered) simply
 * overwrites its own slot, so re-delivery cannot duplicate text.
 */
export interface DeltaFoldState {
  readonly messageId: MessageId;
  readonly chunks: ReadonlyMap<number, string>;
}

export function createDeltaFoldState(messageId: MessageId): DeltaFoldState {
  return { messageId, chunks: new Map() };
}

/** Pure: returns a new state and never mutates the one it was given. */
export function foldTextDelta(
  state: DeltaFoldState,
  event: AssistantTextDeltaEvent,
): DeltaFoldState {
  if (event.messageId !== state.messageId) {
    throw new Error(
      `foldTextDelta: delta for message "${event.messageId}" does not belong to fold state ` +
        `for message "${state.messageId}". Route deltas to the fold state matching their messageId`,
    );
  }
  const chunks = new Map(state.chunks);
  chunks.set(event.sequence, event.delta);
  return { messageId: state.messageId, chunks };
}

/** Renders the accumulated text in sequence order, regardless of arrival order. */
export function renderFoldedText(state: DeltaFoldState): string {
  return [...state.chunks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, delta]) => delta)
    .join('');
}
