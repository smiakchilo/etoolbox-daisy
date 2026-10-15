import { el } from '../lib/dom';
import { AGENT_DEFINITIONS } from '../agents/agentCatalog';
import { buildBannerCopy, createBannerActionButton } from '../lib/alertBanner';
import { createChatToolbar } from './chatToolbar';
import type { SettingsTab } from './settingsPanel';
import { createComposer, type ComposerSendOutcome } from '../chat/composer';
import { replayJournalIntoTranscript } from '../chat/journalReplay';
import { createStatusBanner, type StatusBanner } from '../settings/statusBanner';
import {
  buildNoAnswer,
  computeComposerButtonState,
  describeCanSendBlockReason,
  isTurnInFlight,
} from '../chat/composerViewModel';
import { createTranscriptStore, type TranscriptStore } from '../chat/transcriptStore';
import { createTranscriptView, type TranscriptView } from '../chat/transcriptView';
import { isDeterministicTablePrompt } from '../chat/transcriptViewModel';
import { EMPTY_LINK_CONTEXT, type LinkContext } from '../chat/linkTargets';
import { createTranscriptFollower } from '../chat/transcriptFollower';
import {
  suggestTableExportFileName,
  tableToClipboardHtml,
  tableToCsv,
  tableToTsv,
  type TableExportData,
} from '../chat/tableExport';
import {
  applyAgentEvent,
  type AgentChatError,
  type AgentChatSkill,
  type AgentChatStatus,
  type AgentId,
  type AgentServiceLifecycleState,
  type AgentSettingsSnapshot,
  type CanSendBlockReason,
  type ChatId,
  type ChatJournalRecord,
  type ModelSelectionState,
  newChatId,
  resolveConfiguredAgentId,
  resolveEffectiveActiveAgentId,
  type SdkSessionId,
  type SessionStatus,
  type UserInputAnswer,
  type UserInputRequestId,
} from '../../../shared';
import { createAskUserPreviewTrigger } from '../dev/askUserPreviewTrigger';
import { buildDevHelpMessage, matchDevHelp } from '../dev/devCommands';
import { parseOpenChatById, type OpenChatByIdCommand } from '../dev/openChatById';

export interface ChatPane {
  readonly element: HTMLElement;
  /**
   * Updates the persisted per-provider flags (from the settings snapshot). The
   * pane derives which agent is *actually* active - the configured provider when
   * it is eligible, else none - on every auth change, so the
   * banner and composer always agree with the Settings badge and with each
   * other.
   */
  setAgents(agents: Readonly<Record<string, AgentSettingsSnapshot>>): void;
  /**
   * Updates which message links are openable: the configured host origins and
   * the origin of the AEM page the browser pane is currently showing. Called on
   * every settings/navigation change; a real change forces one transcript
   * repaint so a link's clickability tracks the pane without waiting for the
   * message text to change.
   */
  setLinkContext(context: LinkContext): void;
  /**
   * Opens a stored conversation chosen in History: paints its journal (so it is
   * readable even if the SDK session cannot be resumed - offline viewing), then
   * attempts a genuine resume of the session its header recorded. Unlike the
   * startup restore, a failed resume is *not* silently replaced with a fresh
   * session: the user asked for this specific conversation, so the failure is
   * reported and the stored transcript is left on screen. The shell switches
   * the browser to the chat's host; this method only owns the chat pane.
   */
  openConversationFromHistory(chatId: ChatId): Promise<HistoryResumeOutcome>;
  /**
   * Forgets a conversation deleted from History. If it is the pane's current
   * one, the pane starts a fresh conversation, so its own recovery cannot
   * re-open a chat whose storage is gone.
   */
  handleConversationDeleted(chatId: ChatId): void;
  /** Unsubscribes from the agent-chat event stream and stops all polling/repaint timers. */
  dispose(): void;
}

/** How often the transcript checks for and applies pending changes (`transcriptStore.takeDirty`). */
const TRANSCRIPT_REPAINT_INTERVAL_MS = 100;

/** The sentinel shown in the footer summary for an unset model or effort - the same text the Settings picker uses. */
const AUTO_LABEL = '(Auto)';

/** Copilot's own "auto" model id (see `modelsViewModel.ts`'s `PROVIDER_AUTO_MODEL_ID`); stored as a literal so the summary reads it as `(Auto)` too. */
const AUTO_MODEL_ID = 'auto';

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
 * the browser pane's `surface-status-banner` (the panel-status row) and its
 * `browser-toolbar-message` navigation row, so the rows never collide in a
 * Playwright strict-mode locator, and the shared
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
 * A conversation to resume when the pane first becomes ready, plus the journal
 * records to repaint it from. Resolved by the shell, which owns both the
 * persisted pointer and the server-match gate; the pane only opens and replays.
 */
export interface StartupConversation {
  readonly chatId: ChatId;
  readonly sdkSessionId: SdkSessionId;
  readonly records: readonly ChatJournalRecord[];
}

/**
 * The pane's own outcome for opening a conversation, a refinement of the raw
 * `AgentChatOpenResult` that adds `'superseded'`: a newer `openConversation`
 * replaced this one before it resolved, so its result no longer describes the
 * pane's conversation. Callers must treat `'superseded'` as a no-op - never as
 * a failure - so a stale open cannot raise an error banner, retry, or run the
 * resume-failure fallback over a conversation the pane has already moved to.
 */
type ConversationOpen =
  | { readonly outcome: 'opened' }
  | { readonly outcome: 'superseded' }
  | { readonly outcome: 'failed'; readonly error: AgentChatError };

/**
 * The pane's outcome for opening a conversation picked in History. Unlike the
 * startup restore, a failure is reported (not silently retried as a fresh
 * session): the stored transcript stays on screen for reading either way.
 */
export type HistoryResumeOutcome =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

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
  /**
   * Opens the in-shell History panel. The shell owns the panel (it is created
   * alongside Settings and mounted in the browser pane), so the chat pane only
   * reports the toolbar click. Optional so a unit test need not wire a panel.
   */
  readonly onOpenHistory?: () => void;
  /**
   * Opens an AEM-pane message link. The shell routes this to the browser pane
   * so that pane owns the navigation *and its failure* - a failed link load
   * must show the browser pane's error row (with Reload) and recover the page
   * or reveal the hosts picker, never land in the chat pane's banner. The
   * fallback (no shell wiring, e.g. a unit test) keeps the old direct call.
   */
  readonly onNavigateInBrowser?: (url: string) => void;
  /**
   * Resolves the conversation to restore on startup, or `undefined` to start a
   * fresh one. Called at most once, as early as the pane is constructed: the
   * journal it returns is painted before the runtime is ready, and the session
   * it names is resumed later, when the service reports ready.
   */
  readonly resolveStartupConversation?: () => Promise<StartupConversation | undefined>;
  /**
   * Records the active conversation and its live SDK session id, so it can be
   * genuinely resumed on the next launch. Called after a successful resume and
   * after every successful send.
   */
  readonly onConversationUsed?: (chatId: ChatId, sdkSessionId: SdkSessionId) => void;
  /**
   * Forgets the remembered conversation when it could not be resumed, so a
   * session that is gone is not retried on every subsequent launch.
   */
  readonly onConversationUnavailable?: () => void;
}

