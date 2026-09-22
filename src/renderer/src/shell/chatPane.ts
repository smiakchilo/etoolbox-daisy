import { el } from '../lib/dom';
import { buildBannerCopy, createBannerActionButton } from '../lib/alertBanner';
import { createChatToolbar } from './chatToolbar';
import type { SettingsTab } from './settingsPanel';
import { createComposer, type ComposerSendOutcome } from '../chat/composer';
import { createStatusBanner, type StatusBanner } from '../settings/statusBanner';
import {
  computeComposerButtonState,
  describeCanSendBlockReason,
  isTurnInFlight,
} from '../chat/composerViewModel';
import { createTranscriptStore, type TranscriptStore } from '../chat/transcriptStore';
import { createTranscriptView, type TranscriptView } from '../chat/transcriptView';
import {
  AGENT_DEFINITIONS,
  applyAgentEvent,
  type AgentChatStatus,
  type AgentServiceLifecycleState,
  type AgentSettingsSnapshot,
  type CanSendBlockReason,
  type ChatId,
  newChatId,
  resolveEffectiveActiveAgentId,
  type SessionStatus,
} from '../../../shared';

export interface ChatPane {
  readonly element: HTMLElement;
  /**
   * Updates the persisted per-provider flags (from the settings snapshot). The
   * pane derives which agent is *actually* active - configured-and-eligible,
   * else the first eligible provider, else none - on every auth change, so the
   * banner and composer always agree with the Settings badge and with each
   * other.
   */
  setAgents(agents: Readonly<Record<string, AgentSettingsSnapshot>>): void;
  /** Unsubscribes from the agent-chat event stream and stops all polling/repaint timers. */
  dispose(): void;
}

/** How often the transcript checks for and applies pending changes (`transcriptStore.takeDirty`). */
const TRANSCRIPT_REPAINT_INTERVAL_MS = 100;

/** How often to re-check `getStatus()` while `serviceState` is still `"starting"` - there is no push event for it becoming `"ready"` (see `agent-chat-ipc.ts`). */
const STARTING_POLL_INTERVAL_MS = 500;

/**
 * How often to re-check `getStatus()` once ready. A live auth change or a
 * runtime recycle now arrives immediately on the `agent-chat:status-changed`
 * push (see `unsubscribeStatus` below); this slow poll is only the fallback
 * that heals a missed push or a push that failed to parse, so it can afford to
 * be infrequent.
 */
const READY_POLL_INTERVAL_MS = 15_000;

/**
 * The chat pane's single banner row's surface class. Deliberately distinct from
 * the Settings slot's `settings-banner` and the browser pane's
 * `browser-toolbar-message`, so the rows never collide in a Playwright
 * strict-mode locator when Settings is open over the chat pane, and the shared
 * `banner.css` rules can tell them apart.
 *
 * The chat pane owns exactly one `sp-alert-banner`. Its standing
 * (lowest-priority) presentation is the composer's own message for the current
 * state - "Connecting to agent..." (the shared loading row), the "no usable
 * agent" prompt, or a send-blocked reason - so a later error/status suppresses
 * it instead of stacking a second banner beneath it, and suppressing the
 * composer's inline notice entirely (see `refreshSessionPresentation`).
 */
const CHAT_STATUS_BANNER_SURFACE_CLASS = 'chat-status-banner';

/**
 * The right-hand chat pane: toolbar, transcript, and composer, wired to the
 * `agent-chat:*` IPC surface (`window.daisy.agentChat`).
 */
export interface ChatPaneOptions {
  /**
   * Invoked to reveal the in-shell Settings panel. The toolbar's Settings
   * button calls it with no tab (leaving the last selection alone); the agent
   * banner calls it with `"agents"` so it lands on the tab that fixes the
   * condition it is reporting.
   */
  readonly onOpenSettings: (tab?: SettingsTab) => void;
}

