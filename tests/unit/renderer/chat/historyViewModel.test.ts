import { describe, expect, it } from 'vitest';
import type { AgentChatHistoryEntry, ServerId } from '../../../../src/shared';
import {
  formatHistoryTimestamp,
  historyEntryTitle,
  resolveHistoryServer,
  UNTITLED_CONVERSATION,
} from '../../../../src/renderer/src/chat/historyViewModel';
import type { HostOption } from '../../../../src/renderer/src/shell/viewModel';

/**
 * The History row's three labels - title, date, host - are pure and tested
 * directly: they are the only thing a reader sees about a stored conversation.
 */

function entry(overrides: Partial<AgentChatHistoryEntry> = {}): AgentChatHistoryEntry {
  return {
    chatId: 'chat-1',
    startedAt: 0,
    updatedAt: 0,
    ...overrides,
  } as AgentChatHistoryEntry;
}

function host(id: string, label: string): HostOption {
  return { id: id as ServerId, label, origin: `https://${id}.example`, colorCss: '#000000' };
}

describe('historyEntryTitle', () => {
  it('uses the derived title', () => {
    expect(historyEntryTitle(entry({ title: 'Find the media library' }))).toBe(
      'Find the media library',
    );
  });

  it('falls back for a missing or blank title', () => {
    expect(historyEntryTitle(entry())).toBe(UNTITLED_CONVERSATION);
    expect(historyEntryTitle(entry({ title: '   ' }))).toBe(UNTITLED_CONVERSATION);
  });
});

describe('formatHistoryTimestamp', () => {
  it('formats a start time as day month year, hh:mm in local time', () => {
    // Build the expectation from the same Date accessors, so the assertion is
    // about the *layout*, not the test machine's timezone.
    const at = 1_700_000_000_000;
    const d = new Date(at);
    const months = [
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
    ];
    const expected = `${String(d.getDate())} ${months[d.getMonth()] ?? ''} ${String(
      d.getFullYear(),
    )}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(formatHistoryTimestamp(at)).toBe(expected);
  });

  it('returns an empty string for an unusable timestamp', () => {
    expect(formatHistoryTimestamp(Number.NaN)).toBe('');
  });
});

describe('resolveHistoryServer', () => {
  it('resolves a chat host by its stable id', () => {
    const servers = [host('server-1', 'Production')];
    expect(resolveHistoryServer(entry({ serverId: 'server-1' as ServerId }), servers)).toEqual(
      servers[0],
    );
  });

  it('returns undefined for no host or an unknown one, so the caller omits it', () => {
    expect(resolveHistoryServer(entry(), [host('server-1', 'Production')])).toBeUndefined();
    expect(
      resolveHistoryServer(entry({ serverId: 'gone' as ServerId }), [
        host('server-1', 'Production'),
      ]),
    ).toBeUndefined();
  });
});
