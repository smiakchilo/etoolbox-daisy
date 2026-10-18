import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * Resuming a conversation from History while the shell is still moving the
 * browser to the chat's host (or the host is unreachable).
 *
 * The transcript is a local file, so it must not wait for the host; a send
 * must, because its page context is whatever the pane shows when it goes out.
 * The harness is deliberately smaller than `chatPane.test.ts`'s: the pane is
 * driven only as far as a History resume needs.
 */

let dom: JSDOM;
let restoreGlobals: () => void;

const getStatus = vi.fn();
const openConversation = vi.fn();
const readJournal = vi.fn();
const sendMessage = vi.fn();
let statusListener: ((status: AgentChatStatus) => void) | undefined;

const storedChatId = 'chat-stored' as ChatId;
const storedRecords: readonly ChatJournalRecord[] = [
  {
    recordType: 'user.prompt',
    at: 1,
    chatId: storedChatId,
    turnId: 'turn-old' as TurnId,
    prompt: 'what did we say?',
  },
];

function readyStatus(): AgentChatStatus {
  return {
    apiVersion: 1,
    auth: { apiVersion: 1, isAuthenticated: true },
    activeChatId: null,
    sdkSessionId: null,
    sessionState: 'idle',
    serviceState: 'ready',
  };
}

async function waitForUserMessage(pane: ChatPane): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pane.element.querySelector('.chat-message--user') !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the transcript never repainted the user prompt');
}

async function readyPane(): Promise<ChatPane> {
  const pane = createChatPane({ onOpenSettings: vi.fn() });
  pane.setAgents({ copilot: { active: true, hasToken: true } });
  statusListener?.(readyStatus());
  await flush();
  return pane;
}

function click(element: Element | null): void {
  if (element === null) throw new Error('control is missing');
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

function sendPrompt(pane: ChatPane, prompt: string): void {
  const field = pane.element.querySelector('.chat-composer__field') as HTMLElement & {
    value: string;
  };
  field.value = prompt;
  click(pane.element.querySelector('.chat-composer__send'));
}

beforeEach(() => {
  getStatus.mockReset();
  openConversation.mockReset();
  readJournal.mockReset();
  sendMessage.mockReset();
  statusListener = undefined;

  // Never resolves: the pushed status is the path under test.
  getStatus.mockImplementation(() => new Promise<AgentChatStatus>(() => undefined));
  openConversation.mockResolvedValue({ ok: true, chatId: storedChatId });
  readJournal.mockResolvedValue({ ok: true, records: storedRecords });
  sendMessage.mockResolvedValue({ ok: true, turnId: 'turn-1' });

  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
  Reflect.set(dom.window, 'daisy', {
    agentChat: {
      getStatus,
      openConversation,
      readJournal,
      sendMessage,
      abort: vi.fn(),
      respondToInput: vi.fn(),
      listSkills: vi.fn().mockResolvedValue({ ok: true, skills: [] }),
      revealJournal: vi.fn().mockResolvedValue({ ok: true }),
      onEvent: vi.fn(() => () => undefined) as (
        listener: (event: AgentEvent) => void,
      ) => () => void,
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

describe('createChatPane History resume while the host is still switching', () => {
  it('paints the transcript and resumes the session without waiting for the host', async () => {
    const pane = await readyPane();
    openConversation.mockClear();

    // The host never settles - the unreachable-host case.
    const hostSettled = new Promise<void>(() => undefined);
    const outcome = await pane.openConversationFromHistory(storedChatId, { hostSettled });
    await waitForUserMessage(pane);

    expect(outcome).toEqual({ ok: true });
    expect(pane.element.querySelectorAll('.chat-message--user')).toHaveLength(1);
    expect(openConversation).toHaveBeenCalledTimes(1);
    pane.dispose();
  });

  it('holds a send until the host settles, then sends', async () => {
    const pane = await readyPane();
    let settleHost: (() => void) | undefined;
    const hostSettled = new Promise<void>((resolve) => {
      settleHost = resolve;
    });
    await pane.openConversationFromHistory(storedChatId, { hostSettled });
    await waitForUserMessage(pane);

    sendPrompt(pane, 'still there?');
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();

    settleHost?.();
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      chatId: storedChatId,
      prompt: 'still there?',
    });
    pane.dispose();
  });

  it('does not hold a send for a host switch that belonged to a conversation it left', async () => {
    const pane = await readyPane();
    await pane.openConversationFromHistory(storedChatId, {
      hostSettled: new Promise<void>(() => undefined),
    });
    await waitForUserMessage(pane);

    click(pane.element.querySelector(byTestId('chat-new-session')));
    await flush();

    sendPrompt(pane, 'a fresh question');
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ prompt: 'a fresh question' });
    pane.dispose();
  });

  it('does not hold a send when the resume names no host switch', async () => {
    const pane = await readyPane();
    await pane.openConversationFromHistory(storedChatId);
    await waitForUserMessage(pane);

    sendPrompt(pane, 'no switch');
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    pane.dispose();
  });

  it('reports a failed session resume and keeps the transcript, whatever the host did', async () => {
    const pane = await readyPane();
    openConversation.mockResolvedValueOnce({
      ok: false,
      error: { code: 'AGENT_UNAVAILABLE', message: 'session gone' },
    });

    const outcome = await pane.openConversationFromHistory(storedChatId, {
      hostSettled: Promise.resolve(),
    });
    await waitForUserMessage(pane);

    expect(outcome).toEqual({ ok: false, message: 'session gone' });
    expect(pane.element.querySelectorAll('.chat-message--user')).toHaveLength(1);
    pane.dispose();
  });
});
