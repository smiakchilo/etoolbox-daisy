import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentEvent,
  type ChatId,
  type ChatJournalHeaderRecord,
  type ChatJournalRecord,
  type ChatJournalTurnSummaryRecord,
  CHAT_JOURNAL_SCHEMA_VERSION,
  chatJournalRecordSchema,
  createDeltaFoldState,
  type DeltaFoldState,
  foldTextDelta,
  type InterruptionReason,
  type MessageId,
  renderFoldedText,
  type SessionId,
  type ServerId,
  type ToolCallId,
  type TurnId,
  type TurnOutcome,
} from '../shared';
import { readChatSessionIds } from './chatJournalReader';
import { toChatFileName } from './chatJournalPaths';

/**
 * The append-only chat journal writer (implementation-plan.md step 09).
 *
 * One JSON Lines file per application `ChatId` under
 * `<home>/etoolbox-daisy/chats`, described by the record schemas in
 * `src/shared/contracts/chatJournal.ts`. A file appears only once a chat has
 * produced its first record: `openChat` defers the `header` line (see
 * {@link ChatJournal.openChat}), so opening a conversation and never using it
 * leaves no file behind. Kept Electron-free - the directory is
 * a plain injected string - so it is unit-testable under plain vitest, exactly
 * like `logger.ts`.
 *
 * WRITES ARE SYNCHRONOUS, BUT NOT PER DELTA. Each structural record is
 * `appendFileSync`-ed so it is durable before the call returns, matching
 * `logger.ts`. Per-token `assistant.text.delta` events are deliberately *not*
 * written as lines: they are folded in memory (`foldTextDelta`/
 * `renderFoldedText`) and surfaced once as an `assistant.message.partial`
 * record if the turn ends before `assistant.message.completed` arrives. That is
 * what satisfies the plan's "do not perform a synchronous filesystem write for
 * every delta" without losing an interrupted turn's partial text.
 *
 * The journal never throws to its caller: a filesystem failure, an invalid
 * record, or an event for a chat that was never opened degrades into a counter
 * on {@link ChatJournal.getHealth} plus one stderr line, so a full disk cannot
 * take down a live conversation.
 */

export interface ChatJournalOpenParams {
  readonly chatId: ChatId;
  readonly sessionId: SessionId;
  /** The AEM server the chat is bound to, if one was selected when it opened. */
  readonly serverId?: ServerId;
}

export interface ChatJournalUserPromptParams {
  readonly chatId: ChatId;
  readonly turnId: TurnId;
  readonly prompt: string;
  /** The current-page block the model read besides the prompt, when there was one. */
  readonly pageContext?: string | undefined;
  /** `'reflection'` for the application's own post-turn reflection prompt (see the record schema). */
  readonly origin?: 'reflection';
  /**
   * The AEM host the pane was on when this prompt was sent, if any. The first
   * prompt that names one is what gives a chat opened with no host its host (see
   * the record schema's own doc), and it is stored on the record as diagnostics.
   */
  readonly serverId?: ServerId | undefined;
}

export interface ChatJournalInterruptionParams {
  readonly chatId: ChatId;
  readonly reason: InterruptionReason;
}

export interface ChatJournalHealth {
  /** Records that did not reach disk, for any reason. */
  readonly writeFailureCount: number;
  /** Events/prompts observed for a chat with no open journal file. */
  readonly droppedRecordCount: number;
  /** The `fs` error code, or an internal reason such as `"INVALID_RECORD"`. */
  readonly lastFailureCode: string | null;
}

export interface ChatJournal {
  /**
   * Opens `chatId`'s journal. The `header` record is written just before this
   * chat's first real record, not at open time, so a chat that is opened and
   * never used leaves no file on disk; whatever records follow are appended
   * after it. A resumed chat (the file already has content) appends to its
   * existing journal without a second header, and an open under an SDK session
   * it has not recorded before adds a `session.opened` record, so every session
   * a chat was ever opened with is recorded for deletion. A second call for an
   * already-open chat under a known session id is a no-op.
   */
  openChat(params: ChatJournalOpenParams): void;
  /**
   * Stages the user's prompt for `turnId`. It is not written yet: the journal
   * flushes it immediately *before* the first event that carries the same
   * `turnId`, so the prompt always precedes the turn's own events while a
   * prompt whose turn never started is never written at all.
   */
  recordUserPrompt(params: ChatJournalUserPromptParams): void;
  /** Drops a staged prompt whose turn never started (a failed `sendPrompt`). */
  discardUserPrompt(chatId: ChatId, turnId: TurnId): void;
  /** Journals one normalized event; deltas are folded, everything else is written. */
  recordEvent(event: AgentEvent): void;
  /**
   * Journals a durable "this turn was interrupted" notice for a Stop or an
   * AEM-context abort. Written by the controller once it has observed the
   * turn's own `cancelling`/`idle` events, so the notice lands after them and a
   * resumed chat replays it in order. Dropped when the chat has no open file.
   */
  recordInterruption(params: ChatJournalInterruptionParams): void;
  /** Finalizes any partial message and writes the `chat.closed` marker. A chat that never wrote a record (opened but unused) writes nothing. */
  closeChat(chatId: ChatId): void;
  getHealth(): ChatJournalHealth;
}

