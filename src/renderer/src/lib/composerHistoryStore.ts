import { COMPOSER_HISTORY_LIMIT } from '../chat/composerHistory';

/**
 * Persistence for the chat composer's prompt history.
 *
 * Like `lastPageStore.ts` and `paneLayoutStore.ts` this is renderer-local view
 * state and deliberately does not go through `AppSettings`/`settings:*` IPC:
 * the main process never needs it, and `localStorage` is scoped to this app's
 * own partition and survives restarts - exactly the required lifetime.
 *
 * The document is a JSON array of strings, oldest first. Every access is
 * guarded: `localStorage` throws rather than returning null when storage is
 * unavailable or over quota, and failing to remember (or load) a prompt must
 * never take the window down with it.
 */

const STORAGE_KEY = 'daisy.chat.composerHistory';

/** A stored document longer than this is discarded rather than parsed. */
const MAX_STORED_LENGTH = 200_000;

/** The remembered prompts, oldest first, or `[]` when there is nothing usable stored. */
export function loadComposerHistory(): readonly string[] {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null || raw.length === 0 || raw.length > MAX_STORED_LENGTH) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  // A document written by a different build, hand-edited, or truncated
  // mid-write is discarded rather than trusted: only non-empty strings are
  // remembered, and only the newest window survives.
  return parsed
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .slice(-COMPOSER_HISTORY_LIMIT);
}

/** Records the history, keeping only the newest {@link COMPOSER_HISTORY_LIMIT} entries. */
export function saveComposerHistory(entries: readonly string[]): void {
  const capped = entries.slice(-COMPOSER_HISTORY_LIMIT);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // Nothing actionable for the user here - recall still works for this run,
    // it just will not be remembered for the next one.
  }
}
