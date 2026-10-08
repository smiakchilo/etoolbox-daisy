import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentEvent,
  type ChatId,
  type ChatJournalHeaderRecord,
  type ChatJournalRecord,
  CHAT_JOURNAL_SCHEMA_VERSION,
  chatJournalRecordSchema,
  createDeltaFoldState,
  type DeltaFoldState,
  foldTextDelta,
  type MessageId,
  renderFoldedText,
  type SdkSessionId,
  type ServerId,
  type ToolCallId,
  type TurnId,
} from '../shared';

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
  readonly sdkSessionId: SdkSessionId;
  /** The AEM server the chat is bound to, if one was selected when it opened. */
  readonly serverId?: ServerId;
}

export interface ChatJournalUserPromptParams {
  readonly chatId: ChatId;
  readonly turnId: TurnId;
  readonly prompt: string;
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
   * existing journal without a second header. A second call for an
   * already-open chat is a no-op.
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
  /** Finalizes any partial message and writes the `chat.closed` marker. A chat that never wrote a record (opened but unused) writes nothing. */
  closeChat(chatId: ChatId): void;
  getHealth(): ChatJournalHealth;
}

export interface ChatJournalOptions {
  /** Injectable clock so tests get deterministic `at`/`startedAt` values. */
  readonly now?: () => number;
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

interface OpenChat {
  readonly filePath: string;
  /**
   * The `header` record to write immediately before this chat's first real
   * record, or `undefined` once it has been written (or when the journal was
   * opened over a file that already had content). Deferring it is what keeps an
   * opened-but-unused conversation from ever creating a file.
   */
  pendingHeader?: ChatJournalHeaderRecord;
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
  /** At most one prompt is staged: main owns one active turn per chat. */
  pendingPrompt?: { readonly turnId: TurnId; readonly prompt: string };
}

/**
 * Derives the file name for a chat. `ChatId`s are validated to be free of
 * control characters but are not otherwise constrained, so this rejects path
 * separators explicitly rather than trusting the id's provenance - the journal
 * must never be steerable to an arbitrary file by a crafted id.
 *
 * Exported because the reader (`chatJournalReader.ts`) must apply the identical
 * guard: a read path built from an attacker-influenced id is the same hazard as
 * a write path.
 */
export function toChatFileName(chatId: string): string {
  if (
    chatId.length === 0 ||
    chatId === '.' ||
    chatId === '..' ||
    chatId.includes('/') ||
    chatId.includes('\\')
  ) {
    throw new Error(`Refusing to derive a chat journal file name from unsafe chatId "${chatId}"`);
  }
  return `${chatId}.jsonl`;
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
    delete state.pendingPrompt;
    appendRecord(state, {
      recordType: 'user.prompt',
      at: now(),
      chatId,
      turnId: pending.turnId,
      prompt: pending.prompt,
    });
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
      if (openChats.has(params.chatId)) return;
      let filePath: string;
      try {
        filePath = path.join(chatsDir, toChatFileName(params.chatId));
      } catch {
        recordFailure('UNSAFE_CHAT_ID');
        return;
      }
      const state: OpenChat = {
        filePath,
        foldsByMessageId: new Map(),
        completedMessageIds: new Set(),
        outstandingToolCalls: new Map(),
      };
      openChats.set(params.chatId, state);
      // A resumed chat already has its header on disk; a fresh one defers it
      // until its first real record (see `appendRecord`), so merely opening a
      // conversation never creates a file.
      if (fileHasContent(filePath)) return;
      state.pendingHeader = {
        recordType: 'header',
        schemaVersion: CHAT_JOURNAL_SCHEMA_VERSION,
        chatId: params.chatId,
        sdkSessionId: params.sdkSessionId,
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
      state.pendingPrompt = { turnId: params.turnId, prompt: params.prompt };
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
      // Reasoning is transient by contract: it is shown in the moment and then
      // discarded, never accumulated as durable history (see `agentEvents.ts`'s
      // reasoning variants and docs/compatibility.md section 6 - the SDK marks
      // the deltas `ephemeral`). Returning before the turn bookkeeping below
      // also means a reasoning block can never flush a pending prompt on its
      // own; the turn's first non-reasoning event does that instead.
      if (
        event.type === 'assistant.reasoning.delta' ||
        event.type === 'assistant.reasoning.completed'
      ) {
        return;
      }
      const turnId = 'turnId' in event ? event.turnId : undefined;
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
      }
    },

    closeChat(chatId) {
      const state = openChats.get(chatId);
      if (state === undefined) return;
      openChats.delete(chatId);
      // An opened-but-unused chat has written nothing and has nothing to
      // finalize, so closing it must not create a file either.
      const hasPendingContent =
        state.foldsByMessageId.size > 0 || state.outstandingToolCalls.size > 0;
      if (state.pendingHeader !== undefined && !hasPendingContent) return;
      finalizePendingMessages(state, chatId);
      finalizeOutstandingToolCalls(state, chatId);
      appendRecord(state, { recordType: 'chat.closed', at: now(), chatId });
    },

    getHealth() {
      return { writeFailureCount, droppedRecordCount, lastFailureCode };
    },
  };
}
