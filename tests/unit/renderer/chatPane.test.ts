import type { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BANNER_CLOSING_CLASS } from '../../../src/renderer/src/lib/alertBanner';
import {
  createChatPane,
  type ChatPane,
  type StartupConversation,
} from '../../../src/renderer/src/shell/chatPane';
import type {
  AgentChatOpenResult,
  AgentChatStatus,
  AgentEvent,
  AgentSettingsSnapshot,
  ChatId,
  ChatJournalRecord,
  SdkSessionId,
  TurnId,
} from '../../../src/shared';
import { flushMicrotasks as flush } from '../../support/asyncWaits';
import { installJsdomGlobals } from '../../support/jsdomGlobals';
import { byTestId } from '../../support/selectors';

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

let dom: JSDOM;
let restoreGlobals: () => void;

const getStatus = vi.fn();
const openConversation = vi.fn();
const sendMessage = vi.fn();
const abort = vi.fn();
const respondToInput = vi.fn();
const navigate = vi.fn();
const listSkills = vi.fn();
const revealJournal = vi.fn();
const getModelSelection = vi.fn();
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

async function waitForInterruption(pane: ChatPane): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pane.element.querySelector('.chat-message--interruption') !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the transcript never repainted the interruption notice');
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
  respondToInput.mockReset();
  navigate.mockReset();
  listSkills.mockReset();
  listSkills.mockResolvedValue({ ok: true, skills: [] });
  revealJournal.mockReset();
  revealJournal.mockResolvedValue({ ok: true });
  getModelSelection.mockReset();
  getModelSelection.mockResolvedValue({
    ok: true,
    state: {
      models: [],
      selectedModel: null,
      selectedReasoningEffort: null,
      catalogUnavailable: false,
    },
  });
  statusListener = undefined;
  eventListener = undefined;

  // Never resolves: the pane's own `void refreshStatus()` at construction must
  // not race the pushed status each test drives. The push is the path under
  // test, and a real push always arrives once the service is ready anyway.
  getStatus.mockImplementation(() => new Promise<AgentChatStatus>(() => undefined));
  openConversation.mockResolvedValue({ ok: true, chatId: 'chat-1' as ChatId });
  sendMessage.mockResolvedValue({ ok: true, turnId: 'turn-1' });
  abort.mockResolvedValue({ ok: true });
  respondToInput.mockResolvedValue({ ok: true });
  navigate.mockResolvedValue({ ok: true });

  ({ dom, restore: restoreGlobals } = installJsdomGlobals());
  Reflect.set(dom.window, 'daisy', {
    agentChat: {
      getStatus,
      openConversation,
      sendMessage,
      abort,
      respondToInput,
      listSkills,
      revealJournal,
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
    browser: {
      navigate,
      find: vi.fn(() => Promise.resolve({ ok: true })),
      stopFind: vi.fn(() => Promise.resolve({ ok: true })),
      onFindResult: vi.fn(() => () => undefined),
    },
    settings: { getModelSelection },
  });
});

