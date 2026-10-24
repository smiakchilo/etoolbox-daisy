import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatExactTokens,
  formatTokenCount,
  type UsageRow,
} from '../../../src/renderer/src/chat/sessionUsage';
import { createChatPane, type ChatPane } from '../../../src/renderer/src/shell/chatPane';
import type {
  AgentChatStatus,
  AgentEvent,
  ChatId,
  ChatJournalRecord,
  TurnId,
} from '../../../src/shared';
import { flushMicrotasks as flush } from '../../support/asyncWaits';
import { installJsdomGlobals } from '../../support/jsdomGlobals';
import { byTestId } from '../../support/selectors';

/**
 * The footer's token gauge and the rows it feeds the usage panel: totals fold
 * from live events and from a resumed chat's journal, a click opens the panel,
 * and a new session starts the count over. The harness mirrors
 * `chatPaneHistoryResume.test.ts`'s - the pane is driven only as far as needed.
 */

let dom: JSDOM;
let restoreGlobals: () => void;

const getStatus = vi.fn();
const openConversation = vi.fn();
const readJournal = vi.fn();
let statusListener: ((status: AgentChatStatus) => void) | undefined;
let eventListener: ((event: AgentEvent) => void) | undefined;

const storedChatId = 'chat-stored' as ChatId;

function usageRecord(inputTokens: number, outputTokens: number): ChatJournalRecord {
  return {
    recordType: 'agent.event',
    at: 2,
    chatId: storedChatId,
    event: {
      type: 'model.usage',
      chatId: storedChatId,
      sequence: 1,
      turnId: 'turn-old' as TurnId,
      model: 'stored-model',
      inputTokens,
      outputTokens,
    },
  } as ChatJournalRecord;
}

function storedRecords(...extra: ChatJournalRecord[]): readonly ChatJournalRecord[] {
  return [
    {
      recordType: 'user.prompt',
      at: 1,
      chatId: storedChatId,
      turnId: 'turn-old' as TurnId,
      prompt: 'what did we say?',
    },
    ...extra,
  ];
}

function readyStatus(): AgentChatStatus {
  return {
    apiVersion: 1,
    auth: { apiVersion: 1, isAuthenticated: true },
    activeChatId: null,
    sessionId: null,
    sessionState: 'idle',
    serviceState: 'ready',
  };
}

function click(element: Element | null): void {
  if (element === null) throw new Error('control is missing');
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function gauge(pane: ChatPane): HTMLElement {
  const element = pane.element.querySelector<HTMLElement>(byTestId('chat-usage-gauge'));
  if (element === null) throw new Error('the gauge is missing');
  return element;
}

/** The chat the pane opened, so a pushed event can name it. */
function openedChatId(): ChatId {
  const request = openConversation.mock.calls[0]?.[0] as { chatId: ChatId } | undefined;
  if (request === undefined) throw new Error('the pane never opened a conversation');
  return request.chatId;
}

function modelUsage(chatId: ChatId, fields: Record<string, unknown>): AgentEvent {
  return {
    type: 'model.usage',
    chatId,
    sequence: 0,
    turnId: 'turn-1',
    ...fields,
  } as AgentEvent;
}

async function readyPane(
  options: { onOpenUsage?: () => void; onUsageChanged?: (rows: readonly UsageRow[]) => void } = {},
): Promise<ChatPane> {
  const pane = createChatPane({ onOpenSettings: vi.fn(), ...options });
  pane.setAgents({ copilot: { active: true, hasToken: true, model: 'selected-model' } });
  statusListener?.(readyStatus());
  await flush();
  return pane;
}

beforeEach(() => {
  getStatus.mockReset();
  openConversation.mockReset();
  readJournal.mockReset();
  statusListener = undefined;
  eventListener = undefined;

  getStatus.mockImplementation(() => new Promise<AgentChatStatus>(() => undefined));
  openConversation.mockResolvedValue({ ok: true, chatId: storedChatId });
  readJournal.mockResolvedValue({ ok: true, records: storedRecords(usageRecord(500, 40)) });

  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
  Reflect.set(dom.window, 'daisy', {
    agentChat: {
      getStatus,
      openConversation,
      readJournal,
      sendMessage: vi.fn().mockResolvedValue({ ok: true, turnId: 'turn-1' }),
      abort: vi.fn(),
      respondToInput: vi.fn(),
      listSkills: vi.fn().mockResolvedValue({ ok: true, skills: [] }),
      revealJournal: vi.fn().mockResolvedValue({ ok: true }),
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        eventListener = listener;
        return () => undefined;
      }),
      onStatusChanged: vi.fn((listener: (status: AgentChatStatus) => void) => {
        statusListener = listener;
        return () => {
          statusListener = undefined;
        };
      }),
    },
    browser: {
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      find: vi.fn(() => Promise.resolve({ ok: true })),
      stopFind: vi.fn(() => Promise.resolve({ ok: true })),
      onFindResult: vi.fn(() => () => undefined),
    },
    settings: {
      getModelSelection: vi.fn().mockResolvedValue({
        ok: true,
        state: {
          models: [],
          selectedModel: null,
          selectedReasoningEffort: null,
          catalogUnavailable: false,
        },
      }),
    },
  });
});

