import type { AgentChatHistoryEntry, ServerId } from '../../../shared';
import type { HostOption } from '../shell/viewModel';

/**
 * Pure presentation helpers for the History panel (`shell/historyPanel.ts`).
 * Kept apart from the DOM so the labels - the one thing a reader actually sees
 * about a stored conversation - are unit-tested directly.
 */

/** Shown in place of a chat's title when its journal holds no user prompt to derive one from. */
export const UNTITLED_CONVERSATION = 'Untitled conversation';

/** English month abbreviations - a fixed display vocabulary, not locale data. */
const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Formats a stored conversation's start time as `15 Oct 2026, 14:03`, in the
 * user's local time. Deliberately hand-built from `Date` accessors rather than
 * `Intl`/`toLocaleString`: the result must be identical wherever the panel is
 * rendered (and in tests), and a fixed `15 Oct 2026, 14:03` shape is what the
 * row's tight column can actually fit. An unusable timestamp yields an empty
 * string rather than `"Invalid Date"`.
 */
export function formatHistoryTimestamp(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.getDate();
  const month = MONTH_ABBREVIATIONS[date.getMonth()] ?? '';
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${String(day)} ${month} ${String(year)}, ${hours}:${minutes}`;
}

/** A chat's display title: its derived title, or the untitled fallback. */
export function historyEntryTitle(entry: AgentChatHistoryEntry): string {
  const title = entry.title?.trim();
  return title === undefined || title.length === 0 ? UNTITLED_CONVERSATION : title;
}

/**
 * The configured host a chat is bound to, by id. `serverId` is the stable
 * identity, so a renamed host keeps matching. A chat whose server was deleted
 * (or that never had one) resolves to `undefined`; the caller then omits the
 * host from the row entirely rather than showing a placeholder.
 */
export function resolveHistoryServer(
  entry: AgentChatHistoryEntry,
  servers: readonly HostOption[],
): HostOption | undefined {
  const serverId: ServerId | undefined = entry.serverId;
  if (serverId === undefined) return undefined;
  return servers.find((server) => server.id === serverId);
}
