import { el } from '../lib/dom';
import { createChatToolbar } from './chatToolbar';
import type { SettingsTab } from './settingsPanel';
import { createComposer, type ComposerSendOutcome } from '../chat/composer';
import { createAgentBanner } from '../chat/agentBanner';
import { computeComposerButtonState, isTurnInFlight } from '../chat/composerViewModel';
import { createTranscriptStore, type TranscriptStore } from '../chat/transcriptStore';
import { createTranscriptView, type TranscriptView } from '../chat/transcriptView';
import {
  applyAgentEvent,
  DEFAULT_AGENT_DEFINITION,
  isAgentActive,
  newChatId,
  type AgentDefinition,
  type AgentServiceLifecycleState,
  type ChatId,
  type SessionStatus,
} from '../../../shared';

export interface ChatPane {
  readonly element: HTMLElement;
  /**
   * Updates which provider is selected (from the settings snapshot), so the
   * pane can decide whether a *usable* agent exists and show/hide its
   * "activate an agent" banner accordingly.
   */
  setActiveAgent(definition: AgentDefinition): void;
  /** Unsubscribes from the agent-chat event stream and stops all polling/repaint timers. */
  dispose(): void;
}

/** How often the transcript checks for and applies pending changes (`transcriptStore.takeDirty`). */
const TRANSCRIPT_REPAINT_INTERVAL_MS = 100;

/** How often to re-check `getStatus()` while `serviceState` is still `"starting"` - there is no push event for it becoming `"ready"` (see `agent-chat-ipc.ts`). */
const STARTING_POLL_INTERVAL_MS = 500;

/**
 * How often to re-check `getStatus()` once ready, purely to catch an
 * authentication change: there is no renderer-facing push event for it
 * either (`agentChatController.ts` only wires an auth-changed listener
 * internally, main-process side). A focus-triggered poll would catch the
 * common case of the user signing in via another window, but there is no
 * settings-style focus hook wired here yet, so this periodic poll is the
 * only mechanism for now - it also covers the case where the chat window
 * stays focused throughout.
 */
