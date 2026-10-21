import { createMessageStream, type MessageStream } from './messageStream';
import { DETERMINISTIC_TABLE_SKILLS } from './transcriptViewModel';
import {
  type AgentEvent,
  type InterruptionReason,
  type JsonValue,
  type MessageId,
  type ReasoningId,
  type ToolCallId,
  type ToolError,
  type TurnId,
  MEMO_REFLECTION_TOOL_NAME,
  SKILL_TOOL_NAME,
  asRecord,
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
  | { readonly kind: 'message'; readonly messageId: MessageId; readonly turnId: TurnId }
  | { readonly kind: 'toolCall'; readonly toolCallId: ToolCallId }
  | { readonly kind: 'thinking' }
  | {
      readonly kind: 'interruption';
      /** Stable per-notice id, so the view can cache one DOM node per notice across repaints. */
      readonly interruptionId: string;
      readonly reason: InterruptionReason;
      /**
       * Whether the notice may offer its Resume action. `true` only for a
       * notice the live pane recorded from this session's own `cancelling`
       * event; `false` for one replayed from the chat journal, which is
       * historical by definition (see `addInterruption`).
       */
      readonly resumable: boolean;
    };

export type ToolCallStatus =
  | { readonly kind: 'requested' }
  | { readonly kind: 'approved' }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'succeeded'; readonly data: JsonValue }
  | { readonly kind: 'failed'; readonly error: ToolError }
  /*
   * A call with no live turn owning it: the turn was interrupted (a Stop, or the
   * controller's navigation cancellation), the app closed mid-turn, or the turn
   * otherwise ended between `tool.call.requested` and any result. The executor's
   * state died with the turn - a call can never resume - so it is deliberately
   * NOT running: rendering it as a spinner would be a lie. A real result that
   * arrives afterwards still overwrites it, so a call that had actually finished
   * keeps its true outcome. Settled by `addInterruption`, a turn leaving the
   * in-flight state, and the journal replay's final sweep;
   * `describeToolCallStatus` labels it "Interrupted".
   */
  | { readonly kind: 'abandoned' }
  /*
   * A call the journal left unresolved because the turn was **waiting on the
   * user** - an unanswered `ask_user` question - when the app closed. Nothing
   * was in flight and nothing was interrupted, so it is deliberately distinct
   * from `abandoned`: the transcript shows no status word for it at all, only
   * the tool name and the settled icon (the same as a finished call, minus the
   * label). Only ever set while rebuilding a transcript from the journal
   * (`abandonRunningToolCalls(true)`).
   */
  | { readonly kind: 'abandonedAwaitingInput' };

export interface ToolCallView {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly args: Readonly<Record<string, JsonValue>>;
  readonly status: ToolCallStatus;
  /**
   * A transient, running-only progress note (e.g. "Reading 12 of 20") for a
   * call that reports one. Absent for a call that never does, and dropped the
   * moment the call settles - it is never shown beside a finished status.
   */
  readonly progress?: string;
}

