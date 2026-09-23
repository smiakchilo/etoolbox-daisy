import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChatPane,
  type ChatPane,
  type StartupConversation,
} from '../../../src/renderer/src/shell/chatPane';
import type {
  AgentChatStatus,
  AgentEvent,
  AgentSettingsSnapshot,
  ChatId,
  ChatJournalRecord,
  SdkSessionId,
  TurnId,
} from '../../../src/shared';

/**
 * The chat pane's reaction to the `agent-chat:status-changed` push.
 *
 * Two behaviours are asserted here that the E2E cannot drive deterministically,
 * because both need a runtime recycle to happen at a chosen instant:
 *
 *  - a pushed status is applied immediately (auth gates the composer), and
 *  - a pushed status that reports main no longer owns the pane's conversation
 *    makes the pane re-open it, instead of letting the next send fail with
 *    "not the currently open conversation".
 *
 * The push's *arrival* (`onStatusChanged`) is unit-tested in
 * `tests/unit/main/agentChatController.test.ts`; this file takes that arrival
 * as given and drives the renderer with it.
 */

const previousDocument = Reflect.get(globalThis, 'document') as unknown;
const previousWindow = Reflect.get(globalThis, 'window') as unknown;
let dom: JSDOM;

const getStatus = vi.fn();
const openConversation = vi.fn();
const sendMessage = vi.fn();
const abort = vi.fn();
const navigate = vi.fn();
let statusListener: ((status: AgentChatStatus) => void) | undefined;
let eventListener: ((event: AgentEvent) => void) | undefined;

function definedStatus(overrides: Partial<AgentChatStatus> = {}): AgentChatStatus {
  return {
    apiVersion: 1,
    auth: { apiVersion: 1, isAuthenticated: false },
    activeChatId: null,
    sdkSessionId: null,
    sessionState: 'idle',
    serviceState: 'ready',
    ...overrides,
  };
}

/** Runs the pane's async `applyStatus` chain and the click's `.then`s to completion. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
}

/**
 * The transcript repaints on a real 100ms interval (only when the store is
 * dirty), so a unit test must let that interval actually fire before the DOM
 * reflects an event. Bounded and short - it only waits as long as it needs to.
 */
async function waitForUserMessage(pane: ChatPane): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pane.element.querySelector('.chat-message--user') !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the transcript never repainted the user prompt');
}

function pushStatus(status: AgentChatStatus): void {
  if (statusListener === undefined) throw new Error('the pane never subscribed to status changes');
  statusListener(status);
}

function pushEvent(event: AgentEvent): void {
  if (eventListener === undefined) throw new Error('the pane never subscribed to chat events');
  eventListener(event);
}

async function waitForAssistantMessage(pane: ChatPane): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pane.element.querySelector('.chat-message--assistant') !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the transcript never repainted the assistant message');
}

function sendButton(pane: ChatPane): HTMLElement | null {
  return pane.element.querySelector('.chat-composer__send');
}

function agentBanner(pane: ChatPane): HTMLElement | null {
  return pane.element.querySelector('.chat-status-banner');
}

/**
 * Waits out the banner's collapse animation, so a test can assert the row is
 * gone rather than mid-transition - a collapsing row keeps `open` for
 * `BANNER_TRANSITION_DURATION_MS` while it animates shut.
 */
async function waitForBannerClosed(pane: ChatPane): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (agentBanner(pane)?.hasAttribute('open') !== true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the chat status banner never collapsed');
}

beforeEach(() => {
  getStatus.mockReset();
  openConversation.mockReset();
  sendMessage.mockReset();
  abort.mockReset();
  navigate.mockReset();
  statusListener = undefined;
  eventListener = undefined;

  // Never resolves: the pane's own `void refreshStatus()` at construction must
  // not race the pushed status each test drives. The push is the path under
  // test, and a real push always arrives once the service is ready anyway.
  getStatus.mockImplementation(() => new Promise<AgentChatStatus>(() => undefined));
  openConversation.mockResolvedValue({ ok: true, chatId: 'chat-1' as ChatId });
  sendMessage.mockResolvedValue({ ok: true, turnId: 'turn-1' });
  abort.mockResolvedValue({ ok: true });
  navigate.mockResolvedValue({ ok: true });

  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
  Reflect.set(dom.window, 'daisy', {
    agentChat: {
      getStatus,
      openConversation,
      sendMessage,
      abort,
      onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
        eventListener = listener;
        return () => {
          eventListener = undefined;
        };
      }),
      onStatusChanged: vi.fn((listener: (status: AgentChatStatus) => void) => {
        statusListener = listener;
        return () => {
          statusListener = undefined;
        };
      }),
    },
    browser: { navigate },
  });
});