afterEach(() => {
  restoreGlobals();
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
    expect(banner?.hasAttribute('open')).toBe(true);
    expect(banner?.textContent).not.toBe('boom');
    expect(banner?.textContent?.length).toBeGreaterThan(0);

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

    pane.dispose();
  });

  it('shows a turn error in the dismissible banner and recovers the composer', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    const chatId = (openConversation.mock.calls[0]?.[0] as { chatId: ChatId }).chatId;
    pushEvent({
      type: 'session.state.changed',
      chatId,
      sequence: 0,
      turnId: 'turn-1',
      state: 'sending',
    } as AgentEvent);
    pushEvent({
      type: 'error',
      chatId,
      sequence: 1,
      turnId: 'turn-1',
      error: {
        code: 'AGENT_UNAVAILABLE',
        message: 'The OpenRouter request failed',
        requestId: 'req-1',
        retryable: true,
        requiredAction: 'sign_in_to_agent',
      },
    } as AgentEvent);

    // The error has no transcript item, so the pane's one row carries it, and
    // it is dismissible.
    const banner = agentBanner(pane);
    expect(banner?.textContent).toBe('The OpenRouter request failed');
    expect(banner?.hasAttribute('dismissible')).toBe(true);

    // The adapter recovers the session to idle with a chat-scoped event, which
    // re-enables Send instead of wedging it.
    pushEvent({ type: 'session.state.changed', chatId, sequence: 2, state: 'idle' });
    expect(sendButton(pane)?.hasAttribute('disabled')).toBe(false);

    pane.dispose();
  });

  it("a new prompt discards the previous turn's error banner", async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    const chatId = (openConversation.mock.calls[0]?.[0] as { chatId: ChatId }).chatId;
    pushEvent({
      type: 'error',
      chatId,
      sequence: 0,
      turnId: 'turn-1',
      error: {
        code: 'AGENT_UNAVAILABLE',
        message: 'Request rejected. Try another model',
        requestId: 'req-1',
        retryable: true,
        requiredAction: 'sign_in_to_agent',
      },
    } as AgentEvent);
    // The adapter's own recovery: the turn ended, the session is idle again.
    pushEvent({ type: 'session.state.changed', chatId, sequence: 1, state: 'idle' });
    expect(agentBanner(pane)?.textContent).toBe('Request rejected. Try another model');
    expect(sendButton(pane)?.hasAttribute('disabled')).toBe(false);

    // The user retries - another model chosen - and the send is accepted.
    const field = pane.element.querySelector('.chat-composer__field') as HTMLElement & {
      value: string;
    };
    field.value = 'try again';
    sendButton(pane)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    await waitForUserMessage(pane);

    // The error described the superseded attempt, so it is gone.
    await waitForBannerClosed(pane);
    expect(agentBanner(pane)?.hasAttribute('open')).toBe(false);

    pane.dispose();
  });

  it('New session discards a previous error banner', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    const chatId = (openConversation.mock.calls[0]?.[0] as { chatId: ChatId }).chatId;
    pushEvent({
      type: 'error',
      chatId,
      sequence: 0,
      turnId: 'turn-1',
      error: {
        code: 'AGENT_UNAVAILABLE',
        message: 'Request rejected. Try another model',
        requestId: 'req-1',
        retryable: true,
        requiredAction: 'sign_in_to_agent',
      },
    } as AgentEvent);
    expect(agentBanner(pane)?.textContent).toBe('Request rejected. Try another model');

    const newSessionButton = pane.element.querySelector(byTestId('chat-new-session'));
    newSessionButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    // A brand-new conversation cannot be carrying the old one's error.
    await waitForBannerClosed(pane);
    expect(agentBanner(pane)?.hasAttribute('open')).toBe(false);

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
    expect(banner?.textContent?.length).toBeGreaterThan(0);
    expect(banner?.querySelector('.banner-row__progress')).not.toBeNull();

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
    expect(banner?.hasAttribute('open')).toBe(true);
    expect(banner?.textContent?.length).toBeGreaterThan(0);
    // A plain row, not the loading presentation.
    expect(banner?.querySelector('.banner-row__progress')).toBeNull();

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

    const newSessionButton = pane.element.querySelector(byTestId('chat-new-session'));
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

  it('New session focuses the composer so the fresh conversation is ready to type into', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    const field = pane.element.querySelector('.chat-composer__field') as HTMLElement;
    const focusSpy = vi.spyOn(field, 'focus');

    const newSessionButton = pane.element.querySelector(byTestId('chat-new-session'));
    newSessionButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    expect(focusSpy).toHaveBeenCalledTimes(1);

    pane.dispose();
    focusSpy.mockRestore();
  });

  it('New session does nothing before any conversation has been opened', () => {
    // The service is still `starting`, so no `ChatId` has been minted yet:
    // there is no transcript or context to clean up, and the click must not
    // try to open a conversation the gated controller would refuse.
    const pane = createChatPane({ onOpenSettings: vi.fn() });

    const newSessionButton = pane.element.querySelector(byTestId('chat-new-session'));
    // It is genuinely disabled, not merely inert: with nothing to act on, the
    // control must not look actionable.
    expect(newSessionButton?.hasAttribute('disabled')).toBe(true);
    newSessionButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    expect(openConversation).not.toHaveBeenCalled();

    pane.dispose();
  });

  it('follows new transcript entries while the reader is at the bottom, and jumps when the reader sends', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    // jsdom has no layout, so the scroller's geometry is injected. Intent is
    // tracked from real `scroll` events, which jsdom does not fire on a
    // programmatic `scrollTop` change, so each simulated scroll dispatches one.
    const transcript = pane.element.querySelector('.chat-transcript') as HTMLElement;
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, get: () => 400 });

    // A link-context change repaints the transcript without pinning it, so it is
    // a repaint path a unit test can drive deterministically (unlike the 100ms
    // timer) without itself being a "jump to bottom" action.
    function repaintWithoutPinning(origin: string): void {
      pane.setLinkContext({ hostOrigins: [origin], activeOrigin: origin });
    }

    // Pinned to the bottom (scrollTop 600 === scrollHeight - clientHeight): the
    // repaint follows to the new bottom.
    transcript.scrollTop = 600;
    transcript.dispatchEvent(new dom.window.Event('scroll'));
    repaintWithoutPinning('https://a.example');
    expect(transcript.scrollTop).toBe(1000);

    // Scrolled up to read history: the same repaint must not yank the viewport.
    transcript.scrollTop = 100;
    transcript.dispatchEvent(new dom.window.Event('scroll'));
    repaintWithoutPinning('https://b.example');
    expect(transcript.scrollTop).toBe(100);

    // Sending is deliberate: it jumps back to the bottom even though the reader
    // was scrolled up.
    const field = pane.element.querySelector('.chat-composer__field') as HTMLElement & {
      value: string;
    };
    field.value = 'hello';
    sendButton(pane)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    expect(transcript.scrollTop).toBe(1000);

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

  it('routes a message link to the browser pane when the shell wires it', async () => {
    const onNavigateInBrowser = vi.fn();
    const pane = createChatPane({ onOpenSettings: vi.fn(), onNavigateInBrowser });
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

    pane.setLinkContext({
      hostOrigins: ['https://author.example'],
      activeOrigin: 'https://author.example',
    });
    const anchor = pane.element.querySelector('a[data-daisy-link]');
    anchor?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();

    expect(onNavigateInBrowser).toHaveBeenCalledWith(
      'https://author.example/content/site/en/page.html',
    );
    // The browser pane owns the navigation (and its failure) now: this pane
    // must not call the browser IPC directly, which would land the error in
    // the chat banner instead of the browser pane.
    expect(navigate).not.toHaveBeenCalled();

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
    expect(banner?.textContent?.length).toBeGreaterThan(0);
    expect(banner?.querySelector('.banner-row__progress')).not.toBeNull();
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

  it('does not leave the restoring banner stuck when main adopts the chat before the journal paints', async () => {
    // A renderer reload (right-click > Reload in the app surface, or an
    // HMR-driven reload in dev) keeps the main process alive: main still owns
    // the conversation the pane last opened. If that ready status resolves
    // *before* the slower local journal read, the pane adopts the id while
    // `pendingStartup` is still undefined; the later journal paint then sets
    // `pendingStartup`, and nothing ever clears it (the ready path only clears
    // it while the pane owns no chat) - so "Restoring conversation..." stays up
    // forever.
    let resolveStartup: ((value: StartupConversation | undefined) => void) | undefined;
    const resolveStartupConversation = vi.fn(
      () =>
        new Promise<StartupConversation | undefined>((resolve) => {
          resolveStartup = resolve;
        }),
    );
    const pane = createChatPane({ onOpenSettings: vi.fn(), resolveStartupConversation });

    // Ready status first: main reports it already owns the remembered chat.
    pushStatus(
      definedStatus({
        auth: { apiVersion: 1, isAuthenticated: true },
        activeChatId: rememberedConversation.chatId,
      }),
    );
    await flush();

    // Then the journal read lands and paints the remembered conversation.
    resolveStartup?.(rememberedConversation);
    await flush();
    await waitForUserMessage(pane);

    // The adopted conversation already satisfies the restore: the restoring
    // row must not remain on screen.
    await waitForBannerClosed(pane);
    expect(agentBanner(pane)?.textContent).not.toBe('Restoring conversation...');

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

describe('createChatPane skill catalogue', () => {
  // The `/` popup itself is a Spectrum overlay/popover, which jsdom cannot
  // register, so the popup's contents are asserted by the E2E
  // (`skill-autocomplete.spec.ts`). These cover the catalogue read the pane
  // owns: when it happens, the loading row, and that a failure stays silent.

  it('reads the catalogue once after ready and shows a loading row until it lands', async () => {
    let resolveSkills:
      ((value: { ok: true; skills: { name: string; description: string }[] }) => void) | undefined;
    listSkills.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSkills = resolve;
      }),
    );

    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    expect(listSkills).toHaveBeenCalledTimes(1);
    expect(agentBanner(pane)?.hasAttribute('open')).toBe(true);
    expect(agentBanner(pane)?.textContent?.length).toBeGreaterThan(0);

    resolveSkills?.({ ok: true, skills: [{ name: 'search', description: 'query' }] });
    await flush();
    await waitForBannerClosed(pane);

    pane.dispose();
  });

  it('reads the catalogue only once across repeated ready statuses', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });

    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    expect(listSkills).toHaveBeenCalledTimes(1);

    pane.dispose();
  });

  it('stays silent when the catalogue cannot be read, and does not retry', async () => {
    listSkills.mockResolvedValueOnce({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'unreadable' },
    });

    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    await waitForBannerClosed(pane);

    expect(agentBanner(pane)?.hasAttribute('open')).toBe(false);
    expect(listSkills).toHaveBeenCalledTimes(1);

    pane.dispose();
  });
});