export interface ChatJournalOptions {
  /** Injectable clock so tests get deterministic `at`/`startedAt` values. */
  readonly now?: () => number;
  /** Called with every `turn.summary` the journal writes (also when the write itself failed), so the application log can carry the same timings. */
  readonly onTurnSummary?: (record: ChatJournalTurnSummaryRecord) => void;
}

interface MessageFold {
  readonly turnId: TurnId;
  readonly fold: DeltaFoldState;
}

/** A tool call requested (and possibly approved) but with no result yet. */
interface OutstandingToolCall {
  readonly toolName: string;
  readonly turnId?: TurnId;
}

/**
 * What the journal has observed of the turn in flight, folded into one
 * `turn.summary` record when the turn ends. Timestamps are the journal's own
 * clock, so the summary needs nothing from an adapter.
 */
interface TurnAccumulator {
  readonly turnId: TurnId;
  readonly startedAt: number;
  firstActivityAt?: number;
  firstTextAt?: number;
  /** When each unresolved tool call was requested; an `ask_user` call therefore counts the user's thinking time. */
  readonly toolStartedAt: Map<ToolCallId, number>;
  toolCallCount: number;
  toolDurationMs: number;
  modelCallCount: number;
  modelCallFailureCount: number;
  model?: string;
  reasoningEffort?: string;
  finishReason?: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  cost?: number | undefined;
  cancelled: boolean;
}

interface OpenChat {
  readonly filePath: string;
  /**
   * The `header` record to write immediately before this chat's first real
   * record, or `undefined` once it has been written (or when the journal was
   * opened over a file that already had content). Deferring it is what keeps an
   * opened-but-unused conversation from ever creating a file.
   */
  pendingHeader?: ChatJournalHeaderRecord;
  /**
   * Every SDK session id this chat has been opened with and recorded (or is
   * about to record, via `pendingHeader`), seeded from the journal when a chat
   * is resumed. A runtime recycle re-opens the same chat under a new session
   * while this state is still held; comparing against this set is what turns
   * that into a `session.opened` record so deletion can remove every session.
   */
  readonly recordedSessionIds: Set<SessionId>;
  /** Folded deltas per assistant message, plus the turn each belongs to. */
  readonly foldsByMessageId: Map<MessageId, MessageFold>;
  readonly completedMessageIds: Set<MessageId>;
  /** Tool calls seen but not yet resolved by a `tool.result`/`tool.call.rejected`. */
  readonly outstandingToolCalls: Map<ToolCallId, OutstandingToolCall>;
  /**
   * The turn the most recent turn-scoped event belonged to, used to tag an
   * abandoned tool call. Tool events carry no `turnId` of their own, so this is
   * read from the preceding `session.state.changed`/message event.
   */
  currentTurnId?: TurnId;
  /** At most one prompt is staged: main owns one active turn per chat. `at` is when it was staged, the start of the turn's timings. */
  pendingPrompt?: {
    readonly turnId: TurnId;
    readonly prompt: string;
    readonly pageContext?: string;
    readonly serverId?: ServerId;
    readonly origin?: 'reflection';
    readonly at: number;
  };
  /** The turn being timed, from its first event until its terminal one. */
  turn?: TurnAccumulator;
}

/** Extracts a Node `fs` error's `.code` without ever touching `.message`. */
function extractErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = error.code;
    if (typeof value === 'string') return value;
  }
  return 'UNKNOWN';
}