/** Order-sensitive equality: the host list only changes when the settings snapshot does. */
function linkContextsEqual(left: LinkContext, right: LinkContext): boolean {
  return (
    left.activeOrigin === right.activeOrigin &&
    left.hostOrigins.length === right.hostOrigins.length &&
    left.hostOrigins.every((origin, index) => origin === right.hostOrigins[index])
  );
}

export function createChatPane(options: ChatPaneOptions): ChatPane {
  const transcriptStore: TranscriptStore = createTranscriptStore();
  // The live link context, replaced by `setLinkContext`. A fresh pane starts
  // with nothing openable, which is also correct before the settings snapshot
  // and the browser pane's first navigation state arrive.
  let linkContext: LinkContext = EMPTY_LINK_CONTEXT;
  // The bundled skill catalogue for the composer's `/` autocomplete, and where
  // its one asynchronous read is: `idle` until the service is ready, `loading`
  // while main reads the SKILL.md files, `loaded` once (success or failure).
  // A failed read leaves an empty catalogue - the autocomplete simply stays
  // silent, and a leading `/name` is still sent as ordinary text. Declared
  // before the transcript view because that view reads the catalogue on every
  // repaint (a prompt recorded before the read lands is re-rendered bold once
  // it does).
  let skills: readonly AgentChatSkill[] = [];
  let skillsState: 'idle' | 'loading' | 'loaded' = 'idle';
  const transcriptView: TranscriptView = createTranscriptView(undefined, {
    getLinkContext: () => linkContext,
    getKnownSkillNames: () => skills.map((skill) => skill.name),
    onOpenLink: (url) => openLink(url),
    onOpenExternal: (url) => openExternal(url),
    onResume: () => resumeStoppedSession(),
    onCopyTable: (data) => copyTable(data),
    onExportTable: (data) => exportTable(data),
  });

  // The standing "no usable agent" prompt, built once and reused: it is the
  // banner row's lowest-priority presentation (see `refreshSessionPresentation`
  // below). The Settings control sits *inside* the sentence, exactly like the
  // prompt rows' inline actions (`buildBannerPrompt`), so the copy is a
  // `buildBannerCopy` span. Its click handler survives being swapped out and
  // back in, because the same button node is reused.
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

  // Shown when no agent exists at all (removed, disabled or failed to load).
  const unavailableContent: readonly Node[] = [
    buildBannerCopy(['No agent available. Browsing AEM still works']),
  ];

  // Shown in place of the connecting row once a saved conversation's journal is
  // already on screen but its SDK session has not resumed yet: the same loading
  // presentation, but naming the work the user is actually waiting on.
  const restoringContent: readonly Node[] = [buildBannerCopy(['Restoring conversation...'])];

  // Shown while the `/` autocomplete's skill catalogue is being read from disk
  // in main, which the pane begins only once the service is ready - so it never
  // delays or competes with the runtime's own cold start.
  const loadingSkillsContent: readonly Node[] = [buildBannerCopy(['Loading skills...'])];

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
  // The effectively active provider, recomputed on every status derivation and
  // read by the footer's agent/model/reasoning summary.
  let activeAgentId: AgentId | undefined;
  // The active provider's model catalogue and stored selection, read for the
  // footer summary's model display name (the snapshot only carries the raw
  // model id). `undefined` until read, or when the read failed/unavailable.
  let modelSelection: ModelSelectionState | undefined;
  // Bumped per read so a slow earlier response cannot overwrite a newer one.
  let modelSelectionRequest = 0;
  let chatId: ChatId | undefined;
  // Mints a distinct id per `!!` help message, so each `!!ask ?` / `!!open ?`
  // prints its own transcript item rather than rewriting the previous one. The
  // dev `!!` commands live entirely under `src/renderer/src/dev/`.
  let devHelpSequence = 0;
  // The open currently in flight for the pane's chat, if any. The pane adopts
  // a new id and enables the composer *before* `agentChat.openConversation`
  // resolves (deliberately - see `startNewSession`), so a send could otherwise
  // race ahead of main registering that conversation and be refused by the
  // service with `"<chatId>" is not the open conversation`. `onSend` awaits
  // this first. See defect fix 2026-10-09.
  //
  // It is also the pane's single-flight slot: starting a second open while one
  // is in flight replaces this value, which is how the first open recognises
  // that it has been superseded (its promise is no longer the one here) and
  // reports `'superseded'` rather than a failure. See `ConversationOpen`.
  let pendingOpen:
    { readonly chatId: ChatId; readonly promise: Promise<ConversationOpen> } | undefined;
  // Set once the toolbar exists (below). The pane derives "New session" from
  // whether it owns a conversation and no open is in flight (see
  // `updateNewSessionEnabled`), so the control is disabled both before any
  // conversation exists and while one is still opening - it can never look
  // actionable while a click would be a no-op. The condition that a second
  // conversation must not start over a first still resolving is `pendingOpen`
  // (see the controller's `openChain`). A no-op until assigned.
  let setNewSessionEnabled: (enabled: boolean) => void = () => undefined;
  // A fresh pane is an empty conversation; flipped on the first transcript
  // item (the user's own prompt, or any assistant/tool event).
  let conversationEmpty = false;
  // Set when the composer's Stop is pressed. The `cancelling` event that
  // follows is then recorded as "Session stopped"; without it, a `cancelling`
  // event is the application's own AEM-context abort ("Session interrupted by
  // navigation"). See the event subscription below.
  let stopRequested = false;
  // The most recent live SDK session id for `chatId`, learned from
  // `AgentChatStatus`. Persisted so a later launch resumes the *current*
  // session, not the one the journal recorded at chat creation (a runtime
  // recycle mints a new session for the same chat).
  let latestSdkSessionId: SdkSessionId | undefined;
  // Whether the active conversation has at least one message. Only then is it
  // worth restoring - an opened-but-unused chat is never remembered.
  let conversationHasMessage = false;
  // The startup conversation is resolved at most once, and both the early
  // journal preload and the ready-time resume await this same promise - so the
  // two can never race over which one claims the restore.
  let startupConversationPromise: Promise<StartupConversation | undefined> | undefined;
  // A saved conversation whose journal is already painted but whose SDK session
  // has not been resumed yet (the runtime is still cold-starting, or the open is
  // in flight). While set, the banner says "Restoring conversation..." (instead
  // of the generic connecting row) and Send stays disabled. It is cleared only
  // once the resume open settles - not when the pane adopts the id - so the row
  // and the disabled Send cover the actual resume work, not just the wait before
  // it begins.
  let pendingStartup: StartupConversation | undefined;
  // Whether the startup journal has been replayed into the transcript. Guards
  // against replaying it twice when the preload wins the race to paint.
  let startupJournalPainted = false;
  // Set synchronously when the pane commits to resuming a startup conversation,
  // before the resume RPC awaits. A status poll landing in that window sees this
  // and skips, instead of resolving the startup conversation again and opening a
  // second conversation over the first.
  let startupResumeInFlight = false;
  // The outstanding interactive question, so a submitted answer can name it.
  let pendingInputRequestId: UserInputRequestId | undefined;
  // Dev-only previews (Tier 1). All of their logic lives in
  // `src/renderer/src/dev/`; this factory plus the three small references below
  // (`onDevCommand`, `onAnswer`, `resetInputMode`/`onStop`) are the pane's only
  // coupling to it, so retiring the previews is deleting that directory and
  // those references.
  const askUserPreview = createAskUserPreviewTrigger();

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
    // banner all read: the configured provider when it is eligible, else none.
    // Eligibility is the provider's own criterion (an interactive sign-in or a
    // stored token, for Copilot), so this tracks both auth changes and token
    // presence for free.
    activeAgentId = resolveEffectiveActiveAgentId(AGENT_DEFINITIONS, agents, (id) => ({
      // Only the running (configured) provider has a live auth answer; for any
      // other id a stored token is the only honest signal. Feeding the active
      // service's status to every id would mark an inactive provider as
      // authenticated purely because the active one is.
      isAuthenticated:
        id === resolveConfiguredAgentId(agents, AGENT_DEFINITIONS) && sessionStatus.authenticated,
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
      // A restored conversation whose session has not resumed yet is not ready
      // to send to, exactly as while the service is starting - see
      // `computeComposerButtonState`. Its banner names the resume (below).
      resuming: pendingStartup !== undefined,
    });
    composer.setButtonState(buttonState);
    // Every composer-generated message goes to the banner's single standing
    // floor - never the composer's own DOM - so the pane can never show two
    // rows at once and a later error/prompt suppresses the message instead of
    // stacking beneath it. The connecting state is the shared loading row;
    // the "no usable agent" prompt and a send-blocked reason are plain rows.
    // The `agent-inactive`/`stop` states are ordered so a turn already running
    // can always be stopped without the prompt displacing the Stop control.
    if (buttonState.kind === 'unavailable') {
      statusBanner.setStanding(unavailableContent);
    } else if (pendingStartup !== undefined) {
      // A restored transcript is on screen but the session that owns it has not
      // resumed yet; name that, rather than the generic connecting row.
      statusBanner.setStanding(restoringContent, 'loading');
    } else if (buttonState.kind === 'connecting') {
      statusBanner.setStanding(connectingContent, 'loading');
    } else if (!agentActive) {
      statusBanner.setStanding(agentPromptContent);
    } else if (skillsState === 'loading') {
      statusBanner.setStanding(loadingSkillsContent, 'loading');
    } else if (buttonState.kind === 'send-disabled') {
      statusBanner.setStanding(contentForBlockReason(buttonState.reason));
    } else {
      statusBanner.setStanding(null);
    }
    // The chat id may have just been adopted (a status poll) or replaced (a
    // fresh session); keep the footer's id and visibility current.
    updateSessionFooter();
  }

  /**
   * Keeps the composer's empty/non-empty presentation in sync with the
   * transcript: an empty conversation gets the full-height prompt, and the
   * first transcript item sends it to the bottom at its ordinary height. The
   * session-id footer is refreshed alongside, because its visibility depends on
   * the same emptiness (and on the chat id).
   */
  function refreshEmptyState(): void {
    const empty = transcriptStore.items().length === 0;
    if (empty !== conversationEmpty) {
      conversationEmpty = empty;
      element.classList.toggle('chat-pane--empty', empty);
      composer.setConversationEmpty(empty);
    }
    updateSessionFooter();
  }

  /**
   * Reads the bundled skill catalogue once, off any critical path: the pane
   * asks main only after the service reports ready, so the read never competes
   * with the runtime's own cold start. The "Loading skills..." banner is shown
   * for its duration, and the catalogue is handed to the composer for its `/`
   * autocomplete. A failure (or an empty catalogue) is silent here - the
   * autocomplete simply has nothing to offer, and any leading `/name` is still
   * sent as ordinary text.
   */
  async function loadSkills(): Promise<void> {
    if (skillsState !== 'idle') return;
    skillsState = 'loading';
    refreshSessionPresentation();
    const result = await window.daisy.agentChat.listSkills();
    skillsState = 'loaded';
    if (result.ok) {
      skills = result.skills;
      composer.setSkills(skills);
    }
    refreshSessionPresentation();
    // A prompt recorded before the catalogue landed (a restored conversation,
    // or a message sent in the first moments after ready) is re-rendered now
    // that a leading `/name` can be recognised as a skill.
    repaintTranscript();
  }

  /**
   * Reads the model catalogue + stored selection for the footer's summary. The
   * brief settings snapshot only carries the raw model id; the human-readable
   * name lives in the catalogue (see `ModelCatalogEntry.name`). Called once the
   * service is ready and again whenever the agent settings change. A failed or
   * unavailable read is silent - the summary falls back to the raw id - and a
   * stale response is dropped so an earlier read cannot overwrite a newer one.
   */
  async function loadModelSelection(): Promise<void> {
    const request = ++modelSelectionRequest;
    let next: ModelSelectionState | undefined;
    try {
      const result = await window.daisy.settings.getModelSelection();
      next = result.ok ? result.state : undefined;
    } catch {
      next = undefined;
    }
    if (request !== modelSelectionRequest) return;
    modelSelection = next;
    updateSessionFooter();
  }

  /** The footer summary line: agent label / model / reasoning, in that order. */
  function buildAgentSummary(agentId: AgentId): string {
    const definition = AGENT_DEFINITIONS.find((candidate) => candidate.id === agentId);
    return [
      definition?.label ?? agentId,
      describeModel(agents[agentId]?.model),
      describeReasoningEffort(agents[agentId]?.reasoningEffort),
    ].join(' / ');
  }

  /**
   * The model's display name from the catalogue, falling back to its raw id
   * when the catalogue has not loaded (or omits it). Copilot's own `auto` model
   * and an unset model both read as "(Auto)" - the same value the Settings
   * picker shows.
   */
  function describeModel(modelId: string | undefined): string {
    if (modelId === undefined || modelId.toLowerCase() === AUTO_MODEL_ID) return AUTO_LABEL;
    return modelSelection?.models.find((model) => model.id === modelId)?.name ?? modelId;
  }

  /** The stored effort, capitalised for display ("high" -> "High"), or "(Auto)". */
  function describeReasoningEffort(effort: string | undefined): string {
    if (effort === undefined) return AUTO_LABEL;
    return effort.charAt(0).toUpperCase() + effort.slice(1);
  }

  function subscribeToEvents(): void {
    if (unsubscribeEvents !== undefined) return;
    unsubscribeEvents = window.daisy.agentChat.onEvent((event) => {
      // Main already filters the pushed stream to the conversation it
      // currently owns (see `agent-chat-ipc.ts`'s module doc); this check is
      // a defence-in-depth backstop, not a load-bearing assumption.
      if (chatId !== undefined && event.chatId !== chatId) return;

      transcriptStore.applyEvent(event);
      // An interactive question swaps the composer into its selection UI; the
      // matching answer is delivered by `onAnswer`. Any terminal turn state
      // clears it, so an aborted question cannot leave the composer stuck.
      if (event.type === 'user.input.requested') {
        pendingInputRequestId = event.requestId;
        transcriptStore.setAwaitingUserInput(true);
        composer.setInputRequest({
          ...(event.question !== undefined ? { question: event.question } : {}),
          ...(event.options !== undefined ? { options: [...event.options] } : {}),
          ...(event.actions !== undefined ? { actions: [...event.actions] } : {}),
          multiple: event.multiple,
          freeInput: event.freeInput,
        });
      } else if (
        event.type === 'session.state.changed' &&
        (event.state === 'idle' ||
          event.state === 'cancelling' ||
          event.state === 'closed' ||
          event.state === 'error')
      ) {
        clearPendingInput();
      }
      // An interruption notice is the pane's own; the store never infers one.
      // `cancelling` is only ever app-initiated (a Stop, or the controller's
      // `handleAemContextInvalidated`), and only this pane knows which. Guard
      // on the previous state so a repeated `cancelling` cannot double-record.
      if (
        event.type === 'session.state.changed' &&
        event.state === 'cancelling' &&
        sessionStatus.state !== 'cancelling'
      ) {
        transcriptStore.addInterruption(stopRequested ? 'stopped' : 'navigation');
        stopRequested = false;
      }
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
      // A turn-level `error` has no transcript item of its own, so the pane's
      // one dismissible banner is where the user learns what happened. The
      // adapter has already recovered the session to `idle`, so this row can be
      // closed without leaving the composer disabled.
      if (event.type === 'error') statusBanner.showError(event.error.message);
      refreshSessionPresentation();
    });
  }

  /**
   * Derives the toolbar's "New session" enabled state. The control can only do
   * something once the pane owns a conversation and no open is in flight: with
   * no `chatId` a click is silently discarded (`startNewSession` early-returns),
   * and during an open a second conversation must not start over one still
   * resolving (the single-flight rule, see `pendingOpen`). It therefore starts
   * disabled - there is no conversation yet - and is re-derived from the one
   * place that owns those two facts, so it never looks actionable while a click
   * would be a no-op.
   */
  function updateNewSessionEnabled(): void {
    setNewSessionEnabled(chatId !== undefined && pendingOpen === undefined);
  }

  async function openConversation(id: ChatId, resume?: SdkSessionId): Promise<ConversationOpen> {
    const raw = window.daisy.agentChat.openConversation(
      resume === undefined ? { chatId: id } : { chatId: id, resume: { sdkSessionId: resume } },
    );
    // The promise held in `pendingOpen` is the one `onSend` awaits. A later
    // `openConversation` overwrites `pendingOpen`; that overwrite is exactly
    // how this call learns it was superseded once it resolves.
    const promise: Promise<ConversationOpen> = raw.then((result) =>
      result.ok ? { outcome: 'opened' } : { outcome: 'failed', error: result.error },
    );
    pendingOpen = { chatId: id, promise };
    updateNewSessionEnabled();
    try {
      const outcome = await promise;
      // A newer open replaced this one before it settled: the pane has moved to
      // a different conversation, so this result is no longer its business.
      if (pendingOpen?.promise !== promise) return { outcome: 'superseded' };
      if (outcome.outcome === 'opened') {
        // Capture the freshly minted live session id for persistence. A plain
        // read, not a push: pushing a status change on open would make this pane
        // react to a conversation some other caller opened (the pane's re-open is
        // meant for its own runtime-recycle recovery).
        void window.daisy.agentChat.getStatus().then(
          (status) => {
            if (status.sdkSessionId === null) return;
            latestSdkSessionId = status.sdkSessionId;
            persistActiveConversation();
          },
          () => undefined,
        );
      }
      return outcome;
    } finally {
      // Only the open that is still current clears the slot and re-enables
      // "New session"; a superseded one leaves both to its successor.
      if (pendingOpen?.promise === promise) {
        pendingOpen = undefined;
        updateNewSessionEnabled();
      }
    }
  }

  /**
   * Records the active conversation so a later launch can genuinely resume it.
   * Written only once the conversation has at least one message (see
   * `conversationHasMessage`), and refreshed whenever a new live session id
   * arrives, so a runtime recycle does not leave a stale id on disk.
   */
  function persistActiveConversation(): void {
    if (!conversationHasMessage) return;
    if (chatId === undefined || latestSdkSessionId === undefined) return;
    options.onConversationUsed?.(chatId, latestSdkSessionId);
  }

  /**
   * Resolves the conversation to restore, memoised so it is read exactly once.
   * A shell failure or an `undefined` answer both mean "start fresh". The
   * promise is shared by {@link preloadStartupConversation} and the ready-time
   * resume, so neither can resolve it twice or race the other.
   */
  function ensureStartupConversation(): Promise<StartupConversation | undefined> {
    startupConversationPromise ??= (async () => {
      if (options.resolveStartupConversation === undefined) return undefined;
      try {
        return await options.resolveStartupConversation();
      } catch {
        return undefined;
      }
    })();
    return startupConversationPromise;
  }

  /**
   * Paints a saved conversation's journal into the transcript, at most once.
   * The journal is local and needs no SDK session, so this is what lets the
   * transcript appear while `copilot-runtime.exe` is still cold-starting.
   */
  function paintStartupJournal(startup: StartupConversation): void {
    if (startupJournalPainted) return;
    startupJournalPainted = true;
    // If the pane already owns a conversation, main adopted it before this
    // local journal read resolved - a renderer reload (the app surface's
    // right-click "Reload") leaves main owning the chat the pane last opened,
    // and the fast in-memory status read can beat this disk read. The adopted
    // id wins: a *different* conversation means this journal is stale and must
    // not be shown; the *same* one still has history worth painting, but no
    // resume is pending - main already owns it - so `pendingStartup` must stay
    // clear or the "Restoring conversation..." row would be stranded, since the
    // only code that clears it runs while the pane still owns no chat.
    if (chatId !== undefined && chatId !== startup.chatId) return;
    if (chatId === undefined) pendingStartup = startup;
    replayJournalIntoTranscript(startup.records, transcriptStore, isDeterministicTablePrompt);
    conversationHasMessage = true;
    refreshEmptyState();
    repaintTranscript();
  }

  /**
   * Reads the saved conversation's journal and paints it *before* the agent
   * runtime is ready - the read is local, and the session it belongs to is
   * resumed later, when the service reports ready. Runs at construction, in
   * parallel with the runtime's cold start, so the transcript no longer waits
   * on the SDK. A no-op when there is nothing to restore.
   */
  async function preloadStartupConversation(): Promise<void> {
    const startup = await ensureStartupConversation();
    if (startup === undefined) return;
    paintStartupJournal(startup);
    refreshSessionPresentation();
  }

  /** Starts a genuinely empty conversation under a fresh id. */
  async function startFreshConversation(): Promise<void> {
    const id = newChatId(() => crypto.randomUUID());
    adoptChatId(id);
    conversationHasMessage = false;
    stopRequested = false;
    resetInputMode();
    transcriptStore.clear();
    refreshEmptyState();
    const result = await openConversation(id);
    if (result.outcome === 'failed') statusBanner.showError(result.error.message);
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

    // The runtime is ready, so the composer may soon send: fetch the skill
    // catalogue for its `/` autocomplete now. Guarded to a single read.
    void loadSkills();
    // The footer's model display name needs the catalogue; read it now that the
    // runtime can answer, and again whenever the agent settings change.
    void loadModelSelection();

    sessionStatus = { ...sessionStatus, authenticated: status.auth.isAuthenticated };
    if (status.sdkSessionId !== null) latestSdkSessionId = status.sdkSessionId;
    // A live session id may arrive after the first send; refreshing the stored
    // pointer here keeps it current across a runtime recycle.
    persistActiveConversation();

    if (chatId === undefined) {
      if (status.activeChatId !== null) {
        // Main already owns a conversation (a recycled runtime that re-opened
        // one before this pane polled). Adopt it; its transcript arrives on the
        // ordinary event stream.
        if (pendingStartup !== undefined && pendingStartup.chatId !== status.activeChatId) {
          // The preload painted a *different* conversation's journal - drop it,
          // so its history is not shown under the adopted conversation's id.
          transcriptStore.clear();
          conversationHasMessage = false;
          refreshEmptyState();
          repaintTranscript();
        }
        pendingStartup = undefined;
        adoptChatId(status.activeChatId);
      } else if (startupResumeInFlight) {
        // A concurrent status poll (or push) is already resolving and resuming
        // the startup conversation. Do not re-enter: it would open a second
        // conversation over the first. The in-flight call finishes the setup.
        return;
      } else {
        startupResumeInFlight = true;
        const startup = await ensureStartupConversation();
        if (startup === undefined) {
          await startFreshConversation();
        } else {
          // The journal may already be on screen (the preload won the race to
          // paint it); `paintStartupJournal` is a no-op then. Either way the
          // session is resumed now, and only now does the pane own the chat.
          // `pendingStartup` deliberately stays set for the whole open: it is
          // what keeps the "Restoring conversation..." row up (and Send
          // disabled) while the session is actually being resumed, rather than
          // clearing the moment the work begins.
          paintStartupJournal(startup);
          adoptChatId(startup.chatId);
          latestSdkSessionId = startup.sdkSessionId;
          const opened = await openConversation(startup.chatId, startup.sdkSessionId);
          // The resume has settled (opened, failed or superseded): the restored
          // transcript is either backed by a live session now or is about to be
          // replaced, so the restoring row comes down and Send re-enables.
          pendingStartup = undefined;
          if (opened.outcome === 'opened') {
            persistActiveConversation();
          } else if (opened.outcome === 'failed') {
            // Silent fallback, as agreed: no banner, and - the important part -
            // no old transcript left on screen under a new session. Forget the
            // pointer so the next launch does not retry a session that is gone.
            options.onConversationUnavailable?.();
            await startFreshConversation();
          }
          // 'superseded': a newer conversation now owns the pane (e.g. a
          // concurrent recover), so this resume's outcome is moot.
        }
        startupResumeInFlight = false;
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
      const result = await openConversation(chatId);
      if (result.outcome === 'opened') {
        // The recovery re-opened the pane's conversation; any error row that
        // named the desync is now stale, so clear it rather than leave it
        // sitting under a recovered chat.
        statusBanner.clearError();
      } else if (result.outcome === 'failed') {
        statusBanner.showError(result.error.message);
      }
    }

    refreshSessionPresentation();
  }

  /** Polls the current status and applies it (the fallback for a missed push). */
  async function refreshStatus(): Promise<void> {
    await applyStatus(await window.daisy.agentChat.getStatus());
  }

  /** Leaves the interactive-question UI and forgets the outstanding request. */
  function clearPendingInput(): void {
    if (pendingInputRequestId === undefined) return;
    pendingInputRequestId = undefined;
    transcriptStore.setAwaitingUserInput(false);
    composer.setInputRequest(undefined);
  }

  /** Drops any interactive/preview input state, e.g. on a new conversation. */
  function resetInputMode(): void {
    pendingInputRequestId = undefined;
    transcriptStore.setAwaitingUserInput(false);
    askUserPreview.reset();
    composer.setInputRequest(undefined);
  }

  /**
   * Delivers the user's answer to main - or, for a dev-only preview, paints the
   * synthesized result locally so the transcript's question/answer rendering is
   * exercised without any round trip.
   */
  function onAnswer(answer: UserInputAnswer): void {
    const previewResult = askUserPreview.answer(answer);
    if (previewResult !== undefined) {
      transcriptStore.applyEvent(previewResult);
      repaintTranscript();
      return;
    }
    if (chatId === undefined || pendingInputRequestId === undefined) return;
    const requestId = pendingInputRequestId;
    pendingInputRequestId = undefined;
    transcriptStore.setAwaitingUserInput(false);
    void window.daisy.agentChat.respondToInput({ chatId, requestId, answer }).then((result) => {
      if (!result.ok) statusBanner.showError(result.error.message);
    });
  }

  /**
   * Consumes a dev-only cheat code when dev tools are enabled; returns whether
   * it did. A lone `?` (or `help`) argument prints a command's usage (`!!ask ?`,
   * `!!open ?`; `!!?` lists them all) through the shared registry in
   * `src/renderer/src/dev/devCommands.ts` - checked first, so `?` is never read
   * as a command's own argument. `!!ask ...` paints the local ask-user preview,
   * `!!open <chatId>` opens a stored conversation by id. All of their logic
   * lives in `src/renderer/src/dev/`; this factory plus `onAnswer`/
   * `resetInputMode`/`onStop`/`openStoredConversation` are the pane's only
   * coupling to it.
   */
  function onDevCommand(input: string): boolean {
    if (!window.daisy.devTools) return false;
    const help = matchDevHelp(input);
    if (help !== undefined) {
      printDevMessage(help);
      return true;
    }
    const started = askUserPreview.start(input);
    if (started !== undefined) {
      transcriptStore.applyEvent(started.toolCall);
      composer.setInputRequest(started.request);
      refreshEmptyState();
      repaintTranscript();
      return true;
    }
    const openCommand = parseOpenChatById(input);
    if (openCommand !== undefined) {
      void openStoredConversation(openCommand);
      return true;
    }
    return false;
  }

  /**
   * Dev-only: prints `text` into the transcript as an assistant message - the
   * `!!` commands' help output - through a synthetic
   * `assistant.message.completed`, exactly as the ask-user preview feeds its
   * own synthetic events. Each call is a distinct item (see `devHelpSequence`),
   * so repeated help does not rewrite the last one.
   */
  function printDevMessage(text: string): void {
    transcriptStore.applyEvent(buildDevHelpMessage(text, devHelpSequence));
    devHelpSequence += 1;
    refreshEmptyState();
    repaintTranscript();
    transcriptFollower.pin();
  }

  /**
   * Replaces the transcript with a stored conversation's journal before its SDK
   * session is touched: adopts the id, clears the store, replays the records,
   * re-derives emptiness, drops any pending input, and repaints/pins. Shared by
   * the dev `!!open` path and History resume, so both paint a stored chat
   * identically. Returns the SDK session id the journal's header recorded (or
   * `undefined` when there is no header), which the callers pass to
   * `openConversation` for a genuine resume.
   */
  function paintStoredConversation(
    id: ChatId,
    records: readonly ChatJournalRecord[],
  ): SdkSessionId | undefined {
    const header = records.find((record) => record.recordType === 'header');
    adoptChatId(id);
    transcriptStore.clear();
    replayJournalIntoTranscript(records, transcriptStore, isDeterministicTablePrompt);
    conversationHasMessage = records.some(
      (record) => record.recordType === 'user.prompt' || record.recordType === 'agent.event',
    );
    stopRequested = false;
    resetInputMode();
    refreshEmptyState();
    repaintTranscript();
    transcriptFollower.pin();
    return header?.sdkSessionId;
  }

  /**
   * Dev-only: opens a stored conversation by id (the `!!open <chatId>` cheat
   * code). Paints the chat's journal first, so a foreign or unfinished chat is
   * readable even when its SDK session cannot be resumed, then opens it through
   * the ordinary path. The header's session id is tried first; when that session
   * is gone or foreign the same chat is re-opened with a fresh session, which is
   * what lets the stored transcript stay on screen under a usable conversation.
   * Reachable only in an unpackaged build (see `onDevCommand`).
   */
  async function openStoredConversation(command: OpenChatByIdCommand): Promise<void> {
    if (command.kind === 'invalid') {
      statusBanner.showError(
        `Dev: "!!open <chatId>" needs a valid chat id (got "${command.raw}").`,
      );
      return;
    }
    const id = command.chatId;
    const journal = await window.daisy.agentChat.readJournal({ chatId: id });
    if (!journal.ok) {
      statusBanner.showError(`Dev: no readable journal for chat ${id}.`);
      return;
    }

    const sessionId = paintStoredConversation(id, journal.records);
    latestSdkSessionId = sessionId;
    let opened = await openConversation(id, sessionId);
    if (opened.outcome === 'failed' && sessionId !== undefined) {
      // The header's session id is stale or foreign: fall back to a fresh
      // session under the same chat id so the pane still owns a usable chat,
      // with the stored transcript left on screen.
      opened = await openConversation(id);
    }
    if (opened.outcome === 'failed') statusBanner.showError(opened.error.message);
    refreshSessionPresentation();
  }

  /**
   * Opens a stored conversation chosen in History (the non-dev sibling of
   * `openStoredConversation`). Paints the journal first - so the transcript is
   * readable even when the session cannot be resumed - then resumes the session
   * the header recorded. A failed resume is reported, never silently replaced
   * by a fresh session: the user picked this conversation deliberately.
   */
  async function openConversationFromHistory(id: ChatId): Promise<HistoryResumeOutcome> {
    const journal = await window.daisy.agentChat.readJournal({ chatId: id });
    if (!journal.ok) {
      statusBanner.showError(journal.error.message);
      return { ok: false, message: journal.error.message };
    }

    const sessionId = paintStoredConversation(id, journal.records);
    latestSdkSessionId = sessionId;
    const opened = await openConversation(id, sessionId);
    if (opened.outcome === 'failed') {
      statusBanner.showError(opened.error.message);
      return { ok: false, message: opened.error.message };
    }
    if (opened.outcome === 'opened') persistActiveConversation();
    refreshSessionPresentation();
    return { ok: true };
  }

  /**
   * Handles a conversation deleted from History. Only the pane's *current*
   * conversation matters: a fresh one is started so the pane's own
   * runtime-recycle recovery (which re-opens `chatId` when main reports it is
   * not open) cannot resurrect the deleted chat.
   */
  function handleConversationDeleted(deletedChatId: ChatId): void {
    if (chatId !== deletedChatId) return;
    pendingStartup = undefined;
    latestSdkSessionId = undefined;
    void startFreshConversation();
  }

  async function onSend(prompt: string): Promise<ComposerSendOutcome> {
    const target = chatId;
    if (target === undefined) {
      statusBanner.showError('Not connected to the agent');
      return { ok: false };
    }
    // Wait out an in-flight open for this chat before sending. Main registers
    // the conversation only once `openConversation` resolves, so sending first
    // is refused by the service with '"<id>" is not the open conversation' -
    // the new id is adopted (and the composer enabled) up front, deliberately,
    // so this is the one place the two must be reconciled.
    const open = pendingOpen;
    if (open !== undefined && open.chatId === target) {
      const opened = await open.promise;
      if (chatId !== target) return { ok: false }; // a newer session replaced it
      if (opened.outcome === 'failed') {
        statusBanner.showError(opened.error.message);
        return { ok: false };
      }
    }
    const result = await window.daisy.agentChat.sendMessage({ chatId: target, prompt });
    if (!result.ok) {
      // The pane's one banner carries the failure; the composer keeps the
      // typed prompt (see `trySubmit`) and stays silent, so the two never say
      // the same thing twice.
      statusBanner.showError(result.error.message);
      return { ok: false };
    }
    // A new prompt supersedes any error the previous turn left behind - it
    // described an attempt the user has moved on from. If this turn also fails,
    // its own error event takes the row straight back.
    statusBanner.clearError();
    transcriptStore.applyUserPrompt(result.turnId, prompt);
    // A search skill's answer is the `format_table` message, not the model's
    // prose - suppress this turn's assistant text so only the table shows.
    if (isDeterministicTablePrompt(prompt)) {
      transcriptStore.markTurnSuppressed(result.turnId);
    }
    refreshEmptyState();
    // Sending is deliberate: show the user's own message and the reply that
    // follows, even if they had scrolled up to read history first.
    transcriptFollower.pin();
    // The chat now has at least one message, so it is worth restoring next
    // launch - and this also refreshes the stored live session id.
    conversationHasMessage = true;
    stopRequested = false;
    persistActiveConversation();
    return { ok: true };
  }

  /**
   * The transcript's Resume action on a "Session stopped" notice: send
   * `Resume` as an ordinary prompt, exactly as if the reader had typed it (so a
   * "Resume" user message appears and the same session continues). Offered only
   * for a live, still-newest notice (see `transcriptView.ts`); ignored while a
   * turn is already in flight, mirroring the composer's own send gate.
   */
  function resumeStoppedSession(): void {
    if (isTurnInFlight(sessionStatus.state)) return;
    void onSend('Resume');
  }

  function onStop(): void {
    // A dev-only preview has no real turn to abort: Stop just leaves it.
    if (askUserPreview.active()) {
      askUserPreview.reset();
      composer.setInputRequest(undefined);
      return;
    }
    if (chatId === undefined) return;
    // A question owns the composer while it is on screen: its cancel means "no
    // answer", not "cancel the session". Dismiss the question and let the turn
    // continue - the `ask_user` tool reports the decline and the model wraps up
    // (the Load-more search loop's cancel ends the search, it does not abort the
    // turn). Aborting here would tear the whole turn down instead.
    if (pendingInputRequestId !== undefined) {
      composer.setInputRequest(undefined);
      onAnswer(buildNoAnswer());
      return;
    }
    // The `cancelling` event this abort produces is this pane's own Stop, not
    // an AEM-context abort - record it as such (see the event subscription).
    // Guarded on a turn actually being in flight, so a stray Stop with nothing
    // to cancel cannot leave the flag set for a later navigation abort.
    stopRequested = isTurnInFlight(sessionStatus.state);
    void window.daisy.agentChat.abort({ chatId }).then((result) => {
      if (!result.ok) statusBanner.showError(result.error.message);
    });
  }

  /**
   * Opens a message link in the AEM pane. The URL was already resolved to an
   * absolute, configured-host address by the markdown renderer. The shell
   * routes it to the browser pane (`onNavigateInBrowser`), so the browser pane
   * owns the navigation and its failure - the same path as a typed address.
   * Without shell wiring (a unit test) this falls back to the direct
   * `browser:navigate` call.
   */
  function openLink(url: string): void {
    if (options.onNavigateInBrowser !== undefined) {
      options.onNavigateInBrowser(url);
      return;
    }
    void window.daisy.browser.navigate(url).then((result) => {
      if (!result.ok) statusBanner.showError(result.error.message);
    });
  }

  /**
   * Opens a message link whose origin is not a configured AEM host in the
   * system browser. The URL was resolved by the markdown renderer; main
   * re-validates that it is http(s) before handing it to the OS, so the
   * renderer can never drive an arbitrary `shell.openExternal`.
   */
  function openExternal(url: string): void {
    void window.daisy.browser.openExternal({ url }).then((result) => {
      if (!result.ok) statusBanner.showError(result.error.message);
    });
  }

  /**
   * Copies a `format_table` run's table to the clipboard as both tab-separated
   * text and an HTML table, so a paste into Excel or Google Sheets keeps the
   * grid (and the header row). The renderer writes it directly - it is the app's
   * own trusted surface - and the action is silent: a copy either lands, or the
   * clipboard is unavailable, and a hover affordance has nothing useful to say
   * about the latter.
   */
  function copyTable(data: TableExportData): void {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) return;
    const text = tableToTsv(data);
    const html = tableToClipboardHtml(data);
    if (typeof ClipboardItem === 'undefined') {
      void clipboard.writeText(text).catch(() => undefined);
      return;
    }
    const item = new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    });
    void clipboard.write([item]).catch(() => {
      // A rich write can be refused (a permission the OS denies); the plain text
      // is the fallback a spreadsheet still splits into cells.
      void clipboard.writeText(text).catch(() => undefined);
    });
  }

  /**
   * Exports a `format_table` run's table as a CSV file. Main shows the OS save
   * dialog and writes the path the user picks; a cancelled dialog is a no-op,
   * not an error (and a write failure is reported by main, not here). A
   * successful write raises a sticky notice naming the file, with an **Open in
   * folder** action (which also dismisses the notice) - so the reader learns the
   * file landed and can jump straight to it. Banner copy carries no trailing
   * period.
   */
  function exportTable(data: TableExportData): void {
    void window.daisy.tableExport
      .saveCsv({
        suggestedFileName: suggestTableExportFileName(new Date()),
        content: tableToCsv(data),
      })
      .then((result) => {
        if (!result.ok || !result.saved) return;
        statusBanner.showNotice(`Exported to ${result.fileName}`, {
          label: 'Open in folder',
          onActivate: () => revealLastExport(),
        });
      })
      .catch(() => undefined);
  }

  /**
   * Reveals the file the last export wrote in the OS file manager. The path is
   * main's, never the renderer's; a failure (no export yet, or a refused
   * reveal) is reported in the pane's banner.
   */
  function revealLastExport(): void {
    void window.daisy.tableExport.revealLast().then((result) => {
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
   * open fails, the banner reports it and the next status poll re-opens this
   * same new id, which is why `chatId` is adopted up front rather than only on
   * success.
   */
  function startNewSession(): void {
    // No conversation is open yet (the service is still starting), and while an
    // open is in flight this control is disabled (see `openConversation`): a
    // second conversation must not start over a first that is still resolving.
    if (chatId === undefined || pendingOpen !== undefined) return;
    const id = newChatId(() => crypto.randomUUID());
    adoptChatId(id);
    conversationHasMessage = false;
    stopRequested = false;
    resetInputMode();
    transcriptStore.clear();
    sessionStatus = { ...sessionStatus, state: 'idle' };
    refreshEmptyState();
    // A fresh conversation starts at the bottom, following by default, even if
    // the previous one was left scrolled up.
    transcriptFollower.pin();
    // Repaint at once rather than waiting up to a whole timer tick for the
    // cleared store's dirty flag to be noticed - the user just asked for a
    // clean slate and should see one immediately.
    repaintTranscript();
    refreshSessionPresentation();
    // A fresh conversation should be ready to type into immediately.
    composer.focus();
    void openConversation(id).then((result) => {
      if (result.outcome === 'failed') statusBanner.showError(result.error.message);
    });
  }

  const statusBanner: StatusBanner = createStatusBanner({
    surfaceClassName: CHAT_STATUS_BANNER_SURFACE_CLASS,
  });

  /**
   * Points the pane at a conversation. A *changed* id makes any error row that
   * belonged to the previous conversation stale, so it is discarded here - the
   * one choke point every open path goes through (a fresh chat, a startup
   * resume, adopting a chat main already owns, a new session). A same-id
   * re-open - the runtime-recycle recovery in `applyStatus`, and a model or
   * effort change that recycles the runtime - deliberately leaves the error
   * alone: the conversation the user was reading has not changed.
   */
  function adoptChatId(id: ChatId): void {
    if (chatId !== id) statusBanner.clearError();
    chatId = id;
    // Owning a conversation is what makes "New session" actionable; re-derive
    // it here so a conversation adopted without an open of our own (main already
    // owns it after a renderer reload) enables the control.
    updateNewSessionEnabled();
  }

  const composer = createComposer({ onSend, onStop, onAnswer, onDevCommand });

  // The pane footer, sitting directly beneath the composer: on the left, a
  // short "agent / model / reasoning" summary that opens the Settings Agents
  // tab; on the right, an icon that reveals this conversation's journal file in
  // the OS file manager. Both hrefs are inert (`#`) because the actions go
  // through callbacks/IPC; `preventDefault` stops the fragment navigation.
  const agentSummaryAnchor = el('a', {
    attrs: { class: 'chat-agent-summary', href: '#', title: 'Open agent settings' },
  });
  agentSummaryAnchor.addEventListener('click', (event) => {
    event.preventDefault();
    options.onOpenSettings('agents');
  });
  const sessionIdAnchor = el('a', {
    attrs: {
      class: 'chat-session-id',
      href: '#',
      'aria-label': 'Reveal chat log in Explorer',
      title: 'Reveal chat log in Explorer',
    },
  });
  sessionIdAnchor.append(el('sp-icon-file-txt', { attrs: { size: 's' } }));
  sessionIdAnchor.addEventListener('click', (event) => {
    event.preventDefault();
    if (chatId === undefined) return;
    void window.daisy.agentChat.revealJournal({ chatId }).then((result) => {
      if (!result.ok) statusBanner.showError(result.error.message);
    });
  });
  const transcriptFooter = el('div', {
    attrs: { class: 'chat-pane__footer' },
    children: [agentSummaryAnchor, sessionIdAnchor],
  });

  /**
   * Reflects the current conversation and active agent into the footer. The row
   * is visible only once there is a conversation with content, so an empty or
   * not-yet-open chat shows nothing; the summary line is hidden within it while
   * no agent is active (the icon still shows). Called from both refresh paths
   * (the status derivation and the transcript's empty-state check), since either
   * can be the first to see a new `chatId`, the first transcript item, or a
   * changed active agent.
   */
  function updateSessionFooter(): void {
    transcriptFooter.hidden = !(chatId !== undefined && !conversationEmpty);
    const summary = activeAgentId === undefined ? undefined : buildAgentSummary(activeAgentId);
    agentSummaryAnchor.hidden = summary === undefined;
    agentSummaryAnchor.textContent = summary ?? '';
  }

  const transcript = el('div', {
    attrs: { class: 'chat-transcript' },
    children: [transcriptView.element],
  });

  /**
   * Keeps the transcript on its newest entry - an assistant message or a
   * tool-call billet alike - while the reader is at the bottom, and re-pins it
   * across layout changes (a banner appearing, the composer growing, a
   * late-loading image) that used to look like scrolling away - see
   * `transcriptFollower.ts`. Every repaint path (the throttled timer,
   * `startNewSession`'s immediate one, a link-context change) goes through here
   * so they can never disagree about following.
   *
   * A repaint may also report a message the application updated in place (a
   * search table gaining an appended page). That update supersedes the reader's
   * scroll position, so its bottom is revealed even if they had scrolled up.
   */
  const transcriptFollower = createTranscriptFollower({
    scroller: transcript,
    content: transcriptView.element,
  });

  function repaintTranscript(): void {
    let updated: readonly HTMLElement[] = [];
    transcriptFollower.repaint(() => {
      updated = transcriptView.repaint(transcriptStore);
    });
    const updatedMessage = updated[updated.length - 1];
    if (updatedMessage !== undefined) transcriptFollower.reveal(updatedMessage);
  }

  const chatToolbar = createChatToolbar({
    onOpenSettings: () => options.onOpenSettings(),
    onOpenHistory: () => options.onOpenHistory?.(),
    onNewSession: startNewSession,
  });
  setNewSessionEnabled = (enabled) => chatToolbar.setNewSessionEnabled(enabled);
  // A fresh pane owns no conversation, so "New session" starts disabled - it
  // has nothing to act on until a `ChatId` is adopted (see
  // `updateNewSessionEnabled`).
  updateNewSessionEnabled();
  const element = el('section', {
    attrs: { class: 'pane chat-pane', 'aria-label': 'Chat' },
    children: [
      chatToolbar.element,
      transcript,
      composer.element,
      transcriptFooter,
      statusBanner.element,
    ],
  });

  // A new pane starts on an empty conversation: full-height prompt.
  refreshEmptyState();

  const repaintTimer = setInterval(() => {
    if (transcriptStore.takeDirty()) {
      repaintTranscript();
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
  // Resolve and paint the remembered conversation's journal now, in parallel
  // with the runtime's cold start - the transcript no longer waits on the SDK.
  void preloadStartupConversation();

  return {
    element,
    setAgents(next: Readonly<Record<string, AgentSettingsSnapshot>>): void {
      // A model/effort/active change arrives here (the shell re-applies the
      // snapshot after a Settings save). Re-read the catalogue only when the
      // map actually changed, so an unrelated settings edit does not trigger a
      // catalogue read.
      const changed = JSON.stringify(next) !== JSON.stringify(agents);
      agents = next;
      refreshSessionPresentation();
      if (changed) void loadModelSelection();
    },
    setLinkContext(next: LinkContext): void {
      if (linkContextsEqual(linkContext, next)) return;
      linkContext = next;
      // Repaint immediately: a link's clickability changed but no message text
      // did, so the store is not dirty and the timer would not pick it up.
      repaintTranscript();
    },
    openConversationFromHistory,
    handleConversationDeleted,
    dispose(): void {
      unsubscribeEvents?.();
      unsubscribeStatus();
      clearInterval(repaintTimer);
      if (startingPollHandle !== undefined) clearInterval(startingPollHandle);
      if (readyPollHandle !== undefined) clearInterval(readyPollHandle);
      transcriptFollower.dispose();
      statusBanner.dispose();
      composer.dispose();
      transcriptView.dispose();
    },
  };
}