/** The `tool.result` member of the agent-event union, for the settle-time helpers below. */
type ToolResultEvent = Extract<AgentEvent, { type: 'tool.result' }>;

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
  /**
   * Marks `turnId` as text-suppressed: no assistant `message` item is created
   * for it, so the model's own prose never appears in the transcript. Used for
   * a turn that invoked a search skill, whose answer is a `format_table`
   * message, not prose. Must be called before the turn's first message event
   * (the pane calls it immediately after `applyUserPrompt`, before any event
   * can arrive); a suppressed turn is suppressed on live events and on journal
   * replay alike.
   */
  markTurnSuppressed(turnId: TurnId): void;
  /**
   * The items the transcript should render now, in first-seen order. Durable
   * items are always included; the trailing `thinking` item is appended while
   * the model is reasoning with no tool call in flight (`isAwaitingUserInput`
   * and the running tool calls together decide that - see `thinkingVisible`).
   */
  items(): readonly TranscriptItem[];
  /** The current best-known text of an assistant message - see `MessageStream.textFor`. */
  textForMessage(messageId: MessageId): string;
  /** The exact text recorded by `applyUserPrompt` for `turnId`, or `""` if none was recorded. */
  textForUserPrompt(turnId: TurnId): string;
  /** The current view of one tool call, or `undefined` if `toolCallId` has not been observed. */
  toolCallFor(toolCallId: ToolCallId): ToolCallView | undefined;
  /**
   * Settles every call that still looks running (`requested`/`approved`) as
   * `abandoned`. Called once a journal replay finishes (see `journalReplay.ts`):
   * a rebuilt transcript has no live turn, so a call the journal left without a
   * result - the app closed mid-turn, or its turn was stopped - is not running
   * any more and can never resume. The journal's own `tool.call.abandoned`
   * record exists for exactly this distinction; this is what makes the
   * transcript honour it (and covers a hard exit that never wrote the record).
   * A no-op when nothing is running.
   *
   * It reads the stored statuses rather than the store's internal "is anything
   * running?" index, so it settles the calls even when some earlier step (an
   * interruption, a turn leaving the in-flight state) already emptied that
   * index. Every other path that ends a turn without a result applies the same
   * settle: `addInterruption` and `setTurnInFlight(false)`.
   *
   * `awaitingInput` distinguishes the one case where "abandoned" would be a lie:
   * the turn was blocked on an unanswered `ask_user` when the journal ended, so
   * nothing was in flight. Those calls settle as `abandonedAwaitingInput`, which
   * paints no status word - the call was not interrupted. Defaults to `false`
   * (the ordinary "the app closed while this was working" case).
   */
  abandonRunningToolCalls(awaitingInput?: boolean): void;
  /**
   * Clears the "counting" flag on every `format_table` call a journal replay
   * left mid-count, so a rebuilt transcript shows the fallback total with no
   * spinner. Called once a replay finishes (see `journalReplay.ts`). This is the
   * journal analogue of the composite's own settle call: a transcript reloaded
   * after a crash, or after a turn stopped while its background count was in
   * flight, must never spin forever. A no-op when no call is counting.
   */
  settlePendingTotals(): void;
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
   *
   * Leaving the in-flight state also settles every call still marked running as
   * `abandoned` (see `ToolCallStatus`): a turn can end without a result for its
   * call, and a billet must never keep a spinner for work no live turn owns.
   */
  setTurnInFlight(inFlight: boolean): void;
  /**
   * Marks whether the in-flight turn is blocked on an interactive question
   * (`ask_user`). The turn is formally still running, but it is waiting on the
   * user, not thinking, so the trailing "Thinking" billet is hidden for as
   * long as this is `true`. Driven by the pane from the same state that swaps
   * the composer into its selection UI.
   */
  setAwaitingUserInput(awaiting: boolean): void;
  /**
   * Whether the turn is currently blocked on an interactive question. Read by
   * the view on each repaint: nothing is actively working while the user is
   * being asked, so a *running* tool-call billet is hidden for as long as this
   * is `true` (the view decides which calls are billets, since only it knows a
   * tool's presentation), exactly as the "Thinking" item is.
   */
  isAwaitingUserInput(): boolean;
  /**
   * Appends a durable "the turn was interrupted" notice to the transcript.
   * Called by the pane when it observes the session enter `cancelling` - the
   * store never infers an interruption from the event stream itself, because
   * only the pane knows whether the user pressed Stop or an AEM-context change
   * aborted the turn (see `agentChatController.ts`). Marks the store dirty so a
   * throttled renderer repaints the new notice.
   *
   * `resumable` is `true` for a notice from the live session (the pane's own
   * call) and `false` for one replayed from the chat journal - a historical
   * notice must never offer its Resume action (see `journalReplay.ts`).
   *
   * Recording an interruption *also ends the work the turn had in flight*: every
   * call still marked running settles as `abandoned`, and a `format_table` still
   * counting loses its spinner. The interrupted turn cannot deliver those
   * results, so leaving them running would show progress that no longer exists -
   * live, and in a resumed transcript, where this record comes after the calls
   * it cancelled.
   */
  addInterruption(reason: InterruptionReason, resumable?: boolean): void;
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
  // Tool calls currently running (requested or approved). Tracked separately
  // from `toolCalls` so the transcript can ask "is anything actually working?"
  // in O(1) and can drop a call that an interruption abandoned without having
  // to invent a terminal status for it.
  const runningToolCalls = new Set<ToolCallId>();
  // Turns whose assistant prose is hidden (a search skill's turn, whose answer
  // is a `format_table` message). See `markTurnSuppressed`.
  const suppressedTurns = new Set<TurnId>();
  let dirty = false;
  // Monotonic id source for interruption notices, so each notice gets its own
  // cached DOM node in the view and two notices can never share a cache key.
  let interruptionSequence = 0;
  // The turn currently being answered, set by `applyUserPrompt`; used to
  // ignore a late text event belonging to a previous turn when deciding
  // whether the current turn has produced text yet.
  let currentTurnId: TurnId | undefined;
  // The turn the most recent turn-scoped event belonged to. Tool events carry
  // no `turnId`, so a tool call is attributed to this turn - which is how the
  // `memo_reflection` marker finds the application-started turn it opens (that
  // turn has no `applyUserPrompt`, so `currentTurnId` never names it).
  let lastEventTurnId: TurnId | undefined;
  // Whether the current turn still has no assistant text. Reset when the
  // user's prompt is recorded (a turn begins with no text) and cleared by the
  // first text event for that turn.
  let awaitingAssistantText = false;
  let turnInFlight = false;
  let awaitingUserInput = false;
  // The reasoning block currently being shown, if any. `activeReasoningId`
  // identifies the block (a delta for a different id starts a new one);
  // `reasoningText` is its accumulated text. Both are cleared the moment the
  // block ends - see `endReasoningBlock` - so reasoning never survives its
  // block.
  let activeReasoningId: ReasoningId | undefined;
  let reasoningText = '';

  /**
   * Whether any tool call in this conversation is still running. The transcript
   * shows exactly one "unfinished process" indicator at a time: a running tool
   * call supersedes the "Thinking" billet (see `thinkingVisible`), and while the
   * turn is blocked on an interactive question neither is shown.
   */
  function anyToolCallRunning(): boolean {
    return runningToolCalls.size > 0;
  }

  /**
   * The trailing "Thinking" billet is visible while a turn is in flight and
   * either no assistant text has arrived yet (the plain spinner + label) or a
   * reasoning block is being streamed (spinner + label + one rolling line).
   * The reasoning arm is what lets a later block reappear after an earlier one
   * ended, even though the turn has already produced text.
   *
   * Hidden while the turn waits on an interactive question, and hidden while a
   * tool call is running: "Thinking" means the model is reasoning with no
   * particular tool call in flight, and a running call "grabs the control" from
   * it, so the two never spin side by side.
   */
  function thinkingVisible(): boolean {
    return (
      turnInFlight &&
      !awaitingUserInput &&
      !anyToolCallRunning() &&
      (awaitingAssistantText || reasoningText.length > 0)
    );
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

  function ensureMessageItem(messageId: MessageId, turnId: TurnId): void {
    if (knownMessageIds.has(messageId)) return;
    // A suppressed turn keeps no assistant message item at all: the model's
    // prose for a search turn is replaced by the `format_table` message, and
    // suppressing at the source means the same rule holds live and on replay.
    if (suppressedTurns.has(turnId)) return;
    knownMessageIds.add(messageId);
    order.push({ kind: 'message', messageId, turnId });
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
    // Progress is running-only: once the call settles it is dropped, so it can
    // never be shown beside a completed/failed status (under
    // `exactOptionalPropertyTypes` an absent optional field is omitted, not set
    // to `undefined`).
    const stillRunning = status.kind === 'requested' || status.kind === 'approved';
    if (stillRunning) runningToolCalls.add(toolCallId);
    else runningToolCalls.delete(toolCallId);
    toolCalls.set(toolCallId, {
      toolCallId: existing.toolCallId,
      toolName: existing.toolName,
      args: existing.args,
      status,
      ...(stillRunning && existing.progress !== undefined ? { progress: existing.progress } : {}),
    });
    dirty = true;
  }

  /**
   * Settles every call whose *view* still says it is running (`requested` or
   * `approved`) with `status`, dropping its running-only progress.
   *
   * Derived from the stored statuses, deliberately not from the
   * `runningToolCalls` index: that set exists only to answer "is anything
   * working?" cheaply, and every path that empties it (an interruption, a turn
   * leaving the in-flight state) must settle the billets themselves. Trusting
   * the index is what let an interrupted call keep its spinner - an interruption
   * cleared the set, so the replay's final settle found nothing left to settle.
   *
   * Settling is not final: a real `tool.result` that arrives afterwards
   * overwrites the placeholder through `updateToolCallStatus`, so a call whose
   * executor had already finished still shows its true outcome.
   */
  function settleRunningToolCalls(status: ToolCallStatus): void {
    let changed = runningToolCalls.size > 0;
    for (const [toolCallId, view] of toolCalls) {
      if (view.status.kind !== 'requested' && view.status.kind !== 'approved') continue;
      // Rebuilt without `progress`: a running-only note is never shown beside a
      // settled status (under `exactOptionalPropertyTypes` it is omitted).
      toolCalls.set(toolCallId, {
        toolCallId,
        toolName: view.toolName,
        args: view.args,
        status,
      });
      changed = true;
    }
    runningToolCalls.clear();
    if (changed) dirty = true;
  }

  /**
   * Clears the "counting" flag on every `format_table` call, so no total line
   * keeps a spinner for a count that died with its turn. Returns whether
   * anything changed (the caller owns the dirty flag).
   */
  function settleCountingTotals(): boolean {
    let changed = false;
    for (const [toolCallId, view] of toolCalls) {
      if (view.args['totalPending'] !== true) continue;
      // A replayed or interrupted `format_table` whose result never arrived is
      // rewritten as a settled one: the table keeps its last total line and
      // loses the spinner. The args are the renderer's only source of the flag
      // (see `format-table/renderer`'s `readTableMessage`).
      toolCalls.set(toolCallId, { ...view, args: { ...view.args, totalPending: false } });
      changed = true;
    }
    return changed;
  }

  /**
   * Records a transient progress note on an already-known tool call. A note for
   * a call this store never saw `requested` for is dropped, exactly as
   * `updateToolCallStatus` drops an orphan status update.
   */
  function setToolCallProgress(toolCallId: ToolCallId, text: string): void {
    const existing = toolCalls.get(toolCallId);
    if (existing === undefined || existing.progress === text) return;
    toolCalls.set(toolCallId, { ...existing, progress: text });
    dirty = true;
  }

  /**
   * Decides, on settle, whether a `skill` call becomes a visible billet.
   *
   * A skill the model chose to load is real work: a reader investigating why a
   * session went wrong must be able to tell whether one was loaded at all, and
   * which. An explicit `/name` prompt is different - the user's own message
   * already names the skill - so the controller records it as a synthetic
   * `skill` call whose result says `activatedBy: 'user'` (see
   * `agentChatController.ts`), and that call stays out of the transcript.
   *
   * The item is created here rather than on `requested` because the two are
   * only distinguishable once the result arrives; nothing else is interleaved
   * between a tool call's request and its result, so appending at settle keeps
   * the transcript order intact.
   */
  function revealSkillLoad(event: ToolResultEvent): void {
    const call = toolCalls.get(event.toolCallId);
    if (call === undefined || call.toolName !== SKILL_TOOL_NAME) return;
    const data = event.outcome.ok ? asRecord(event.outcome.data) : undefined;
    if (data?.['activatedBy'] === 'user') {
      // The application's own marker for an explicit `/name` turn: drop the
      // call entirely so `toolCallFor` cannot hand the view something the
      // transcript never shows.
      toolCalls.delete(event.toolCallId);
      return;
    }
    ensureToolCallItem(event.toolCallId);
  }

  /**
   * Marks `turnId` as text-suppressed, removing any assistant `message` item it
   * has already created. Idempotent: a second call (the pane's `markTurnSuppressed`
   * followed by the turn's own `skill` call, say) is a no-op.
   */
  function suppressTurn(turnId: TurnId): void {
    if (suppressedTurns.has(turnId)) return;
    suppressedTurns.add(turnId);
    // Suppression is normally recorded before the turn's first event (the pane
    // marks an explicit `/search` on send), but the model choosing a skill on
    // its own can only be known from its `skill` call mid-turn. Any message item
    // already created for this turn is removed here so the invariant - a
    // suppressed turn has no assistant message - holds regardless of ordering.
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const item = order[index];
      if (item?.kind === 'message' && item.turnId === turnId) {
        knownMessageIds.delete(item.messageId);
        order.splice(index, 1);
      }
    }
    dirty = true;
  }

  return {
    applyEvent(event) {
      messageStream.applyEvent(event);
      if ('turnId' in event && event.turnId !== undefined) lastEventTurnId = event.turnId;
      switch (event.type) {
        case 'assistant.message.started':
          ensureMessageItem(event.messageId, event.turnId);
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
          ensureMessageItem(event.messageId, event.turnId);
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
          // A skill load is a visible billet when the model chose it (see
          // `revealSkillLoad`), so a reader can tell whether a skill was loaded
          // and which one. Its one immediate transcript effect is that a skill
          // whose answer *is* its own rendered output (a search skill's table)
          // suppresses this turn's prose, so a skill the model chose on its own
          // is handled exactly like `/search` (see `suppressTurn`). It is
          // emitted by both agents under this exact name (see
          // `src/shared/skillInvocation.ts`).
          if (event.toolName === SKILL_TOOL_NAME) {
            const skillName = event.arguments['name'];
            if (
              typeof skillName === 'string' &&
              DETERMINISTIC_TABLE_SKILLS.includes(skillName) &&
              currentTurnId !== undefined
            ) {
              suppressTurn(currentTurnId);
            }
            // Recorded but not yet shown: whether this is a model-chosen load or
            // the controller's marker for an explicit `/name` prompt is only
            // known from its result.
            runningToolCalls.add(event.toolCallId);
            toolCalls.set(event.toolCallId, {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.arguments,
              status: { kind: 'requested' },
            });
            dirty = true;
            return;
          }
          // An automatic reflection turn is the application's, not the user's:
          // its billet stays (it is the reader's only sign the turn ran), but
          // the model's prose in it is not an answer to anything they asked.
          if (event.toolName === MEMO_REFLECTION_TOOL_NAME && lastEventTurnId !== undefined) {
            suppressTurn(lastEventTurnId);
          }
          ensureToolCallItem(event.toolCallId);
          runningToolCalls.add(event.toolCallId);
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
          revealSkillLoad(event);
          return;
        case 'tool.call.progress':
          // A running-only status line - never its own transcript item, it just
          // annotates the tool call's billet (see `ToolCallView.progress`).
          setToolCallProgress(event.toolCallId, event.text);
          return;
        case 'error':
        case 'session.state.changed':
        case 'user.input.requested':
        case 'user.input.actions.added':
        case 'model.changed':
        case 'model.usage':
        case 'model.call.failed':
          // Signals with no transcript item of their own:
          // `error` surfaces via the composer's disabled-reason notice
          // (`composerViewModel.ts`, driven by `SessionStatus.state`), and
          // `session.state.changed` only ever drives that same
          // `SessionStatus`, which `chatPane.ts` derives independently. An
          // ask-user question is likewise not a transcript item of its own:
          // the question and its answer are rendered as messages by the
          // `ask_user` tool's own `presentation: 'conversation'` (see
          // `transcriptView.ts`), derived from that tool call's arguments and
          // result - so the composer, not this store, is what reacts to this
          // event.
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
    markTurnSuppressed(turnId) {
      suppressTurn(turnId);
    },
    setTurnInFlight(inFlight) {
      if (turnInFlight === inFlight) return;
      turnInFlight = inFlight;
      // A turn that is no longer in flight has nothing running: settle any call
      // an interruption or a lost result abandoned - a billet must never keep a
      // spinner for work no live turn owns.
      if (!inFlight) settleRunningToolCalls({ kind: 'abandoned' });
      dirty = true;
    },
    setAwaitingUserInput(awaiting) {
      if (awaitingUserInput === awaiting) return;
      awaitingUserInput = awaiting;
      dirty = true;
    },
    addInterruption(reason, resumable = true) {
      interruptionSequence += 1;
      // The turn was stopped: the calls it had in flight are over, so they are
      // settled as interrupted rather than left with a spinner. This is also
      // what makes a journal replay honest - the interruption record comes
      // *after* the calls it cancelled, so settling here (not only in the
      // replay's final sweep) is what a resumed transcript shows.
      settleRunningToolCalls({ kind: 'abandoned' });
      // A `format_table` still counting has lost its count with the turn: its
      // total line falls back to the last total it showed, with no spinner.
      if (settleCountingTotals()) dirty = true;
      order.push({
        kind: 'interruption',
        interruptionId: `interruption-${interruptionSequence}`,
        reason,
        resumable,
      });
      dirty = true;
    },
    items() {
      if (!thinkingVisible()) return order;
      const thinkingItem: TranscriptItem = { kind: 'thinking' };
      return [...order, thinkingItem];
    },
    isAwaitingUserInput() {
      return awaitingUserInput;
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
    abandonRunningToolCalls(awaitingInput = false) {
      // `awaitingInput` is the one case where "interrupted" would be a lie: the
      // turn was blocked on an unanswered question, so nothing was in flight.
      settleRunningToolCalls(
        awaitingInput ? { kind: 'abandonedAwaitingInput' } : { kind: 'abandoned' },
      );
    },
    settlePendingTotals() {
      if (settleCountingTotals()) dirty = true;
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
        suppressedTurns.size > 0 ||
        turnInFlight ||
        awaitingUserInput ||
        awaitingAssistantText;
      order.length = 0;
      knownMessageIds.clear();
      knownToolCallIds.clear();
      userPrompts.clear();
      toolCalls.clear();
      runningToolCalls.clear();
      suppressedTurns.clear();
      currentTurnId = undefined;
      lastEventTurnId = undefined;
      awaitingAssistantText = false;
      turnInFlight = false;
      awaitingUserInput = false;
      activeReasoningId = undefined;
      reasoningText = '';
      interruptionSequence = 0;
      messageStream.clear();
      if (hadContent) dirty = true;
    },
  };
}