afterEach(() => {
  dom.window.close();
  Reflect.set(globalThis, 'document', previousDocument);
  Reflect.set(globalThis, 'window', previousWindow);
});

describe('createChatPane status push', () => {
  it('mints and opens its one conversation on the first ready status, and disables the composer with no eligible agent', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });

    pushStatus(definedStatus());
    await flush();

    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(sendButton(pane)?.hasAttribute('disabled')).toBe(true);
    // No agent is active (the pane has no settings snapshot yet), so the
    // standing banner explains the disabled composer.
    expect(agentBanner(pane)?.hasAttribute('open')).toBe(true);

    pane.dispose();
  });

  it('re-opens the same conversation when a pushed status says main no longer owns it', async () => {
    // A runtime recycle (proxy/sign-in/token change) disposes the controller
    // that owned our conversation; the fresh one starts with `activeChatId:
    // null`. Re-opening is what prevents the "not the currently open
    // conversation" send failure.
    const pane = createChatPane({ onOpenSettings: vi.fn() });

    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    const firstChatId = openConversation.mock.calls[0]?.[0] as { chatId: ChatId };
    expect(firstChatId).toBeDefined();

    // The recycle's push: same chat id, but main reports none open.
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: false } }));
    await flush();

    expect(openConversation).toHaveBeenCalledTimes(2);
    expect(openConversation.mock.calls[1]?.[0]).toEqual(firstChatId);

    pane.dispose();
  });

  it('locks the composer when a pushed status reports the recycled runtime signed out, with no token stored', async () => {
    // The reported bug: the snapshot's `hasToken` never changes, but the old
    // runtime still reports authenticated while the recycle is in flight, so
    // the composer stayed usable long after Settings said "not authenticated".
    // The push is what closes that window the moment the fresh runtime answers.
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: false } });

    // The pre-recycle runtime: still authenticated.
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    expect(sendButton(pane)?.hasAttribute('disabled')).toBe(false);

    // The recycle completes: signed out, and no token to fall back on.
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: false } }));
    await flush();
    expect(sendButton(pane)?.hasAttribute('disabled')).toBe(true);
    expect(agentBanner(pane)?.hasAttribute('open')).toBe(true);

    pane.dispose();
  });

  it('disables the composer as soon as a pushed status reports the agent no longer usable', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    const agents: Record<string, AgentSettingsSnapshot> = {
      copilot: { active: true, hasToken: true },
    };
    pane.setAgents(agents);

    // Token stored: eligible/active, composer enabled.
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: false } }));
    await flush();
    expect(sendButton(pane)?.hasAttribute('disabled')).toBe(false);

    // Token cleared (snapshot applied) and the recycled runtime reports signed
    // out: no longer eligible, so the composer locks immediately.
    pane.setAgents({ copilot: { active: true, hasToken: false } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: false } }));
    await flush();

    expect(sendButton(pane)?.hasAttribute('disabled')).toBe(true);
    expect(agentBanner(pane)?.hasAttribute('open')).toBe(true);

    pane.dispose();
  });

  it('owns exactly one banner row: a later error suppresses the standing prompt, which returns when it clears', async () => {
    openConversation.mockResolvedValueOnce({
      ok: false,
      error: { code: 'INTERNAL', message: 'boom' },
    });
    const pane = createChatPane({ onOpenSettings: vi.fn() });

    // No eligible agent: the standing "no usable agent" prompt would take the
    // pane's single row, but the failed conversation open is a later error and
    // takes it instead.
    pushStatus(definedStatus());
    await flush();

    // One row, not two: the standing prompt was suppressed, not stacked.
    expect(pane.element.querySelectorAll('.banner-row').length).toBe(1);
    const banner = agentBanner(pane);
    expect(banner?.hasAttribute('open')).toBe(true);
    expect(banner?.textContent).toBe('boom');

    // Dismissing the error restores the standing prompt on the same row.
    banner?.dispatchEvent(new dom.window.Event('close', { bubbles: true, composed: true }));
    expect(banner?.textContent).toContain('Activate an agent in');

    pane.dispose();
  });

  it('routes a send failure to the chat status banner and keeps the typed prompt', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: false } }));
    await flush();

    sendMessage.mockResolvedValueOnce({
      ok: false,
      error: { code: 'PRECONDITION_FAILED', message: 'boom' },
    });

    const field = pane.element.querySelector('.chat-composer__field') as HTMLElement & {
      value: string;
    };
    field.value = 'hello';
    sendButton(pane)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    const statusBanner = pane.element.querySelector('.chat-status-banner');
    expect(statusBanner?.textContent).toBe('boom');
    // The prompt is not lost: the composer restores the field and owns no
    // message of its own (the banner is the one place it is shown).
    expect(field.value).toBe('hello');
    expect(pane.element.querySelector('.chat-composer__notice')).toBeNull();

    pane.dispose();
  });

  it("routes the composer's connecting state to the banner as a loading row", () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });

    // `"starting"` is the service's pre-ready lifecycle state: the composer
    // must say "Connecting to agent...", and the message must live on the pane's
    // single banner, styled as the browser pane's "Loading…" row.
    pushStatus(definedStatus({ serviceState: 'starting' }));

    const banner = agentBanner(pane);
    expect(banner?.hasAttribute('open')).toBe(true);
    expect(banner?.textContent).toBe('Connecting to agent...');
    expect(banner?.classList.contains('banner-row--loading')).toBe(true);
    expect(banner?.querySelector('.banner-row__progress')).not.toBeNull();
    // No duplicate message in the composer.
    expect(pane.element.querySelector('.chat-composer__notice')).toBeNull();

    pane.dispose();
  });

  it('routes a send-blocked reason to the banner once an agent is active and the session is closed', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });

    // Authenticated (so an agent is active) but the session is closed: the
    // composer disables Send and the reason is the banner's standing row.
    pushStatus(
      definedStatus({
        auth: { apiVersion: 1, isAuthenticated: true },
        sessionState: 'closed',
      }),
    );
    await flush();

    const banner = agentBanner(pane);
    expect(sendButton(pane)?.hasAttribute('disabled')).toBe(true);
    expect(banner?.textContent).toBe('This conversation is closed');
    // A plain row, not the loading presentation.
    expect(banner?.classList.contains('banner-row--loading')).toBe(false);
    expect(pane.element.querySelector('.chat-composer__notice')).toBeNull();

    pane.dispose();
  });

  it('New session empties the transcript and opens a genuinely different conversation', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    const firstChatId = (openConversation.mock.calls[0]?.[0] as { chatId: ChatId }).chatId;

    // Send through the real composer so the transcript has content to clear.
    const field = pane.element.querySelector('.chat-composer__field') as HTMLElement & {
      value: string;
    };
    field.value = 'hello';
    sendButton(pane)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    await waitForUserMessage(pane);
    expect(pane.element.querySelectorAll('.chat-message--user').length).toBe(1);
    expect(pane.element.classList.contains('chat-pane--empty')).toBe(false);

    const newSessionButton = pane.element.querySelector('[title="New session"]');
    newSessionButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    // The visible transcript is genuinely gone...
    expect(pane.element.querySelectorAll('.chat-message--user').length).toBe(0);
    expect(pane.element.classList.contains('chat-pane--empty')).toBe(true);
    // ...and a fresh conversation (not the old id re-opened) is now open, so
    // the model carries none of the previous conversation's context.
    expect(openConversation).toHaveBeenCalledTimes(2);
    const newChatIdArg = (openConversation.mock.calls[1]?.[0] as { chatId: ChatId }).chatId;
    expect(newChatIdArg).not.toBe(firstChatId);

    pane.dispose();
  });

  it('New session does nothing before any conversation has been opened', () => {
    // The service is still `starting`, so no `ChatId` has been minted yet:
    // there is no transcript or context to clean up, and the click must not
    // try to open a conversation the gated controller would refuse.
    const pane = createChatPane({ onOpenSettings: vi.fn() });

    const newSessionButton = pane.element.querySelector('[title="New session"]');
    newSessionButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    expect(openConversation).not.toHaveBeenCalled();

    pane.dispose();
  });

  it('follows new transcript entries to the bottom only while the reader is already there', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    // jsdom has no layout, so the scroller's geometry is injected. `New session`
    // repaints the transcript synchronously, which is a repaint path a unit test
    // can drive deterministically (unlike the 100ms timer).
    const transcript = pane.element.querySelector('.chat-transcript') as HTMLElement;
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, get: () => 400 });

    const newSessionButton = pane.element.querySelector('[title="New session"]');

    // Pinned to the bottom (scrollTop 600 === scrollHeight - clientHeight): the
    // repaint follows to the new bottom.
    transcript.scrollTop = 600;
    newSessionButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    expect(transcript.scrollTop).toBe(1000);

    // Scrolled up to read history: the same repaint must not yank the viewport.
    transcript.scrollTop = 100;
    newSessionButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    expect(transcript.scrollTop).toBe(100);

    pane.dispose();
  });

  it('opens a message link in the AEM pane and repaints when the link context changes', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    const chatId = (openConversation.mock.calls[0]?.[0] as { chatId: ChatId }).chatId;
    pushEvent({
      type: 'assistant.message.completed',
      chatId,
      sequence: 0,
      turnId: 'turn-1',
      messageId: 'msg-1',
      content: 'See /content/site/en/page for details.',
    } as AgentEvent);
    await waitForAssistantMessage(pane);

    // No host is active yet, so the bare path is plain text.
    expect(pane.element.querySelector('a[data-daisy-link]')).toBeNull();

    // The shell reports the pane is now on a configured host: the same message
    // is re-rendered and the path becomes an openable link without new text.
    pane.setLinkContext({
      hostOrigins: ['https://author.example'],
      activeOrigin: 'https://author.example',
    });
    const anchor = pane.element.querySelector('a[data-daisy-link]');
    expect(anchor?.getAttribute('href')).toBe('https://author.example/content/site/en/page.html');

    anchor?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();

    expect(navigate).toHaveBeenCalledWith('https://author.example/content/site/en/page.html');

    pane.dispose();
  });
});