describe('createChatPane interruptions and session id', () => {
  async function readyPane(promptText?: string): Promise<ChatPane> {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    if (promptText !== undefined) {
      const field = pane.element.querySelector('.chat-composer__field') as HTMLElement & {
        value: string;
      };
      field.value = promptText;
      sendButton(pane)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await flush();
      await waitForUserMessage(pane);
    }
    return pane;
  }

  function currentChatId(): ChatId {
    return (openConversation.mock.calls[0]?.[0] as { chatId: ChatId }).chatId;
  }

  function sessionState(
    chatId: ChatId,
    sequence: number,
    state: 'sending' | 'cancelling' | 'idle',
  ): AgentEvent {
    return {
      type: 'session.state.changed',
      chatId,
      sequence,
      turnId: 'turn-1',
      state,
    } as AgentEvent;
  }

  it("records a user Stop as 'Session stopped' when the cancellation event arrives", async () => {
    const pane = await readyPane();
    const chatId = currentChatId();

    pushEvent(sessionState(chatId, 0, 'sending'));
    const field = pane.element.querySelector(byTestId('chat-composer-field')) as HTMLElement;
    const focusSpy = vi.spyOn(field, 'focus');
    const stop = pane.element.querySelector('.chat-composer__stop');
    expect(stop).not.toBeNull();
    stop?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    expect(abort).toHaveBeenCalledTimes(1);
    // The keyboard returns to the prompt field after the Cancel.
    expect(focusSpy).toHaveBeenCalled();
    focusSpy.mockRestore();

    pushEvent(sessionState(chatId, 1, 'cancelling'));
    await waitForInterruption(pane);

    const notice = pane.element.querySelector('.chat-message--interruption');
    expect(
      notice?.querySelector('.chat-message__interruption-label')?.textContent?.length,
    ).toBeGreaterThan(0);
    // A live stopped notice offers the Resume action.
    expect(notice?.querySelector('[data-interruption-resume]')).not.toBeNull();

    pane.dispose();
  });

  it('sends "Resume" as an ordinary prompt when the notice action is pressed', async () => {
    const pane = await readyPane();
    const chatId = currentChatId();

    pushEvent(sessionState(chatId, 0, 'sending'));
    const stop = pane.element.querySelector('.chat-composer__stop');
    stop?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    pushEvent(sessionState(chatId, 1, 'cancelling'));
    await waitForInterruption(pane);
    // The turn has actually stopped (idle) before the reader reaches for Resume.
    pushEvent(sessionState(chatId, 2, 'idle'));

    sendMessage.mockResolvedValueOnce({ ok: true, turnId: 'turn-resume' as TurnId });
    const resume = pane.element.querySelector('[data-interruption-resume]');
    expect(resume).not.toBeNull();
    resume?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();

    expect(sendMessage).toHaveBeenCalledWith({ chatId, prompt: 'Resume' });

    pane.dispose();
  });

  it("records an application abort with no Stop as 'Session interrupted by navigation'", async () => {
    const pane = await readyPane();
    const chatId = currentChatId();

    pushEvent(sessionState(chatId, 0, 'sending'));
    pushEvent(sessionState(chatId, 1, 'cancelling'));
    await waitForInterruption(pane);

    expect(pane.element.querySelector('.chat-message--interruption')?.textContent).toBe(
      'Session interrupted by navigation',
    );

    pane.dispose();
  });

  it('delivers a "no answer" rather than aborting when Stop is pressed on a pending question', async () => {
    const pane = await readyPane();
    const chatId = currentChatId();

    pushEvent(sessionState(chatId, 0, 'sending'));
    pushEvent({
      type: 'user.input.requested',
      chatId,
      sequence: 1,
      turnId: 'turn-1',
      requestId: 'req-1',
      question: 'Pick a colour',
      options: ['Red', 'Green'],
      multiple: false,
      freeInput: false,
    } as AgentEvent);
    await flush();

    const stop = pane.element.querySelector('.chat-composer__stop');
    expect(stop).not.toBeNull();
    const field = pane.element.querySelector(byTestId('chat-composer-field')) as HTMLElement;
    const focusSpy = vi.spyOn(field, 'focus');
    stop?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    // The question's cancel is a "no answer", never an abort of the turn: the
    // ask_user tool reports the decline and the model wraps up.
    expect(abort).not.toHaveBeenCalled();
    expect(respondToInput).toHaveBeenCalledWith({
      chatId,
      requestId: 'req-1',
      answer: { selections: [], freeform: null },
    });
    // And the interactive UI is dismissed, back to the ordinary composer, with
    // the keyboard already in the field so the user can type straight away.
    expect(pane.element.querySelector('.chat-ask')?.hasAttribute('hidden')).toBe(true);
    expect(focusSpy).toHaveBeenCalled();
    focusSpy.mockRestore();

    pane.dispose();
  });

  describe('live-added question actions', () => {
    const actionLabels = (pane: ReturnType<typeof createChatPane>): (string | null)[] =>
      [...pane.element.querySelectorAll('.chat-ask__action')].map((b) => b.textContent);

    async function paneWithActionsQuestion() {
      const pane = await readyPane();
      const chatId = currentChatId();
      pushEvent(sessionState(chatId, 0, 'sending'));
      pushEvent({
        type: 'user.input.requested',
        chatId,
        sequence: 1,
        turnId: 'turn-1',
        requestId: 'req-1',
        actions: ['Load more'],
        multiple: false,
        freeInput: false,
      } as AgentEvent);
      await flush();
      return { pane, chatId };
    }

    const added = (chatId: ChatId, requestId: string): AgentEvent =>
      ({
        type: 'user.input.actions.added',
        chatId,
        sequence: 0,
        turnId: 'turn-1',
        requestId,
        actions: ['Load all'],
      }) as AgentEvent;

    it('adds a button to the pending question it belongs to', async () => {
      const { pane, chatId } = await paneWithActionsQuestion();

      pushEvent(added(chatId, 'req-1'));
      await flush();

      expect(actionLabels(pane)).toEqual(['Load more', 'Load all']);
      pane.dispose();
    });

    it('ignores an addition for a question that is no longer the pending one', async () => {
      const { pane, chatId } = await paneWithActionsQuestion();

      pushEvent(added(chatId, 'req-0'));
      await flush();

      expect(actionLabels(pane)).toEqual(['Load more']);
      pane.dispose();
    });
  });

  it('shows the reveal icon in the footer once the conversation has content, and reveals the log on click', async () => {
    const pane = await readyPane('hello');
    const chatId = currentChatId();

    const anchor = pane.element.querySelector<HTMLAnchorElement>('.chat-session-id');
    expect(anchor?.getAttribute('aria-label')?.length).toBeGreaterThan(0);
    expect(anchor?.firstElementChild).not.toBeNull();
    expect(pane.element.querySelector('.chat-pane__footer')?.hasAttribute('hidden')).toBe(false);

    anchor?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();

    expect(revealJournal).toHaveBeenCalledWith({ chatId });

    pane.dispose();
  });

  it('summarises agent / model / reasoning and opens Settings on the Agents tab when clicked', async () => {
    getModelSelection.mockResolvedValue({
      ok: true,
      state: {
        models: [
          {
            id: 'gpt-5',
            name: 'GPT-5 Turbo',
            supportedReasoningEfforts: ['low', 'high'],
            defaultReasoningEffort: 'high',
          },
        ],
        selectedModel: 'gpt-5',
        selectedReasoningEffort: 'high',
        catalogUnavailable: false,
      },
    });
    const onOpenSettings = vi.fn();
    const pane = createChatPane({ onOpenSettings });
    pane.setAgents({
      copilot: { active: true, hasToken: true, model: 'gpt-5', reasoningEffort: 'high' },
    });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    const field = pane.element.querySelector('.chat-composer__field') as HTMLElement & {
      value: string;
    };
    field.value = 'hello';
    sendButton(pane)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    await waitForUserMessage(pane);
    await flush();

    const summary = pane.element.querySelector<HTMLAnchorElement>('.chat-agent-summary');
    expect(summary?.textContent).toContain('GPT-5 Turbo');

    summary?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onOpenSettings).toHaveBeenCalledWith('agents');

    pane.dispose();
  });

  it('follows a model change re-pushed through setAgents, so the footer never shows a stale model', async () => {
    getModelSelection.mockResolvedValue({
      ok: true,
      state: {
        models: [
          {
            id: 'gpt-5',
            name: 'GPT-5 Turbo',
            supportedReasoningEfforts: ['low', 'high'],
            defaultReasoningEffort: 'high',
          },
          { id: 'claude-sonnet', name: 'Claude Sonnet', supportedReasoningEfforts: [] },
        ],
        selectedModel: 'gpt-5',
        selectedReasoningEffort: 'high',
        catalogUnavailable: false,
      },
    });
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({
      copilot: { active: true, hasToken: true, model: 'gpt-5', reasoningEffort: 'high' },
    });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    const field = pane.element.querySelector('.chat-composer__field') as HTMLElement & {
      value: string;
    };
    field.value = 'hello';
    sendButton(pane)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    await waitForUserMessage(pane);
    await flush();

    const summary = pane.element.querySelector<HTMLAnchorElement>('.chat-agent-summary');
    expect(summary?.textContent).toContain('GPT-5 Turbo');

    // The shell re-applies the snapshot after a Settings model change; the
    // footer must follow it rather than keep the model it showed before.
    pane.setAgents({
      copilot: { active: true, hasToken: true, model: 'claude-sonnet' },
    });
    await flush();

    expect(summary?.textContent).toContain('Claude Sonnet');
    expect(summary?.textContent).not.toContain('GPT-5 Turbo');

    pane.dispose();
  });

  it('falls back to the raw model id when the catalogue has not loaded, and reads (Auto) for unset values', async () => {
    getModelSelection.mockResolvedValue({
      ok: false,
      error: { code: 'STORAGE_ERROR', message: 'unavailable' },
    });
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({
      copilot: { active: true, hasToken: true, model: 'vendor/model-x' },
    });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    const field = pane.element.querySelector('.chat-composer__field') as HTMLElement & {
      value: string;
    };
    field.value = 'hello';
    sendButton(pane)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    await waitForUserMessage(pane);
    await flush();

    expect(pane.element.querySelector('.chat-agent-summary')?.textContent).toBe(
      'GitHub Copilot / vendor/model-x / (Auto)',
    );

    pane.dispose();
  });

  it('hides the summary line while no agent is active, keeping the reveal icon', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pushStatus(definedStatus());
    await flush();
    const chatId = currentChatId();

    pushEvent({
      type: 'assistant.message.completed',
      chatId,
      sequence: 0,
      turnId: 'turn-1',
      messageId: 'msg-1',
      content: 'hello',
    } as AgentEvent);
    await waitForAssistantMessage(pane);

    expect(pane.element.querySelector('.chat-agent-summary')?.hasAttribute('hidden')).toBe(true);
    expect(pane.element.querySelector('.chat-session-id')?.hasAttribute('hidden')).toBe(false);

    pane.dispose();
  });

  it('shows the agent summary but hides the reveal icon while the conversation is empty', async () => {
    const pane = await readyPane();

    // The full-height composer still shows the footer's summary - it is useful
    // before the first prompt - while the reveal-log icon, which needs a
    // conversation with content to reveal, stays hidden.
    expect(pane.element.querySelector('.chat-pane__footer')?.hasAttribute('hidden')).toBe(false);
    expect(pane.element.querySelector('.chat-agent-summary')?.hasAttribute('hidden')).toBe(false);
    expect(pane.element.querySelector('.chat-session-id')?.hasAttribute('hidden')).toBe(true);

    pane.dispose();
  });

  it('holds a send until an in-flight open resolves, so it is never refused as "not the open conversation"', async () => {
    const pane = await readyPane();
    expect(openConversation).toHaveBeenCalledTimes(1);

    // The next open (New session) hangs until we release it.
    let release: ((value: AgentChatOpenResult) => void) | undefined;
    openConversation.mockImplementationOnce(
      () =>
        new Promise<AgentChatOpenResult>((resolve) => {
          release = resolve;
        }),
    );

    const newSessionButton = pane.element.querySelector(byTestId('chat-new-session'));
    newSessionButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    const newChatId = (openConversation.mock.calls[1]?.[0] as { chatId: ChatId }).chatId;

    const field = pane.element.querySelector('.chat-composer__field') as HTMLElement & {
      value: string;
    };
    field.value = 'hello';
    sendButton(pane)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();

    // The send waits for the open rather than racing it (which the service
    // would refuse: the new id is adopted before the open resolves).
    expect(sendMessage).not.toHaveBeenCalled();

    release?.({ ok: true, chatId: newChatId });
    await flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ chatId: newChatId, prompt: 'hello' });

    pane.dispose();
  });
});

