import { el } from '../lib/dom';
import { createChatToolbar } from './chatToolbar';
import { createComposer, type ComposerSendOutcome } from '../chat/composer';
import { computeComposerButtonState } from '../chat/composerViewModel';
import { createTranscriptStore, type TranscriptStore } from '../chat/transcriptStore';
import { createTranscriptView, type TranscriptView } from '../chat/transcriptView';
import {
  applyAgentEvent,
  newChatId,
  type AgentServiceLifecycleState,
  type ChatId,
  type SessionStatus,
} from '../../../shared';

export interface ChatPane {
  readonly element: HTMLElement;
  /**
   * Appends content into the pane's one internally-scrolling region. Used to
   * host `main.ts`'s hello-button/app-info elements (see `main.ts`) so they
   * cannot grow the document past the viewport - only this region scrolls,
   * the document itself never does (see `styles/shell.css`). Appended as a
   * sibling of the transcript's own message list, which is fully replaced on
   * every repaint (see `transcriptView.ts`) - so this content is never
   * touched by it.
   */
  appendFooterContent(...nodes: readonly HTMLElement[]): void;
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
   * Invoked when the toolbar's Settings button is clicked. The shell hands
   * this to the opener of its in-shell Settings panel (see `mainShell.ts`).
   */
  readonly onOpenSettings: () => void;
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
  let chatId: ChatId | undefined;

  let unsubscribeEvents: (() => void) | undefined;
  let startingPollHandle: ReturnType<typeof setInterval> | undefined;
  let readyPollHandle: ReturnType<typeof setInterval> | undefined;

  function repaintComposerButton(): void {
    composer.setButtonState(computeComposerButtonState({ serviceState, session: sessionStatus }));
  }

  function subscribeToEvents(): void {
    unsubscribeEvents = window.daisy.agentChat.onEvent((event) => {
      // Main already filters the pushed stream to the conversation it
      // currently owns (see `agent-chat-ipc.ts`'s module doc); this check is
      // a defence-in-depth backstop, not a load-bearing assumption.
      if (chatId !== undefined && event.chatId !== chatId) return;

      transcriptStore.applyEvent(event);
      const applied = applyAgentEvent(sessionStatus, event);
      if (applied.ok) {
        sessionStatus = applied.value;
      } else {
        // Mirrors `agentChatController.ts`'s own handling of this case: an
        // illegal transition is an adapter/reducer disagreement bug, logged
        // rather than surfaced to the user, who cannot act on it.
        console.error('[daisy]', applied.error.message);
      }
      repaintComposerButton();
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

    repaintComposerButton();
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
    return { ok: true };
  }

  function onStop(): void {
    if (chatId === undefined) return;
    void window.daisy.agentChat.abort({ chatId }).then((result) => {
      if (!result.ok) console.error('[daisy] failed to abort turn:', result.error);
    });
  }

  const composer = createComposer({ onSend, onStop });

  const transcript = el('div', {
    attrs: { class: 'chat-transcript' },
    children: [transcriptView.element],
  });

  const element = el('section', {
    attrs: { class: 'pane chat-pane', 'aria-label': 'Chat' },
    children: [
      createChatToolbar({ onOpenSettings: options.onOpenSettings }),
      transcript,
      composer.element,
    ],
  });

  const repaintTimer = setInterval(() => {
    if (transcriptStore.takeDirty()) {
      transcriptView.repaint(transcriptStore);
    }
  }, TRANSCRIPT_REPAINT_INTERVAL_MS);

  startingPollHandle = setInterval(() => void refreshStatus(), STARTING_POLL_INTERVAL_MS);
  void refreshStatus();

  return {
    element,
    appendFooterContent(...nodes: readonly HTMLElement[]): void {
      transcript.append(...nodes);
    },
    dispose(): void {
      unsubscribeEvents?.();
      clearInterval(repaintTimer);
      if (startingPollHandle !== undefined) clearInterval(startingPollHandle);
      if (readyPollHandle !== undefined) clearInterval(readyPollHandle);
    },
  };
}
