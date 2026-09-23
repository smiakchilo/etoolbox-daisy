import { createMessageStream, type MessageStream } from './messageStream';
import type {
  AgentEvent,
  JsonValue,
  MessageId,
  ReasoningId,
  ToolCallId,
  ToolError,
  TurnId,
} from '../../../shared';

/**
 * One transcript entry in first-seen order. A user's own prompt is not part
 * of the `AgentEvent` stream at all (the renderer is the only place that
 * knows the exact text it sent - see `applyUserPrompt`), so it is its own
 * item kind alongside assistant messages and tool calls, not folded into
 * either.
 *
 * Tool calls are tracked independently of messages and appear in `items()`
 * from the moment `tool.call.requested` arrives, regardless of whether the
 * turn's message ever receives any text - this is what makes tool lifecycle
 * display independent of the model returning text (implementation-plan.md
 * step 07).
 */
export type TranscriptItem =
  | { readonly kind: 'userPrompt'; readonly turnId: TurnId }
  | { readonly kind: 'message'; readonly messageId: MessageId }
  | { readonly kind: 'toolCall'; readonly toolCallId: ToolCallId }
  | { readonly kind: 'thinking' };

export type ToolCallStatus =
  | { readonly kind: 'requested' }
  | { readonly kind: 'approved' }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'succeeded'; readonly data: JsonValue }
  | { readonly kind: 'failed'; readonly error: ToolError };

export interface ToolCallView {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly args: Readonly<Record<string, JsonValue>>;
  readonly status: ToolCallStatus;
}

export interface TranscriptStore {
  /** Feeds one normalized agent event into the transcript's view state. */
  applyEvent(event: AgentEvent): void;
  /**
   * Records the user's own prompt for `turnId` as a transcript item. Must be
   * called once, right after a successful `sendMessage` resolves with that
   * `turnId` - there is no `AgentEvent` for a user's own message, so this is
   * the only place that text is ever known.
   */
  applyUserPrompt(turnId: TurnId, prompt: string): void;
  /** Every transcript item observed so far, in first-seen order. */
  items(): readonly TranscriptItem[];
  /** The current best-known text of an assistant message - see `MessageStream.textFor`. */
  textForMessage(messageId: MessageId): string;
  /** The exact text recorded by `applyUserPrompt` for `turnId`, or `""` if none was recorded. */
  textForUserPrompt(turnId: TurnId): string;
  /** The current view of one tool call, or `undefined` if `toolCallId` has not been observed. */
  toolCallFor(toolCallId: ToolCallId): ToolCallView | undefined;
  /**
   * The reasoning text of the transient "Thinking" billet, or `""` when none
   * is being shown. Reasoning never becomes a transcript item of its own - the
   * `thinking` item carries no text - so this is the view's only way to read
   * it. It deliberately returns `""` the moment the block ends (see
   * `applyEvent`), which is what makes the billet disappear rather than
   * accumulate as durable history.
   */
  thinkingReasoning(): string;
  /**
   * Marks whether a turn is currently in flight. The transcript shows a
   * trailing `thinking` item while this is `true` AND either the current turn
   * has not yet produced any assistant text - the moment the first
   * `assistant.text.delta`/`assistant.message.completed` arrives, the plain
   * indicator disappears for the rest of the turn - or a reasoning block is
   * being streamed (`assistant.reasoning.delta`), which can bring the item
   * back with a rolling line even after text has appeared. Callers should
   * drive this from the same state the composer's Stop button uses
   * (`composerViewModel.ts`'s `isTurnInFlight`), so the two can never
   * disagree.
   */
  setTurnInFlight(inFlight: boolean): void;
  /** Edge-triggered change flag, same contract as `MessageStream.takeDirty`. */
  takeDirty(): boolean;
  /**
   * Empties the transcript: every item, every recorded prompt, and every
   * tool call is dropped, and the trailing `thinking` indicator is reset.
   * This is what "New session" needs - a genuinely clean view state, not a
   * second conversation layered on top of the previous one's items. Marks
   * the store dirty so a throttled renderer repaints the empty transcript.
   */
  clear(): void;
}