describe('createChatPane conversation open serialization', () => {
  const rememberedConversation = {
    chatId: 'chat-remembered' as ChatId,
    sdkSessionId: 'sdk-remembered' as SdkSessionId,
    records: [] as readonly ChatJournalRecord[],
  };

  function newSessionButton(pane: ChatPane): HTMLElement | null {
    return pane.element.querySelector(byTestId('chat-new-session'));
  }

  it('disables "New session" while an open is in flight, and re-enables it when the open settles', async () => {
    let release: ((value: AgentChatOpenResult) => void) | undefined;
    openConversation.mockImplementationOnce(
      () =>
        new Promise<AgentChatOpenResult>((resolve) => {
          release = resolve;
        }),
    );

    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();

    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(newSessionButton(pane)?.hasAttribute('disabled')).toBe(true);

    release?.({ ok: true, chatId: 'chat-1' as ChatId });
    await flush();

    expect(newSessionButton(pane)?.hasAttribute('disabled')).toBe(false);
    pane.dispose();
  });

  it('swallows a superseded open instead of surfacing its failure', async () => {
    let releaseFirst: ((value: AgentChatOpenResult) => void) | undefined;
    openConversation
      .mockImplementationOnce(
        () =>
          new Promise<AgentChatOpenResult>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve({ ok: true, chatId: 'chat-2' as ChatId }));

    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    expect(openConversation).toHaveBeenCalledTimes(1);

    // A second status says main owns nothing while the pane has adopted its id:
    // the recovery re-opens it, superseding the still-pending first open.
    pushStatus(
      definedStatus({ auth: { apiVersion: 1, isAuthenticated: true }, activeChatId: null }),
    );
    await flush();
    expect(openConversation).toHaveBeenCalledTimes(2);

    // The superseded first open fails - it must not become the pane's banner.
    releaseFirst?.({ ok: false, error: { code: 'AGENT_UNAVAILABLE', message: 'stale' } });
    await flush();

    // Waits out the banner's collapse animation if a standing row was up; a
    // wrongly-surfaced error would keep it open and time this out.
    await waitForBannerClosed(pane);
    expect(agentBanner(pane)?.textContent ?? '').not.toContain('stale');
    pane.dispose();
  });

  it('does not run the resume-failure fallback when a superseded resume open fails', async () => {
    const onConversationUnavailable = vi.fn();
    let releaseResume: ((value: AgentChatOpenResult) => void) | undefined;
    openConversation
      .mockImplementationOnce(
        () =>
          new Promise<AgentChatOpenResult>((resolve) => {
            releaseResume = resolve;
          }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: true, chatId: 'chat-remembered' as ChatId }),
      );

    const pane = createChatPane({
      onOpenSettings: vi.fn(),
      resolveStartupConversation: vi.fn().mockResolvedValue(rememberedConversation),
      onConversationUnavailable,
    });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    expect(openConversation).toHaveBeenCalledTimes(1);

    pushStatus(
      definedStatus({ auth: { apiVersion: 1, isAuthenticated: true }, activeChatId: null }),
    );
    await flush();
    expect(openConversation).toHaveBeenCalledTimes(2);

    // The superseded resume reports failure; the pane must NOT clear the saved
    // pointer or start a fresh chat over the one the recovery now owns.
    releaseResume?.({ ok: false, error: { code: 'AGENT_UNAVAILABLE', message: 'session gone' } });
    await flush();

    expect(onConversationUnavailable).not.toHaveBeenCalled();
    expect(openConversation).toHaveBeenCalledTimes(2);
    pane.dispose();
  });

  it('keeps "Restoring conversation..." up and Send disabled for the whole resume, then clears both', async () => {
    let release: ((value: AgentChatOpenResult) => void) | undefined;
    openConversation.mockImplementationOnce(
      () =>
        new Promise<AgentChatOpenResult>((resolve) => {
          release = resolve;
        }),
    );

    const pane = createChatPane({
      onOpenSettings: vi.fn(),
      resolveStartupConversation: vi.fn().mockResolvedValue(rememberedConversation),
    });
    pane.setAgents({ copilot: { active: true, hasToken: true } });
    pushStatus(definedStatus({ auth: { apiVersion: 1, isAuthenticated: true } }));
    await flush();
    expect(openConversation).toHaveBeenCalledTimes(1);

    // A concurrent status poll re-derives the presentation while the resume
    // open is still in flight. It reports main now owning the resumed chat id,
    // so it takes the ordinary refresh path rather than re-opening.
    pushStatus(
      definedStatus({
        auth: { apiVersion: 1, isAuthenticated: true },
        activeChatId: rememberedConversation.chatId,
      }),
    );
    await flush();

    // The resume is the work the user is waiting on, so the row names it (not
    // the generic connecting row) and nothing is sendable yet.
    const banner = agentBanner(pane);
    expect(banner?.textContent?.length).toBeGreaterThan(0);
    expect(banner?.querySelector('.banner-row__progress')).not.toBeNull();
    // Still up, not mid-collapse: the row covers the resume, not just the wait
    // before it (clearing `pendingStartup` early would start the collapse here).
    expect(banner?.hasAttribute('open')).toBe(true);
    expect(banner?.classList.contains(BANNER_CLOSING_CLASS)).toBe(false);
    expect(sendButton(pane)?.hasAttribute('disabled')).toBe(true);
    expect(newSessionButton(pane)?.hasAttribute('disabled')).toBe(true);

    release?.({ ok: true, chatId: rememberedConversation.chatId });
    await flush();

    // Resume settled: the row comes down and both controls are live again.
    await waitForBannerClosed(pane);
    expect(sendButton(pane)?.hasAttribute('disabled')).toBe(false);
    expect(newSessionButton(pane)?.hasAttribute('disabled')).toBe(false);
    pane.dispose();
  });

  it('enables "New session" once the pane adopts a conversation main already owns', async () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    pane.setAgents({ copilot: { active: true, hasToken: true } });

    // Nothing owned yet: the control has nothing to act on.
    expect(newSessionButton(pane)?.hasAttribute('disabled')).toBe(true);

    // Main already owns a conversation (a recycled runtime or a renderer
    // reload): the pane adopts it without an open of its own.
    pushStatus(
      definedStatus({
        auth: { apiVersion: 1, isAuthenticated: true },
        activeChatId: 'chat-owned' as ChatId,
      }),
    );
    await flush();

    expect(openConversation).not.toHaveBeenCalled();
    expect(newSessionButton(pane)?.hasAttribute('disabled')).toBe(false);
    pane.dispose();
  });
});

describe('createChatPane find bar', () => {
  it('reveals and hides its find bar through openFind/closeFind', () => {
    const pane = createChatPane({ onOpenSettings: vi.fn() });
    const bar = pane.element.querySelector<HTMLElement>(byTestId('chat-find'));

    expect(bar?.hidden).toBe(true);

    pane.openFind();
    expect(bar?.hidden).toBe(false);

    pane.closeFind();
    expect(bar?.hidden).toBe(true);
    pane.dispose();
  });
});