/** True when the journal file already holds at least one record (a resumed chat). */
function fileHasContent(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Whether `event` ends the turn it belongs to, i.e. the point at which any
 * still-unfinished assistant text must be persisted as a partial message.
 * `cancelling` is deliberately excluded - it is a request to stop, and the
 * turn's text is not final until `idle` arrives.
 */
function isTurnEnd(event: AgentEvent): boolean {
  if (event.type === 'error') return true;
  return (
    event.type === 'session.state.changed' &&
    (event.state === 'idle' || event.state === 'error' || event.state === 'closed')
  );
}

/** Sums an optional metric: absent stays absent until something reports it. */
function addMetric(total: number | undefined, value: number | undefined): number | undefined {
  if (value === undefined) return total;
  return (total ?? 0) + value;
}

/** How a turn-ending event ended the turn: `error` is an error, a cancelled turn that went idle was interrupted, a closed chat interrupted its turn. */
function outcomeFor(event: AgentEvent, cancelled: boolean): TurnOutcome {
  if (event.type === 'error') return 'error';
  if (event.type === 'session.state.changed') {
    if (event.state === 'error') return 'error';
    if (event.state === 'closed') return 'interrupted';
  }
  return cancelled ? 'interrupted' : 'completed';
}

export function createChatJournal(chatsDir: string, options: ChatJournalOptions = {}): ChatJournal {
  const now = options.now ?? Date.now;
  const openChats = new Map<ChatId, OpenChat>();
  let writeFailureCount = 0;
  let droppedRecordCount = 0;
  let lastFailureCode: string | null = null;

  function recordFailure(reasonCode: string): void {
    writeFailureCount += 1;
    lastFailureCode = reasonCode;
    // A journal failure must be observable without becoming a second thing
    // that can itself throw - mirroring `logger.ts`'s stderr fallback.
    console.error(`[etoolbox-daisy] chat journal degraded: ${reasonCode}`);
  }

  try {
    mkdirSync(chatsDir, { recursive: true });
  } catch (error) {
    recordFailure(extractErrorCode(error));
  }

  function writeRecord(filePath: string, record: ChatJournalRecord): void {
    const parsed = chatJournalRecordSchema.safeParse(record);
    if (!parsed.success) {
      recordFailure('INVALID_RECORD');
      return;
    }
    try {
      appendFileSync(filePath, JSON.stringify(parsed.data) + '\n', 'utf8');
    } catch (error) {
      recordFailure(extractErrorCode(error));
    }
  }

  /**
   * Writes one record for an open chat, flushing the deferred `header` first.
   * Every write of a chat's own record goes through here, so the header always
   * precedes the first record - and a chat that never reaches this point (opened
   * and never used) leaves no file at all.
   */
  function appendRecord(state: OpenChat, record: ChatJournalRecord): void {
    const pendingHeader = state.pendingHeader;
    if (pendingHeader !== undefined) {
      delete state.pendingHeader;
      writeRecord(state.filePath, pendingHeader);
    }
    writeRecord(state.filePath, record);
  }

  function flushPendingPrompt(state: OpenChat, chatId: ChatId, turnId: TurnId): void {
    const pending = state.pendingPrompt;
    if (pending === undefined || pending.turnId !== turnId) return;
    beginTurn(state, chatId, turnId);
    delete state.pendingPrompt;
    // The chat's host is the one active when it was first *used*. A fresh chat's
    // header is deferred until this, its first record, so a header that names no
    // host yet takes the prompt's - the open-time host, when there was one, is
    // already on the header and wins (first known host).
    const pendingHeader = state.pendingHeader;
    if (
      pendingHeader !== undefined &&
      pendingHeader.serverId === undefined &&
      pending.serverId !== undefined
    ) {
      state.pendingHeader = { ...pendingHeader, serverId: pending.serverId };
    }
    appendRecord(state, {
      recordType: 'user.prompt',
      at: now(),
      chatId,
      turnId: pending.turnId,
      prompt: pending.prompt,
      ...(pending.pageContext !== undefined ? { pageContext: pending.pageContext } : {}),
      ...(pending.serverId !== undefined ? { serverId: pending.serverId } : {}),
      ...(pending.origin !== undefined ? { origin: pending.origin } : {}),
    });
  }

  /**
   * Starts timing `turnId` from the moment its prompt was staged. A turn still
   * open from before (it never reached a terminal event) is closed out as
   * interrupted first, so no turn is ever silently dropped from the summaries.
   * Does nothing when the turn is already being timed or has no staged prompt.
   */
  function beginTurn(state: OpenChat, chatId: ChatId, turnId: TurnId): void {
    if (state.turn?.turnId === turnId) return;
    const pending = state.pendingPrompt;
    if (pending === undefined || pending.turnId !== turnId) return;
    if (state.turn !== undefined) finishTurn(state, chatId, 'interrupted');
    state.turn = {
      turnId,
      startedAt: pending.at,
      toolStartedAt: new Map(),
      toolCallCount: 0,
      toolDurationMs: 0,
      modelCallCount: 0,
      modelCallFailureCount: 0,
      cancelled: false,
    };
  }

  /** Folds one event into the turn being timed; events of another turn are ignored. */
  function accumulateTurnEvent(turn: TurnAccumulator, event: AgentEvent): void {
    const eventTurnId = 'turnId' in event ? event.turnId : undefined;
    if (eventTurnId !== undefined && eventTurnId !== turn.turnId) return;
    const at = now();
    // A state change or a model switch is bookkeeping, not a sign the agent is
    // working on the turn; counting `sending` would make the first-activity
    // time always zero.
    if (event.type !== 'session.state.changed' && event.type !== 'model.changed') {
      turn.firstActivityAt ??= at;
    }
    switch (event.type) {
      case 'session.state.changed':
        if (event.state === 'cancelling') turn.cancelled = true;
        return;
      case 'assistant.text.delta':
      case 'assistant.message.completed':
        turn.firstTextAt ??= at;
        return;
      case 'tool.call.requested':
        turn.toolCallCount += 1;
        turn.toolStartedAt.set(event.toolCallId, at);
        return;
      case 'tool.result':
      case 'tool.call.rejected': {
        const startedAt = turn.toolStartedAt.get(event.toolCallId);
        if (startedAt === undefined) return;
        turn.toolStartedAt.delete(event.toolCallId);
        turn.toolDurationMs += Math.max(0, at - startedAt);
        return;
      }
      case 'model.usage':
        turn.modelCallCount += 1;
        if (event.model !== undefined) turn.model = event.model;
        if (event.reasoningEffort !== undefined) turn.reasoningEffort = event.reasoningEffort;
        if (event.finishReason !== undefined) turn.finishReason = event.finishReason;
        turn.inputTokens = addMetric(turn.inputTokens, event.inputTokens);
        turn.outputTokens = addMetric(turn.outputTokens, event.outputTokens);
        turn.cacheReadTokens = addMetric(turn.cacheReadTokens, event.cacheReadTokens);
        turn.reasoningTokens = addMetric(turn.reasoningTokens, event.reasoningTokens);
        turn.cost = addMetric(turn.cost, event.cost);
        return;
      case 'model.call.failed':
        turn.modelCallFailureCount += 1;
        return;
      default:
        return;
    }
  }

  /** Writes the `turn.summary` for the turn being timed, if any, and stops timing it. */
  function finishTurn(state: OpenChat, chatId: ChatId, outcome: TurnOutcome): void {
    const turn = state.turn;
    if (turn === undefined) return;
    delete state.turn;
    const at = now();
    const record: ChatJournalTurnSummaryRecord = {
      recordType: 'turn.summary',
      at,
      chatId,
      turnId: turn.turnId,
      outcome,
      durationMs: Math.max(0, at - turn.startedAt),
      ...(turn.firstActivityAt !== undefined
        ? { firstActivityMs: Math.max(0, turn.firstActivityAt - turn.startedAt) }
        : {}),
      ...(turn.firstTextAt !== undefined
        ? { firstTextMs: Math.max(0, turn.firstTextAt - turn.startedAt) }
        : {}),
      toolCallCount: turn.toolCallCount,
      toolDurationMs: turn.toolDurationMs,
      modelCallCount: turn.modelCallCount,
      modelCallFailureCount: turn.modelCallFailureCount,
      ...(turn.model !== undefined ? { model: turn.model } : {}),
      ...(turn.reasoningEffort !== undefined ? { reasoningEffort: turn.reasoningEffort } : {}),
      ...(turn.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
      ...(turn.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
      ...(turn.cacheReadTokens !== undefined ? { cacheReadTokens: turn.cacheReadTokens } : {}),
      ...(turn.reasoningTokens !== undefined ? { reasoningTokens: turn.reasoningTokens } : {}),
      ...(turn.cost !== undefined ? { cost: turn.cost } : {}),
      ...(turn.finishReason !== undefined ? { finishReason: turn.finishReason } : {}),
    };
    appendRecord(state, record);
    try {
      options.onTurnSummary?.(record);
    } catch {
      // A logging hook must never take the journal down with it.
    }
  }

  function finalizePendingMessages(state: OpenChat, chatId: ChatId): void {
    for (const [messageId, entry] of state.foldsByMessageId) {
      if (state.completedMessageIds.has(messageId)) continue;
      const content = renderFoldedText(entry.fold);
      if (content.length === 0) continue;
      appendRecord(state, {
        recordType: 'assistant.message.partial',
        at: now(),
        chatId,
        turnId: entry.turnId,
        messageId,
        content,
      });
    }
    state.foldsByMessageId.clear();
    state.completedMessageIds.clear();
  }

  /**
   * Records every tool call that never produced a result. Without this the
   * journal would show `tool.call.requested`/`approved` and then stop, leaving
   * a reader unable to tell an abandoned call from one still running - the
   * exact gap a cancelled turn exposes (see the record's own doc comment).
   */
  function finalizeOutstandingToolCalls(state: OpenChat, chatId: ChatId): void {
    for (const [toolCallId, call] of state.outstandingToolCalls) {
      appendRecord(state, {
        recordType: 'tool.call.abandoned',
        at: now(),
        chatId,
        toolCallId,
        toolName: call.toolName,
        ...(call.turnId !== undefined ? { turnId: call.turnId } : {}),
      });
    }
    state.outstandingToolCalls.clear();
  }

  return {
    openChat(params) {
      const existing = openChats.get(params.chatId);
      if (existing !== undefined) {
        if (existing.recordedSessionIds.has(params.sessionId)) return;
        const pendingHeader = existing.pendingHeader;
        if (pendingHeader !== undefined) {
          // Nothing is on disk yet, so this chat's `header` is still going to
          // be its first line: the newest session belongs in it rather than in
          // a second record. The earlier session it replaces was never used
          // (the header is written before a chat's first real record), so there
          // is nothing to keep.
          existing.recordedSessionIds.delete(pendingHeader.sessionId);
          existing.recordedSessionIds.add(params.sessionId);
          existing.pendingHeader = { ...pendingHeader, sessionId: params.sessionId };
          return;
        }
        // The chat already has a `header` on disk, so this is a runtime recycle
        // minting a new SDK session for the same chat. Record it (eagerly - the
        // session exists on disk as soon as the open succeeded) so deletion can
        // remove this session's data too. One small line per recycle is
        // negligible and bounded by real use.
        existing.recordedSessionIds.add(params.sessionId);
        appendRecord(existing, {
          recordType: 'session.opened',
          at: now(),
          chatId: params.chatId,
          sessionId: params.sessionId,
        });
        return;
      }

      let filePath: string;
      try {
        filePath = path.join(chatsDir, toChatFileName(params.chatId));
      } catch {
        recordFailure('UNSAFE_CHAT_ID');
        return;
      }
      const state: OpenChat = {
        filePath,
        recordedSessionIds: new Set(),
        foldsByMessageId: new Map(),
        completedMessageIds: new Set(),
        outstandingToolCalls: new Map(),
      };
      openChats.set(params.chatId, state);
      // A resumed chat already has its header (and possibly `session.opened`
      // records) on disk. Seed the recorded set from the file so a recycle can
      // be told from the session it already names, and - for a genuinely new id
      // over an existing journal (a chat re-opened with a fresh session) - give
      // it its own record. A resumed chat re-opened with an id it already
      // recorded appends nothing.
      if (fileHasContent(filePath)) {
        for (const id of readChatSessionIds(chatsDir, params.chatId)) {
          state.recordedSessionIds.add(id);
        }
        if (!state.recordedSessionIds.has(params.sessionId)) {
          state.recordedSessionIds.add(params.sessionId);
          appendRecord(state, {
            recordType: 'session.opened',
            at: now(),
            chatId: params.chatId,
            sessionId: params.sessionId,
          });
        }
        return;
      }
      // A fresh chat defers its header until its first real record (see
      // `appendRecord`), so merely opening a conversation never creates a file.
      state.recordedSessionIds.add(params.sessionId);
      state.pendingHeader = {
        recordType: 'header',
        schemaVersion: CHAT_JOURNAL_SCHEMA_VERSION,
        chatId: params.chatId,
        sessionId: params.sessionId,
        ...(params.serverId !== undefined ? { serverId: params.serverId } : {}),
        startedAt: now(),
      };
    },

    recordUserPrompt(params) {
      const state = openChats.get(params.chatId);
      if (state === undefined) {
        droppedRecordCount += 1;
        return;
      }
      state.pendingPrompt = {
        turnId: params.turnId,
        prompt: params.prompt,
        ...(params.pageContext !== undefined ? { pageContext: params.pageContext } : {}),
        ...(params.serverId !== undefined ? { serverId: params.serverId } : {}),
        ...(params.origin !== undefined ? { origin: params.origin } : {}),
        at: now(),
      };
    },

    discardUserPrompt(chatId, turnId) {
      const state = openChats.get(chatId);
      if (state?.pendingPrompt?.turnId === turnId) delete state.pendingPrompt;
    },

    recordEvent(event) {
      const state = openChats.get(event.chatId);
      if (state === undefined) {
        droppedRecordCount += 1;
        return;
      }
      const turnId = 'turnId' in event ? event.turnId : undefined;
      // Timings are taken before anything below returns: a turn that only ever
      // reasons still has a first-activity time, and the stream's deltas (which
      // return early) still mark the first text.
      if (turnId !== undefined) beginTurn(state, event.chatId, turnId);
      if (state.turn !== undefined) accumulateTurnEvent(state.turn, event);
      // Reasoning is transient by contract: it is shown in the moment and then
      // discarded, never accumulated as durable history (see `agentEvents.ts`'s
      // reasoning variants and docs/compatibility.md section 6 - the SDK marks
      // the deltas `ephemeral`). A tool-call progress note is transient for the
      // same reason: it is a running-only status line, so recording every tick
      // would bloat the journal with content that is meaningless on replay.
      // Returning before the turn bookkeeping below also means neither can
      // flush a pending prompt on its own; the turn's first non-transient event
      // does that instead.
      if (
        event.type === 'assistant.reasoning.delta' ||
        event.type === 'assistant.reasoning.completed' ||
        event.type === 'tool.call.progress' ||
        event.type === 'user.input.actions.added'
      ) {
        return;
      }
      if (turnId !== undefined) {
        state.currentTurnId = turnId;
        flushPendingPrompt(state, event.chatId, turnId);
      }

      if (event.type === 'assistant.text.delta') {
        const existing = state.foldsByMessageId.get(event.messageId);
        const fold = existing?.fold ?? createDeltaFoldState(event.messageId);
        state.foldsByMessageId.set(event.messageId, {
          turnId: event.turnId,
          fold: foldTextDelta(fold, event),
        });
        return;
      }

      if (event.type === 'assistant.message.completed') {
        state.foldsByMessageId.delete(event.messageId);
        state.completedMessageIds.add(event.messageId);
      }

      if (event.type === 'tool.call.requested') {
        state.outstandingToolCalls.set(event.toolCallId, {
          toolName: event.toolName,
          ...(state.currentTurnId !== undefined ? { turnId: state.currentTurnId } : {}),
        });
      } else if (event.type === 'tool.result' || event.type === 'tool.call.rejected') {
        state.outstandingToolCalls.delete(event.toolCallId);
      }

      appendRecord(state, { recordType: 'agent.event', at: now(), event });

      if (isTurnEnd(event)) {
        finalizePendingMessages(state, event.chatId);
        finalizeOutstandingToolCalls(state, event.chatId);
        if (state.turn !== undefined) {
          finishTurn(state, event.chatId, outcomeFor(event, state.turn.cancelled));
        }
      }
    },

    recordInterruption(params) {
      const state = openChats.get(params.chatId);
      if (state === undefined) {
        droppedRecordCount += 1;
        return;
      }
      appendRecord(state, {
        recordType: 'interruption',
        at: now(),
        chatId: params.chatId,
        reason: params.reason,
      });
    },

    closeChat(chatId) {
      const state = openChats.get(chatId);
      if (state === undefined) return;
      openChats.delete(chatId);
      // An opened-but-unused chat has written nothing and has nothing to
      // finalize, so closing it must not create a file either.
      const hasPendingContent =
        state.foldsByMessageId.size > 0 ||
        state.outstandingToolCalls.size > 0 ||
        state.turn !== undefined;
      if (state.pendingHeader !== undefined && !hasPendingContent) return;
      if (state.turn !== undefined) flushPendingPrompt(state, chatId, state.turn.turnId);
      finalizePendingMessages(state, chatId);
      finalizeOutstandingToolCalls(state, chatId);
      finishTurn(state, chatId, 'interrupted');
      appendRecord(state, { recordType: 'chat.closed', at: now(), chatId });
    },

    getHealth() {
      return { writeFailureCount, droppedRecordCount, lastFailureCode };
    },
  };
}