/** Creates an empty transcript store with no items observed yet. */
export function createTranscriptStore(
  messageStream: MessageStream = createMessageStream(),
): TranscriptStore {
  const order: TranscriptItem[] = [];
  const knownMessageIds = new Set<MessageId>();
  const knownToolCallIds = new Set<ToolCallId>();
  const userPrompts = new Map<TurnId, string>();
  const toolCalls = new Map<ToolCallId, ToolCallView>();
  let dirty = false;
  // The turn currently being answered, set by `applyUserPrompt`; used to
  // ignore a late text event belonging to a previous turn when deciding
  // whether the current turn has produced text yet.
  let currentTurnId: TurnId | undefined;
  // Whether the current turn still has no assistant text. Reset when the
  // user's prompt is recorded (a turn begins with no text) and cleared by the
  // first text event for that turn.
  let awaitingAssistantText = false;
  let turnInFlight = false;
  // The reasoning block currently being shown, if any. `activeReasoningId`
  // identifies the block (a delta for a different id starts a new one);
  // `reasoningText` is its accumulated text. Both are cleared the moment the
  // block ends - see `endReasoningBlock` - so reasoning never survives its
  // block.
  let activeReasoningId: ReasoningId | undefined;
  let reasoningText = '';

  /**
   * The trailing "Thinking" billet is visible while a turn is in flight and
   * either no assistant text has arrived yet (the plain spinner + label) or a
   * reasoning block is being streamed (spinner + label + one rolling line).
   * The reasoning arm is what lets a later block reappear after an earlier one
   * ended, even though the turn has already produced text.
   */
  function thinkingVisible(): boolean {
    return turnInFlight && (awaitingAssistantText || reasoningText.length > 0);
  }

  /**
   * Ends the current reasoning block, discarding its text. Called when the
   * block's own `assistant.reasoning.completed` arrives, and when the
   * assistant moves on to text or a tool call - either way the block is over,
   * so the transient billet must not linger.
   */
  function endReasoningBlock(): void {
    if (activeReasoningId === undefined && reasoningText === '') return;
    activeReasoningId = undefined;
    reasoningText = '';
    dirty = true;
  }

  function setAwaitingAssistantText(next: boolean): void {
    if (awaitingAssistantText === next) return;
    awaitingAssistantText = next;
    dirty = true;
  }

  function ensureMessageItem(messageId: MessageId): void {
    if (knownMessageIds.has(messageId)) return;
    knownMessageIds.add(messageId);
    order.push({ kind: 'message', messageId });
    dirty = true;
  }

  function ensureToolCallItem(toolCallId: ToolCallId): void {
    if (knownToolCallIds.has(toolCallId)) return;
    knownToolCallIds.add(toolCallId);
    order.push({ kind: 'toolCall', toolCallId });
    dirty = true;
  }

  function updateToolCallStatus(toolCallId: ToolCallId, status: ToolCallStatus): void {
    const existing = toolCalls.get(toolCallId);
    // A status update for a tool call this store never saw `requested` for
    // carries no name/arguments to display and is dropped rather than
    // fabricating a stub entry - this should not happen for an
    // ownership-guarded event stream (see `agentChatController.ts`), but
    // this store does not assume that guarantee holds.
    if (existing === undefined) return;
    toolCalls.set(toolCallId, { ...existing, status });
    dirty = true;
  }

  return {
    applyEvent(event) {
      messageStream.applyEvent(event);
      switch (event.type) {
        case 'assistant.message.started':
          ensureMessageItem(event.messageId);
          return;
        case 'assistant.text.delta':
        case 'assistant.message.completed':
          // The first text of the current turn ends the "Thinking" phase. A
          // late text event belonging to a previous turn must not silence the
          // indicator for a turn that has not spoken yet.
          if (currentTurnId === undefined || event.turnId === currentTurnId) {
            setAwaitingAssistantText(false);
          }
          // The assistant moving on to real output also ends any reasoning
          // block still on screen.
          endReasoningBlock();
          ensureMessageItem(event.messageId);
          return;
        case 'assistant.reasoning.delta':
          if (activeReasoningId === event.reasoningId) {
            reasoningText += event.delta;
          } else {
            // A delta for a different block id starts a new block; the previous
            // one is over by definition.
            activeReasoningId = event.reasoningId;
            reasoningText = event.delta;
          }
          dirty = true;
          return;
        case 'assistant.reasoning.completed':
          if (activeReasoningId === event.reasoningId) endReasoningBlock();
          return;
        case 'tool.call.requested':
          // A tool call ends the reasoning block that preceded it, exactly as
          // assistant text does.
          endReasoningBlock();
          ensureToolCallItem(event.toolCallId);
          toolCalls.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.arguments,
            status: { kind: 'requested' },
          });
          dirty = true;
          return;
        case 'tool.call.approved':
          updateToolCallStatus(event.toolCallId, { kind: 'approved' });
          return;
        case 'tool.call.rejected':
          updateToolCallStatus(event.toolCallId, { kind: 'rejected', reason: event.reason });
          return;
        case 'tool.result':
          // The mandatory anti-regression check: `outcome.ok` decides
          // succeeded vs. failed here, and nowhere else - a failed tool call
          // must render as FAILED (implementation-plan.md step 07), never as
          // a completed one.
          updateToolCallStatus(
            event.toolCallId,
            event.outcome.ok
              ? { kind: 'succeeded', data: event.outcome.data }
              : { kind: 'failed', error: event.outcome.error },
          );
          return;
        case 'error':
        case 'session.state.changed':
          // Chat/turn-level signals with no transcript item of their own:
          // `error` surfaces via the composer's disabled-reason notice
          // (`composerViewModel.ts`, driven by `SessionStatus.state`), and
          // `session.state.changed` only ever drives that same
          // `SessionStatus`, which `chatPane.ts` derives independently.
          return;
        default: {
          return event;
        }
      }
    },
    applyUserPrompt(turnId, prompt) {
      if (!userPrompts.has(turnId)) {
        order.push({ kind: 'userPrompt', turnId });
      }
      userPrompts.set(turnId, prompt);
      // A new turn begins with no assistant text yet - see
      // `awaitingAssistantText`'s doc comment.
      currentTurnId = turnId;
      awaitingAssistantText = true;
      dirty = true;
    },
    setTurnInFlight(inFlight) {
      if (turnInFlight === inFlight) return;
      turnInFlight = inFlight;
      dirty = true;
    },
    items() {
      if (!thinkingVisible()) return order;
      const thinkingItem: TranscriptItem = { kind: 'thinking' };
      return [...order, thinkingItem];
    },
    textForMessage(messageId) {
      return messageStream.textFor(messageId);
    },
    textForUserPrompt(turnId) {
      return userPrompts.get(turnId) ?? '';
    },
    toolCallFor(toolCallId) {
      return toolCalls.get(toolCallId);
    },
    thinkingReasoning() {
      return thinkingVisible() ? reasoningText : '';
    },
    takeDirty() {
      // `messageStream`'s own dirty flag must always be read (it clears on
      // read), even once this store already knows it is dirty for its own
      // reasons - otherwise a delta-only change would never be reflected in
      // this store's own edge-triggered flag on a later call once no other
      // change accompanies it.
      const streamDirty = messageStream.takeDirty();
      const wasDirty = dirty || streamDirty;
      dirty = false;
      return wasDirty;
    },
    clear() {
      const hadContent =
        order.length > 0 ||
        userPrompts.size > 0 ||
        toolCalls.size > 0 ||
        turnInFlight ||
        awaitingAssistantText;
      order.length = 0;
      knownMessageIds.clear();
      knownToolCallIds.clear();
      userPrompts.clear();
      toolCalls.clear();
      currentTurnId = undefined;
      awaitingAssistantText = false;
      turnInFlight = false;
      activeReasoningId = undefined;
      reasoningText = '';
      messageStream.clear();
      if (hadContent) dirty = true;
    },
  };
}