afterEach(() => {
  restoreGlobals();
});

describe('the footer token gauge', () => {
  it('is hidden while there is nothing to show, then appears with the first reported usage', async () => {
    const pane = await readyPane();
    expect(gauge(pane).hasAttribute('hidden')).toBe(true);

    eventListener?.(modelUsage(openedChatId(), { inputTokens: 10, outputTokens: 2 }));

    expect(gauge(pane).hasAttribute('hidden')).toBe(false);
    pane.dispose();
  });

  it('stays hidden for calls that reported no tokens', async () => {
    const pane = await readyPane();

    eventListener?.(modelUsage(openedChatId(), { durationMs: 900 }));

    expect(gauge(pane).hasAttribute('hidden')).toBe(true);
    pane.dispose();
  });

  it('totals the conversation from the usage events it receives', async () => {
    const pane = await readyPane();
    const chatId = openedChatId();

    eventListener?.(modelUsage(chatId, { inputTokens: 10000, outputTokens: 1500 }));
    eventListener?.(modelUsage(chatId, { inputTokens: 2345, outputTokens: 300 }));

    expect(gauge(pane).textContent).toContain(formatTokenCount(12345));
    expect(gauge(pane).textContent).toContain(formatTokenCount(1800));
    expect(gauge(pane).title).toContain(formatExactTokens(12345));
    pane.dispose();
  });

  it('opens the usage panel when clicked, and never follows its inert link', async () => {
    const onOpenUsage = vi.fn();
    const pane = await readyPane({ onOpenUsage });

    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    gauge(pane).dispatchEvent(event);

    expect(onOpenUsage).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    pane.dispose();
  });

  it('shows the usage totals of a conversation resumed from its journal', async () => {
    const pane = await readyPane();

    await pane.openConversationFromHistory(storedChatId);
    await flush();

    expect(gauge(pane).textContent).toContain(formatTokenCount(500));
    expect(gauge(pane).textContent).toContain(formatTokenCount(40));
    pane.dispose();
  });

  it('stays hidden for a conversation resumed from a journal that recorded no usage', async () => {
    readJournal.mockResolvedValue({ ok: true, records: storedRecords() });
    const pane = await readyPane();

    await pane.openConversationFromHistory(storedChatId);
    await flush();

    expect(gauge(pane).hasAttribute('hidden')).toBe(true);
    pane.dispose();
  });

  it('starts the count over for a new session', async () => {
    const pane = await readyPane();
    eventListener?.(modelUsage(openedChatId(), { inputTokens: 7777, outputTokens: 11 }));
    expect(gauge(pane).textContent).toContain(formatTokenCount(7777));

    click(pane.element.querySelector(byTestId('chat-new-session')));
    await flush();

    expect(gauge(pane).hasAttribute('hidden')).toBe(true);
    pane.dispose();
  });
});

describe('the rows handed to the usage panel', () => {
  it('carry the totals, the model the call named, and the context snapshot', async () => {
    const onUsageChanged = vi.fn<(rows: readonly UsageRow[]) => void>();
    const pane = await readyPane({ onUsageChanged });
    const chatId = openedChatId();

    eventListener?.(
      modelUsage(chatId, {
        model: 'gpt-x',
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadTokens: 400,
      }),
    );
    eventListener?.({
      type: 'context.usage',
      chatId,
      sequence: 1,
      currentTokens: 2500,
      tokenLimit: 10000,
    });

    const rows = onUsageChanged.mock.lastCall?.[0] ?? [];
    const value = (id: UsageRow['id']): string | undefined =>
      rows.find((row) => row.id === id)?.value;
    expect(value('model')).toBe('gpt-x');
    expect(value('input-uncached')).toBe(formatExactTokens(600));
    expect(value('input-cached')).toBe(formatExactTokens(400));
    expect(value('output')).toBe(formatExactTokens(50));
    expect(value('context')).toContain(formatExactTokens(2500));
    pane.dispose();
  });

  it('name the selected model until a call names one', async () => {
    const onUsageChanged = vi.fn<(rows: readonly UsageRow[]) => void>();
    const pane = await readyPane({ onUsageChanged });

    const rows = onUsageChanged.mock.lastCall?.[0] ?? [];
    expect(rows.find((row) => row.id === 'model')?.value).toBe('selected-model');
    pane.dispose();
  });
});
