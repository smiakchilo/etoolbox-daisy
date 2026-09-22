import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatPane, type ChatPane } from '../../../src/renderer/src/shell/chatPane';
import type { AgentChatStatus, AgentSettingsSnapshot, ChatId } from '../../../src/shared';

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
let statusListener: ((status: AgentChatStatus) => void) | undefined;

function definedStatus(overrides: Partial<AgentChatStatus> = {}): AgentChatStatus {
  return {
    apiVersion: 1,
    auth: { apiVersion: 1, isAuthenticated: false },
    activeChatId: null,
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

function sendButton(pane: ChatPane): HTMLElement | null {
  return pane.element.querySelector('.chat-composer__send');
}

function agentBanner(pane: ChatPane): HTMLElement | null {
  return pane.element.querySelector('.chat-status-banner');
}

beforeEach(() => {
  getStatus.mockReset();
  openConversation.mockReset();
  sendMessage.mockReset();
  abort.mockReset();
  statusListener = undefined;

  // Never resolves: the pane's own `void refreshStatus()` at construction must
  // not race the pushed status each test drives. The push is the path under
  // test, and a real push always arrives once the service is ready anyway.
  getStatus.mockImplementation(() => new Promise<AgentChatStatus>(() => undefined));
  openConversation.mockResolvedValue({ ok: true, chatId: 'chat-1' as ChatId });
  sendMessage.mockResolvedValue({ ok: true, turnId: 'turn-1' });
  abort.mockResolvedValue({ ok: true });

  dom = new JSDOM();
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'window', dom.window);
  Reflect.set(dom.window, 'daisy', {
    agentChat: {
      getStatus,
      openConversation,
      sendMessage,
      abort,
      onEvent: vi.fn(() => () => undefined),
      onStatusChanged: vi.fn((listener: (status: AgentChatStatus) => void) => {
        statusListener = listener;
        return () => {
          statusListener = undefined;
        };
      }),
    },
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
});