const READY_POLL_INTERVAL_MS = 15_000;

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

  // `browserReady` is never learned by this pane (`AgentChatStatus` does not
  // report it, and `canSendMessage` - see `composerViewModel.ts` - never
  // reads it either); this placeholder is the only field on `SessionStatus`
  // this pane cannot populate from a real source. `sessionState.ts`'s own
  // doc comment is explicit that `canRunAemTool`, not `canSendMessage`, is
  // the only consumer of this field, and that function is not used here.
  let sessionStatus: SessionStatus = { state: 'idle', authenticated: false, browserReady: false };
  let serviceState: AgentServiceLifecycleState = 'starting';
  // Until the shell hands over the real snapshot, the default provider is
  // assumed (GitHub Copilot, which needs a sign-in). `setActiveAgent` replaces
  // it on every settings reload; the banner stays hidden while `starting`.
  let activeAgent: AgentDefinition = DEFAULT_AGENT_DEFINITION;
  let chatId: ChatId | undefined;
  // A fresh pane is an empty conversation; flipped on the first transcript
  // item (the user's own prompt, or any assistant/tool event).
  let conversationEmpty = false;

  let unsubscribeEvents: (() => void) | undefined;
  let startingPollHandle: ReturnType<typeof setInterval> | undefined;
  let readyPollHandle: ReturnType<typeof setInterval> | undefined;

  /**
   * Projects the authoritative `sessionStatus` onto the two UI surfaces that
   * depend on "is a turn in flight": the composer's Stop/Send button, and the
   * transcript's trailing "Thinking" indicator. Both read the same
   * `isTurnInFlight` predicate so they can never disagree.
   */
  function refreshSessionPresentation(): void {
    // "Active agent" is the UI's word for a *usable* one: a provider that
    // needs no auth, or one that needs it and is signed in. The banner takes
    // over the explanation, so the composer is told `agentActive` and is not
    // asked to word the block itself.
    const agentActive = isAgentActive(activeAgent, {
      isAuthenticated: sessionStatus.authenticated,
    });
    transcriptStore.setTurnInFlight(isTurnInFlight(sessionStatus.state));
    agentBanner.setVisible(serviceState === 'ready' && !agentActive);
    composer.setButtonState(
      computeComposerButtonState({
        serviceState,
        // The gate must not re-block a provider that needs no authentication;
        // when `agentActive` is false the composer returns `agent-inactive`
        // before consulting it, so this value is only ever used when true.
        session: { ...sessionStatus, authenticated: agentActive },
        agentActive,
      }),
    );
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
    if (!result.ok) {
      console.error('[daisy] failed to open chat conversation:', result.error);
    }
  }

  /**
   * Re-checks `getStatus()`. On the first call where `serviceState` reads
   * `"ready"`, this mints (or adopts) the pane's one `ChatId`, opens the
   * conversation if none is already active, seeds `sessionStatus` from the
   * reported state, and starts the live event subscription - mirroring
   * `agentChatController.ts`'s own "seed once, then track via events" split.
   * Every later call only refreshes `serviceState`/`authenticated`, never
   * `sessionStatus.state`: that field is owned by the live event stream from
   * this point on, and a poll response can easily be stale relative to the
   * very latest event.
   */
  async function refreshStatus(): Promise<void> {
    const status = await window.daisy.agentChat.getStatus();
    serviceState = status.serviceState;

    if (status.serviceState === 'ready') {
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
        readyPollHandle = setInterval(() => void refreshStatus(), READY_POLL_INTERVAL_MS);
      }
    }

    refreshSessionPresentation();
  }

  async function onSend(prompt: string): Promise<ComposerSendOutcome> {
    if (chatId === undefined) {
      return { ok: false, message: 'Not connected to Copilot yet.' };
    }
    const result = await window.daisy.agentChat.sendMessage({ chatId, prompt });
    if (!result.ok) {
      return { ok: false, message: result.error.message };
    }
    transcriptStore.applyUserPrompt(result.turnId, prompt);
    refreshEmptyState();
    return { ok: true };
  }

  function onStop(): void {
    if (chatId === undefined) return;
    void window.daisy.agentChat.abort({ chatId }).then((result) => {
      if (!result.ok) console.error('[daisy] failed to abort turn:', result.error);
    });
  }

  const composer = createComposer({ onSend, onStop });
  const agentBanner = createAgentBanner({
    onOpenSettings: () => options.onOpenSettings('agents'),
  });

  const transcript = el('div', {
    attrs: { class: 'chat-transcript' },
    children: [transcriptView.element],
  });

  const element = el('section', {
    attrs: { class: 'pane chat-pane', 'aria-label': 'Chat' },
    children: [
      createChatToolbar({ onOpenSettings: () => options.onOpenSettings() }),
      transcript,
      composer.element,
      agentBanner.element,
    ],
  });

  // A new pane starts on an empty conversation: full-height prompt.
  refreshEmptyState();

  const repaintTimer = setInterval(() => {
    if (transcriptStore.takeDirty()) {
      transcriptView.repaint(transcriptStore);
    }
  }, TRANSCRIPT_REPAINT_INTERVAL_MS);

  startingPollHandle = setInterval(() => void refreshStatus(), STARTING_POLL_INTERVAL_MS);
  void refreshStatus();

  return {
    element,
    setActiveAgent(definition: AgentDefinition): void {
      activeAgent = definition;
      refreshSessionPresentation();
    },
    dispose(): void {
      unsubscribeEvents?.();
      clearInterval(repaintTimer);
      if (startingPollHandle !== undefined) clearInterval(startingPollHandle);
      if (readyPollHandle !== undefined) clearInterval(readyPollHandle);
      agentBanner.dispose();
      composer.dispose();
    },
  };
}