export function createChatPane(options: ChatPaneOptions): ChatPane {
  const transcriptStore: TranscriptStore = createTranscriptStore();
  const transcriptView: TranscriptView = createTranscriptView();

  // The standing "no usable agent" prompt, built once and reused: it is the
  // banner row's lowest-priority presentation (see `refreshSessionPresentation`
  // below). The Settings control sits *inside* the sentence, so the copy is a
  // `buildBannerCopy` span rather than `buildBannerPrompt`'s trailing action
  // group. Its click handler survives being swapped out and back in, because
  // the same button node is reused.
  const agentSettingsButton = createBannerActionButton('Settings');
  agentSettingsButton.addEventListener('click', () => options.onOpenSettings('agents'));
  const agentPromptContent: readonly Node[] = [
    buildBannerCopy(['Activate an agent in ', agentSettingsButton, ' to send messages']),
  ];

  // The composer's own messages, now all carried by this pane's single banner
  // (the composer has no notice of its own). "Connecting to agent..." uses the
  // shared loading presentation - the same light-gray fill and progress line as
  // the browser pane's "Loading\u2026" row - because it, too, describes work in
  // flight. Built once so re-asserting it on every status refresh is a no-op.
  const connectingContent: readonly Node[] = [buildBannerCopy(['Connecting to agent...'])];

  // A send-blocked reason is a persistent plain row. Memoised per reason so a
  // caller re-asserting the same state never rebuilds the DOM.
  const blockReasonContent = new Map<CanSendBlockReason, readonly Node[]>();
  function contentForBlockReason(reason: CanSendBlockReason): readonly Node[] {
    const existing = blockReasonContent.get(reason);
    if (existing !== undefined) return existing;
    const content: readonly Node[] = [buildBannerCopy([describeCanSendBlockReason(reason)])];
    blockReasonContent.set(reason, content);
    return content;
  }

  // `browserReady` is never learned by this pane (`AgentChatStatus` does not
  // report it, and `canSendMessage` - see `composerViewModel.ts` - never
  // reads it either); this placeholder is the only field on `SessionStatus`
  // this pane cannot populate from a real source. `sessionState.ts`'s own
  // doc comment is explicit that `canRunAemTool`, not `canSendMessage`, is
  // the only consumer of this field, and that function is not used here.
  let sessionStatus: SessionStatus = { state: 'idle', authenticated: false, browserReady: false };
  let serviceState: AgentServiceLifecycleState = 'starting';
  // The persisted per-provider flags, replaced on every settings reload. Until
  // the shell hands over the real snapshot this is empty, so no agent is active
  // and the banner stays hidden while `starting`; the derivation below turns
  // these flags plus the live auth status into the actually-active agent.
  let agents: Readonly<Record<string, AgentSettingsSnapshot>> = {};
  let chatId: ChatId | undefined;
  // A fresh pane is an empty conversation; flipped on the first transcript
  // item (the user's own prompt, or any assistant/tool event).
  let conversationEmpty = false;

  let unsubscribeEvents: (() => void) | undefined;
  let startingPollHandle: ReturnType<typeof setInterval> | undefined;
  let readyPollHandle: ReturnType<typeof setInterval> | undefined;

  /**
   * Projects the authoritative `sessionStatus` onto the composer's Send/Stop
   * state, the transcript's trailing "Thinking" indicator, and the single
   * banner row. All read the same derived facts so they can never disagree.
   */
  function refreshSessionPresentation(): void {
    // "Active agent" is the one derived fact the badge, the composer and the
    // banner all read: the configured provider when it is eligible, else the
    // first eligible provider, else none. Eligibility is the provider's own
    // criterion (an interactive sign-in or a stored token, for Copilot), so
    // this tracks both auth changes and token presence for free.
    const activeAgentId = resolveEffectiveActiveAgentId(AGENT_DEFINITIONS, agents, (id) => ({
      isAuthenticated: sessionStatus.authenticated,
      hasToken: agents[id]?.hasToken === true,
    }));
    const agentActive = activeAgentId !== undefined;
    transcriptStore.setTurnInFlight(isTurnInFlight(sessionStatus.state));
    const buttonState = computeComposerButtonState({
      serviceState,
      // The gate must not re-block a provider that needs no authentication;
      // when `agentActive` is false the composer returns `agent-inactive`
      // before consulting it, so this value is only ever used when true.
      session: { ...sessionStatus, authenticated: agentActive },
      agentActive,
    });
    composer.setButtonState(buttonState);
    // Every composer-generated message goes to the banner's single standing
    // floor - never the composer's own DOM - so the pane can never show two
    // rows at once and a later error/prompt suppresses the message instead of
    // stacking beneath it. The connecting state is the shared loading row;
    // the "no usable agent" prompt and a send-blocked reason are plain rows.
    // The `agent-inactive`/`stop` states are ordered so a turn already running
    // can always be stopped without the prompt displacing the Stop control.
    if (buttonState.kind === 'connecting') {
      statusBanner.setStanding(connectingContent, 'loading');
    } else if (!agentActive) {
      statusBanner.setStanding(agentPromptContent);
    } else if (buttonState.kind === 'send-disabled') {
      statusBanner.setStanding(contentForBlockReason(buttonState.reason));
    } else {
      statusBanner.setStanding(null);
    }
  }

  /**
   * Keeps the composer's empty/non-empty presentation in sync with the
   * transcript: an empty conversation gets the full-height prompt, and the
   * first transcript item sends it to the bottom at its ordinary height.
   */
  function refreshEmptyState(): void {
    const empty = transcriptStore.items().length === 0;
    if (empty === conversationEmpty) return;
    conversationEmpty = empty;
    element.classList.toggle('chat-pane--empty', empty);
    composer.setConversationEmpty(empty);
  }

  function subscribeToEvents(): void {
    if (unsubscribeEvents !== undefined) return;
    unsubscribeEvents = window.daisy.agentChat.onEvent((event) => {
      // Main already filters the pushed stream to the conversation it
      // currently owns (see `agent-chat-ipc.ts`'s module doc); this check is
      // a defence-in-depth backstop, not a load-bearing assumption.
      if (chatId !== undefined && event.chatId !== chatId) return;

      transcriptStore.applyEvent(event);
      refreshEmptyState();
      const applied = applyAgentEvent(sessionStatus, event);
      if (applied.ok) {
        sessionStatus = applied.value;
      } else {
        // Mirrors `agentChatController.ts`'s own handling of this case: an
        // illegal transition is an adapter/reducer disagreement bug, logged
        // rather than surfaced to the user, who cannot act on it.
        console.error('[daisy]', applied.error.message);
      }
      refreshSessionPresentation();
    });
  }

  async function ensureConversationOpen(id: ChatId): Promise<void> {
    const result = await window.daisy.agentChat.openConversation({ chatId: id });
    if (!result.ok) statusBanner.showError(result.error.message);
  }

  /**
   * Applies one `AgentChatStatus` to the pane - whether it arrived from a poll
   * or from the `agent-chat:status-changed` push. Idempotent and safe to run
   * while another read is in flight.
   *
   * Two things are reconciled here beyond the reported auth/state:
   *
   *  - The pane mints (or adopts) its one `ChatId` the first time the service
   *    is ready, then opens that conversation if main has none.
   *  - When main's `activeChatId` no longer matches ours, a runtime recycle has
   *    disposed the controller that owned our conversation and the fresh one
   *    starts with none. Re-opening here is what keeps the next send from
   *    failing with "not the currently open conversation" - and the turn state
   *    resets with it, because the recycled runtime genuinely has no turn in
   *    flight.
   */
  async function applyStatus(status: AgentChatStatus): Promise<void> {
    serviceState = status.serviceState;
    if (status.serviceState !== 'ready') {
      refreshSessionPresentation();
      return;
    }

    sessionStatus = { ...sessionStatus, authenticated: status.auth.isAuthenticated };

    if (chatId === undefined) {
      const id = status.activeChatId ?? newChatId(() => crypto.randomUUID());
      chatId = id;
      if (status.activeChatId === null) {
        await ensureConversationOpen(id);
      }
      sessionStatus = { ...sessionStatus, state: status.sessionState };
      subscribeToEvents();

      if (startingPollHandle !== undefined) {
        clearInterval(startingPollHandle);
        startingPollHandle = undefined;
      }
      readyPollHandle ??= setInterval(() => void refreshStatus(), READY_POLL_INTERVAL_MS);
    } else if (status.activeChatId !== chatId) {
      sessionStatus = { ...sessionStatus, state: 'idle' };
      await ensureConversationOpen(chatId);
    }

    refreshSessionPresentation();
  }

  async function refreshStatus(): Promise<void> {
    await applyStatus(await window.daisy.agentChat.getStatus());
  }

  async function onSend(prompt: string): Promise<ComposerSendOutcome> {
    if (chatId === undefined) {
      statusBanner.showError('Not connected to Copilot yet.');
      return { ok: false };
    }
    const result = await window.daisy.agentChat.sendMessage({ chatId, prompt });
    if (!result.ok) {
      // The pane's one banner carries the failure; the composer keeps the
      // typed prompt (see `trySubmit`) and stays silent, so the two never say
      // the same thing twice.
      statusBanner.showError(result.error.message);
      return { ok: false };
    }
    transcriptStore.applyUserPrompt(result.turnId, prompt);
    refreshEmptyState();
    return { ok: true };
  }

  function onStop(): void {
    if (chatId === undefined) return;
    void window.daisy.agentChat.abort({ chatId }).then((result) => {
      if (!result.ok) statusBanner.showError(result.error.message);
    });
  }

  /**
   * The toolbar's "New session": discards both the visible transcript and the
   * model's conversation context. A fresh `ChatId` is minted and opened; the
   * service's one-active-conversation rule tears the previous conversation
   * down as part of that open - cancelling any in-flight turn and closing the
   * old SDK session - so the new conversation genuinely starts with no prior
   * context, rather than the old one's history lingering behind a re-used id.
   *
   * The pane clears immediately, before the open resolves, so the previous
   * conversation is never left on screen beside the new (empty) one; if the
   * open fails, `ensureConversationOpen` puts the failure on the pane's banner
   * and the next status poll re-opens this same new id, which is why `chatId`
   * is adopted up front rather than only on success.
   */
  function startNewSession(): void {
    // No conversation is open yet (the service is still starting), so there
    // is no transcript or context for this to clean up.
    if (chatId === undefined) return;
    const id = newChatId(() => crypto.randomUUID());
    chatId = id;
    transcriptStore.clear();
    sessionStatus = { ...sessionStatus, state: 'idle' };
    refreshEmptyState();
    // Repaint at once rather than waiting up to a whole timer tick for the
    // cleared store's dirty flag to be noticed - the user just asked for a
    // clean slate and should see one immediately.
    transcriptView.repaint(transcriptStore);
    refreshSessionPresentation();
    void ensureConversationOpen(id);
  }

  const statusBanner: StatusBanner = createStatusBanner({
    surfaceClassName: CHAT_STATUS_BANNER_SURFACE_CLASS,
  });
  const composer = createComposer({ onSend, onStop });

  const transcript = el('div', {
    attrs: { class: 'chat-transcript' },
    children: [transcriptView.element],
  });

  const element = el('section', {
    attrs: { class: 'pane chat-pane', 'aria-label': 'Chat' },
    children: [
      createChatToolbar({
        onOpenSettings: () => options.onOpenSettings(),
        onNewSession: startNewSession,
      }),
      transcript,
      composer.element,
      statusBanner.element,
    ],
  });

  // A new pane starts on an empty conversation: full-height prompt.
  refreshEmptyState();

  const repaintTimer = setInterval(() => {
    if (transcriptStore.takeDirty()) {
      transcriptView.repaint(transcriptStore);
    }
  }, TRANSCRIPT_REPAINT_INTERVAL_MS);

  // A status change is not an `AgentEvent`, so it arrives on its own push
  // channel. This is what makes a runtime recycle - a proxy/active-provider
  // change, sign-in/out, a token set/clear - visible to the composer gate and
  // the open-conversation bookkeeping immediately, instead of up to a poll
  // interval later. The polls below remain the fallback that survives a missed
  // push.
  const unsubscribeStatus = window.daisy.agentChat.onStatusChanged((status) => {
    void applyStatus(status);
  });
  startingPollHandle = setInterval(() => void refreshStatus(), STARTING_POLL_INTERVAL_MS);
  void refreshStatus();

  return {
    element,
    setAgents(next: Readonly<Record<string, AgentSettingsSnapshot>>): void {
      agents = next;
      refreshSessionPresentation();
    },
    dispose(): void {
      unsubscribeEvents?.();
      unsubscribeStatus();
      clearInterval(repaintTimer);
      if (startingPollHandle !== undefined) clearInterval(startingPollHandle);
      if (readyPollHandle !== undefined) clearInterval(readyPollHandle);
      statusBanner.dispose();
      composer.dispose();
    },
  };
}