describe('createChatPane startup restore', () => {
  function userPromptRecord(chatId: ChatId, turnId: string, prompt: string): ChatJournalRecord {
    return {
      recordType: 'user.prompt',
      at: 1,
      chatId,
      turnId: turnId as TurnId,
      prompt,
    };
  }

  const rememberedConversation = {
    chatId: 'chat-remembered' as ChatId,
    sdkSessionId: 'sdk-remembered' as SdkSessionId,
    records: [
      userPromptRecord('chat-remembered' as ChatId, 'turn-old', 'what did we say?'),
    ] satisfies readonly ChatJournalRecord[],
  };

  it('resumes the remembered conversation, replays its journal, and records it', async () => {
    const onConversationUsed = vi.fn();
    const pane = createChatPane({
      onOpenSettings: vi.fn(),
      resolveStartupConversation: vi.fn().mockResolvedValue(rememberedConversation),
      onConversationUsed,
    });

    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    await waitForUserMessage(pane);

    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(openConversation.mock.calls[0]?.[0]).toEqual({
      chatId: 'chat-remembered',
      resume: { sdkSessionId: 'sdk-remembered' },
    });
    expect(onConversationUsed).toHaveBeenCalledWith('chat-remembered', 'sdk-remembered');
    expect(pane.element.querySelectorAll('.chat-message--user').length).toBe(1);

    pane.dispose();
  });

  it('paints the saved journal before the service is ready, then resumes it', async () => {
    // The whole point of the preload: the journal is local, so the transcript
    // appears while the runtime is still cold-starting (no `ready` status has
    // arrived yet), instead of after it.
    const onConversationUsed = vi.fn();
    const pane = createChatPane({
      onOpenSettings: vi.fn(),
      resolveStartupConversation: vi.fn().mockResolvedValue(rememberedConversation),
      onConversationUsed,
    });

    // No status pushed: the service is still `starting`.
    await waitForUserMessage(pane);

    // The transcript is already on screen, and the banner says what the user is
    // actually waiting on - the session resume, not the generic connecting row.
    expect(pane.element.querySelectorAll('.chat-message--user').length).toBe(1);
    const banner = agentBanner(pane);
    expect(banner?.textContent).toBe('Restoring conversation...');
    expect(banner?.classList.contains('banner-row--loading')).toBe(true);
    // No session has been resumed yet: the pane owns no conversation.
    expect(openConversation).not.toHaveBeenCalled();

    // The runtime becomes ready: the session is resumed with the journal's id.
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(openConversation.mock.calls[0]?.[0]).toEqual({
      chatId: 'chat-remembered',
      resume: { sdkSessionId: 'sdk-remembered' },
    });
    expect(onConversationUsed).toHaveBeenCalledWith('chat-remembered', 'sdk-remembered');

    pane.dispose();
  });

  it('does not resume twice when a status lands while the startup conversation resolves', async () => {
    // Two ready statuses arriving before the startup conversation resolves must
    // not both enter the "no conversation yet" branch and open two
    // conversations; the second sees the first is already in flight and skips.
    let resolveStartup: ((value: StartupConversation | undefined) => void) | undefined;
    const resolveStartupConversation = vi.fn(
      () =>
        new Promise<StartupConversation | undefined>((resolve) => {
          resolveStartup = resolve;
        }),
    );
    const pane = createChatPane({ onOpenSettings: vi.fn(), resolveStartupConversation });

    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    expect(openConversation).not.toHaveBeenCalled();

    resolveStartup?.(rememberedConversation);
    await flush();

    // Resolved once, resumed once - not twice.
    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(openConversation.mock.calls[0]?.[0]).toEqual({
      chatId: 'chat-remembered',
      resume: { sdkSessionId: 'sdk-remembered' },
    });

    pane.dispose();
  });

  it('adopts a conversation main already owns instead of the preloaded one', async () => {
    const pane = createChatPane({
      onOpenSettings: vi.fn(),
      resolveStartupConversation: vi.fn().mockResolvedValue(rememberedConversation),
    });

    // The preload paints the remembered journal before the service is ready.
    await waitForUserMessage(pane);
    expect(pane.element.querySelectorAll('.chat-message--user').length).toBe(1);

    // Main reports it already owns a *different* conversation (a recycled
    // runtime that re-opened one before this pane polled).
    pushStatus(
      definedStatus({
        auth: { apiVersion: 1, isAuthenticated: true },
        activeChatId: 'chat-other' as ChatId,
      }),
    );
    await flush();

    // The stale preloaded journal is dropped and no resume is attempted.
    expect(pane.element.querySelectorAll('.chat-message--user').length).toBe(0);
    expect(openConversation).not.toHaveBeenCalled();

    pane.dispose();
  });

  it('falls back silently to an empty fresh chat when the remembered session cannot be resumed', async () => {
    const onConversationUnavailable = vi.fn();
    openConversation.mockResolvedValueOnce({
      ok: false,
      error: { code: 'RESUME_FAILED', message: 'the session is gone' },
    });
    const pane = createChatPane({
      onOpenSettings: vi.fn(),
      resolveStartupConversation: vi.fn().mockResolvedValue(rememberedConversation),
      onConversationUnavailable,
    });

    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    await flush();

    expect(openConversation).toHaveBeenCalledTimes(2);
    // First attempted with resume, then a genuinely fresh open.
    expect((openConversation.mock.calls[0]?.[0] as { resume?: unknown }).resume).toBeDefined();
    expect((openConversation.mock.calls[1]?.[0] as { resume?: unknown }).resume).toBeUndefined();
    expect(onConversationUnavailable).toHaveBeenCalledTimes(1);
    // Silent - no error banner - and no old transcript under the new session.
    // (The restoring row shown while the journal was on screen collapses once
    // the fresh conversation takes over.)
    await waitForBannerClosed(pane);
    expect(pane.element.querySelectorAll('.chat-message--user').length).toBe(0);

    pane.dispose();
  });

  it('starts fresh when the resolver finds nothing to restore', async () => {
    const pane = createChatPane({
      onOpenSettings: vi.fn(),
      resolveStartupConversation: vi.fn().mockResolvedValue(undefined),
    });

    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    expect(openConversation).toHaveBeenCalledTimes(1);
    expect((openConversation.mock.calls[0]?.[0] as { resume?: unknown }).resume).toBeUndefined();

    pane.dispose();
  });
});
