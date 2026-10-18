import { z } from 'zod';
import {
  chatIdSchema,
  sessionIdSchema,
  serverIdSchema,
  type ChatId,
  type SessionId,
  type ServerId,
} from '../../../shared';

/**
 * Persistence for the chat pane's last opened conversation.
 *
 * The sibling of `lastPageStore.ts`, and deliberately the same shape: this is
 * renderer-local view state that the main process never needs, so it lives in
 * `localStorage` (scoped to this app's partition, surviving restarts) rather
 * than in the settings document. One global record, not one per server - the
 * page pointer is global too, so "restore the remembered page and the
 * remembered chat" stays a single, conflict-free decision.
 *
 * `sessionId` is stored alongside `chatId` because the journal header only
 * records the session id at chat creation; a runtime recycle (a proxy or
 * active-provider change) mints a new SDK session for the same `chatId`, so the
 * live id from `AgentChatStatus` is the authoritative one to resume. The caller
 * refreshes it whenever the pane learns a new one.
 *
 * `serverId` is the AEM host the shell was showing when the record was last
 * written. It is the server-match gate: a chat is only restored when this names
 * the same host as the remembered page, so the pane never resumes a
 * conversation against a different target. It is captured here (not read from
 * the journal) because a chat can open before any page has loaded, leaving the
 * journal header's `serverId` absent.
 *
 * The record is only written once a chat has at least one message (see
 * `chatPane.ts`), so an opened-but-unused conversation is never restored.
 *
 * Every access is guarded: `localStorage` throws rather than returning null when
 * storage is unavailable or over quota, and failing to remember a chat must
 * never take the window down with it.
 */

export const STORAGE_KEY = 'daisy.mainShell.lastChat';
/** A stored value longer than any plausible record is discarded rather than trusted. */
const MAX_RAW_LENGTH = 1000;

const lastChatRecordSchema = z
  .object({
    chatId: chatIdSchema,
    sessionId: sessionIdSchema,
    serverId: serverIdSchema,
  })
  .strict();

export interface LastChatRecord {
  readonly chatId: ChatId;
  readonly sessionId: SessionId;
  readonly serverId: ServerId;
}

/** The last remembered conversation, or `undefined` when there is no usable stored value. */
export function loadLastChat(): LastChatRecord | undefined {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (raw === null || raw.length === 0 || raw.length > MAX_RAW_LENGTH) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const record = lastChatRecordSchema.safeParse(parsed);
  if (!record.success) return undefined;
  return {
    chatId: record.data.chatId,
    sessionId: record.data.sessionId,
    serverId: record.data.serverId,
  };
}

/** Records the last opened conversation. Overwrites any previous record. */
export function saveLastChat(record: LastChatRecord): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    return;
  }
  if (serialized.length > MAX_RAW_LENGTH) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Nothing actionable for the user here - the chat still opens this run, it
    // just will not be restored for the next one.
  }
}

/** Forgets the remembered conversation, e.g. when it can no longer be resumed. */
export function clearLastChat(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort, same as the other accessors.
  }
}
