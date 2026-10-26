import {
  createAgentChatController,
  type AgentChatController,
  type AgentChatControllerDeps,
  type HostContext,
  type ProjectRulesContext,
  type StartupGatedAgentChatController,
} from './agentChatController';
import type { FakeAgentService } from './agents/fakeAgentService';
import type { AgentHub } from './agents/hub';
import { type ActiveHost } from './browser/browserController';
import { type NavigationEpochTracker } from './browser/navigationEpoch';
import type { ChatJournal } from './chatJournal';
import type { Logger } from './logger';
import {
  type AgentService,
  type ChatId,
  type ConfiguredHostInfo,
  type CurrentBridgeContext,
  type CurrentToolContext,
  type EnvironmentFacts,
  type IdGenerator,
  type ModelCatalogEntry,
  type ModelPreference,
  type OneShotRequest,
  type OneShotResult,
  type ProjectConfig,
  type SessionId,
  type ServerConfig,
  type SessionStreamState,
  type ToolCallId,
  type UsageSink,
  type UserInputAnswer,
  type UserInputRequest,
  deriveCurrentPageContext,
  err,
  originsMatch,
  parseNavigationTarget,
  renderCurrentPageContextForModel,
  resolveHostEnvironmentRoots,
} from '../shared';

/**
 * The production composition root (`src/main/index.ts`) wires together every
 * component of the tool vertical slice - the bridge transport/broker
 * (`src/main/webview/**`), the SDK/fake `AgentService` adapters (`src/agent/**`),
 * and `agentChatController.ts` - but `index.ts` itself only runs inside
 * `app.whenReady()`, where nothing is independently callable by a test. This
 * module holds every piece of that wiring that has a decision worth testing
 * in isolation: which agent service to construct, how a `CurrentBridgeContext`/
 * `CurrentToolContext`/`HostContext` is derived from the browser
 * controller's live state, and how a request actually reaches the bridge
 * broker. `index.ts` only calls these functions inside `app.whenReady()`; it
 * adds no logic of its own on top of them.
 */

// ---------------------------------------------------------------------------
// Deriving "the current host/document" for the tool pipeline
// ---------------------------------------------------------------------------

/**
 * Builds the `AgentChatControllerDeps.currentHostContext` provider from
 * `BrowserController.activeServer`. Returns a closure - not a snapshot - so
 * every call re-reads `getActiveServer()`: a server switch between one tool
 * call and the next must be visible on the very next call, never only from
 * whatever server was active when this function ran.
 */
export function createCurrentHostContext(
  getActiveServer: () => ActiveHost | undefined,
): () => HostContext | undefined {
  return () => {
    const server = getActiveServer();
    if (server === undefined) return undefined;
    return { origin: server.origin, serverId: server.serverId, serverRevision: server.revision };
  };
}

/**
 * Builds the model-facing "where the browser pane is" context the chat
 * controller prepends to every prompt.
 *
 * Reads the active server and the live document URL fresh on every call - the
 * same closure-not-snapshot rule as {@link createCurrentHostContext} -
 * because the user can navigate to a different page (or switch servers)
 * between one turn and the next, and the context has to describe where they
 * are now.
 *
 * Returns `undefined` when there is no active server, or when
 * `deriveCurrentPageContext` refuses the URL (an unparseable URL, a non-http(s)
 * scheme, or any origin that is not the active server's own). That refusal is
 * what keeps an SSO/IdP URL out of the agent's context; the model simply gets
 * no page context for that turn rather than an unsafe or misleading one.
 */
export function createCurrentPageContext(
  getActiveServer: () => ActiveHost | undefined,
  getDocumentUrl: () => string | undefined,
  getEnvironmentFacts: () => EnvironmentFacts | undefined,
): () => string | undefined {
  return () => {
    const server = getActiveServer();
    if (server === undefined) return undefined;
    const facts = getEnvironmentFacts();
    const context = deriveCurrentPageContext({
      documentUrl: getDocumentUrl(),
      activeOrigin: server.origin,
      ...(facts !== undefined
        ? {
            contentRoots: facts.contentRoots,
            componentRoots: facts.componentRoots,
            damRoots: facts.damRoots,
          }
        : {}),
    });
    return context === undefined ? undefined : renderCurrentPageContextForModel(context);
  };
}

/**
 * Builds the "environment facts" provider the tool host and the page-context
 * block both read: the origin of the host the browser pane is on right now,
 * and that host's effective content/component/DAM roots.
 *
 * Matches the live document URL against the configured hosts by origin
 * (`parseNavigationTarget` + `originsMatch`, the same idiom the address bar and
 * the browser controller use), never against the model's arguments. Returns
 * `undefined` when there is no document, the URL is unusable, or its origin is
 * not a configured host - so an SSO/IdP page or an unconfigured origin yields
 * no facts rather than a guessed host.
 *
 * `getHosts` is read fresh on every call (a roots edit in Settings must be
 * visible on the very next prompt/tool call), which is why it is a closure
 * rather than a snapshot.
 */
export function createEnvironmentFacts(
  getDocumentUrl: () => string | undefined,
  getHosts: () => readonly ServerConfig[],
  getProjects: () => readonly ProjectConfig[],
): () => EnvironmentFacts | undefined {
  return () => {
    const documentUrl = getDocumentUrl();
    if (documentUrl === undefined) return undefined;
    const target = parseNavigationTarget(documentUrl);
    if (!target.ok) return undefined;
    const host = getHosts().find((candidate) => originsMatch(candidate.origin, target.origin));
    if (host === undefined) return undefined;
    const roots = resolveHostEnvironmentRoots(host, getProjects());
    return {
      origin: target.origin,
      contentRoots: roots.contentRoots,
      componentRoots: roots.componentRoots,
      damRoots: roots.damRoots,
      contentPriorityPaths: roots.contentPriorityPaths,
    };
  };
}

/**
 * Builds the provider of the label of the project the host the browser pane is
 * on belongs to, for the user's project rules. Resolved the same way as
 * {@link createEnvironmentFacts} (the live document URL matched against the
 * configured hosts by origin, read fresh each call), then through the host's
 * `projectId`. `undefined` when there is no document, the origin is not a
 * configured host, or the host selects no project (or one that no longer exists).
 */
export function createCurrentProjectLabel(
  getDocumentUrl: () => string | undefined,
  getHosts: () => readonly ServerConfig[],
  getProjects: () => readonly ProjectConfig[],
): () => string | undefined {
  return () => {
    const documentUrl = getDocumentUrl();
    if (documentUrl === undefined) return undefined;
    const target = parseNavigationTarget(documentUrl);
    if (!target.ok) return undefined;
    const host = getHosts().find((candidate) => originsMatch(candidate.origin, target.origin));
    if (host?.projectId === undefined) return undefined;
    return getProjects().find((project) => project.id === host.projectId)?.label;
  };
}

/**
 * Builds the model-facing host catalogue the `environment_facts` tool and the
 * `browser_navigate` tool read: every configured host as a label, an origin and
 * its effective roots (resolved through the host's selected project).
 *
 * `getHosts`/`getProjects` are read fresh on every call, so a host added,
 * renamed or re-rooted in Settings is visible on the very next tool call - the
 * same closure-not-snapshot rule as {@link createEnvironmentFacts}. The origins
 * come from the settings document, never from a tool argument.
 */
export function createConfiguredHosts(
  getHosts: () => readonly ServerConfig[],
  getProjects: () => readonly ProjectConfig[],
): () => readonly ConfiguredHostInfo[] {
  return () =>
    getHosts().map((host) => {
      const roots = resolveHostEnvironmentRoots(host, getProjects());
      return {
        serverId: host.id,
        label: host.label,
        origin: host.origin,
        contentRoots: roots.contentRoots,
        componentRoots: roots.componentRoots,
        damRoots: roots.damRoots,
        contentPriorityPaths: roots.contentPriorityPaths,
      };
    });
}

/**
 * No server selected has to become a `CurrentBridgeContext` that makes
 * `classifyStaleness` (`toolContracts.ts`) fail *closed* for any request
 * already in flight, never one that happens to let a stray reply through.
 * `serverRevisionSchema` (`serverConfig.ts`) is `z.number().int().nonnegative()`,
 * so no real envelope can ever carry this sentinel - the comparison can only
 * ever disagree with it, which is exactly "stale_server_revision".
 */
const NO_ACTIVE_SERVER_REVISION_SENTINEL = -1;

/**
 * Builds the `BrokerDeps.currentContext` provider for `createWebviewBridgeBroker`.
 * Reads `getActiveServer()`/`navigationEpoch()` fresh on every call, for the
 * same reason as `createCurrentHostContext` above - the broker's own doc
 * comment requires this ("the live serverRevision + navigationEpoch, read
 * fresh at every decision point").
 */
export function createBridgeCurrentContext(
  getActiveServer: () => ActiveHost | undefined,
  navigationEpoch: () => number,
): () => CurrentBridgeContext {
  return () => ({
    serverRevision: getActiveServer()?.revision ?? NO_ACTIVE_SERVER_REVISION_SENTINEL,
    navigationEpoch: navigationEpoch(),
  });
}

/**
 * Resolves the one directory the application's own bundled resources may be
 * loaded from: the skills (`skills/`) and the model-facing instructions
 * (`rules/`).
 *
 * It must be absolute and derive solely from the application's own install
 * location - never from settings, the user's home directory, the project
 * directory, or anything a response could influence.
 *
 * Packaged builds carry `resources/` **inside** `app.asar` (electron-builder.yml's
 * `files`), so it travels with an in-app update and lands under the app path -
 * `resources/app.asar/resources` on disk. Unpackaged runs execute from
 * `out/main`, two levels below the repository root where `resources/` lives.
 */
export function resolveBundledResourcesDirectory(params: {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly mainDir: string;
  readonly join: (...segments: readonly string[]) => string;
}): string {
  return params.isPackaged
    ? params.join(params.appPath, 'resources')
    : params.join(params.mainDir, '..', '..', 'resources');
}

// ---------------------------------------------------------------------------
// Tying the knot: the tool executor needs the chat controller's context
// provider, but the chat controller is built from the agent service, which
// is built from the tool executor.
// ---------------------------------------------------------------------------

export interface LateBoundToolContext {
  /**
   * Passed to every tool executor (via `ToolHost.currentContext`). Throws if
   * called before `bind` - which would mean a tool call reached the
   * executor before the composition root finished wiring the chat
   * controller, a construction-order bug worth failing loudly on rather
   * than masking with a placeholder context.
   */
  readonly currentContext: () => CurrentToolContext;
  /** Supplies the real provider once the chat controller exists. Call exactly once. */
  readonly bind: (controller: Pick<AgentChatController, 'currentToolContext'>) => void;
}

export function createLateBoundToolContext(): LateBoundToolContext {
  let bound: Pick<AgentChatController, 'currentToolContext'> | undefined;
  return {
    currentContext: () => {
      if (bound === undefined) {
        throw new Error('Tool context requested before the chat controller was bound');
      }
      return bound.currentToolContext();
    },
    bind: (controller) => {
      bound = controller;
    },
  };
}

/**
 * The tool host's interactive-question capability, late-bound for the same
 * reason as {@link LateBoundToolContext}: the tool registry (and its host)
 * is built before the chat controller exists, and the controller is the only
 * thing that knows which conversation is active. Throws if called before
 * `bind` - which would mean an `ask_user` tool call reached its executor before
 * the composition root finished wiring, a construction-order bug worth failing
 * loudly on rather than silently never answering.
 */
export interface LateBoundUserInput {
  readonly requestUserInput: (request: UserInputRequest) => Promise<UserInputAnswer>;
  readonly bind: (controller: Pick<AgentChatController, 'requestUserInput'>) => void;
}

export function createLateBoundUserInput(): LateBoundUserInput {
  let bound: Pick<AgentChatController, 'requestUserInput'> | undefined;
  return {
    requestUserInput: async (request) => {
      if (bound === undefined) {
        throw new Error('User input requested before the chat controller was bound');
      }
      const result = await bound.requestUserInput(request);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
    bind: (controller) => {
      bound = controller;
    },
  };
}

/**
 * The tool host's progress capability, late-bound for the same construction
 * order as {@link LateBoundToolContext} and {@link LateBoundUserInput}: the
 * tool registry is built before the chat controller exists. Unlike those, an
 * early report is a silent no-op rather than a throw - a progress note is pure
 * UX, so losing one that raced startup must never fail a tool call.
 */
export interface LateBoundToolProgress {
  readonly report: (toolCallId: ToolCallId, text: string) => void;
  readonly bind: (controller: Pick<AgentChatController, 'recordToolProgress'>) => void;
}

export function createLateBoundToolProgress(): LateBoundToolProgress {
  let bound: Pick<AgentChatController, 'recordToolProgress'> | undefined;
  return {
    report: (toolCallId, text) => {
      bound?.recordToolProgress(toolCallId, text);
    },
    bind: (controller) => {
      bound = controller;
    },
  };
}

/**
 * The tool host's "add actions to the pending question" capability,
 * late-bound and silently lossy exactly like {@link LateBoundToolProgress}: a
 * reveal that races startup only means the button waits for the next question.
 */
export interface LateBoundUserInputActions {
  readonly add: (actions: readonly string[]) => void;
  readonly bind: (controller: Pick<AgentChatController, 'recordUserInputActionsAdded'>) => void;
}

export function createLateBoundUserInputActions(): LateBoundUserInputActions {
  let bound: Pick<AgentChatController, 'recordUserInputActionsAdded'> | undefined;
  return {
    add: (actions) => {
      bound?.recordUserInputActionsAdded(actions);
    },
    bind: (controller) => {
      bound = controller;
    },
  };
}

/**
 * The usage sink for model calls a tool makes on the chat's behalf outside the
 * conversation, late-bound and silently lossy like {@link LateBoundToolProgress}
 * (the registry is built before the chat controller): a report that races
 * startup simply is not counted.
 */
export interface LateBoundAuxiliaryUsage {
  readonly report: UsageSink;
  readonly bind: (controller: Pick<AgentChatController, 'recordAuxiliaryUsage'>) => void;
}

export function createLateBoundAuxiliaryUsage(): LateBoundAuxiliaryUsage {
  let bound: Pick<AgentChatController, 'recordAuxiliaryUsage'> | undefined;
  return {
    report: (usage) => {
      bound?.recordAuxiliaryUsage(usage);
    },
    bind: (controller) => {
      bound = controller;
    },
  };
}

/**
 * The one path every tool-triggered **secondary agentic turn** takes to the
 * model (see `src/shared/agents/oneShot.ts`): the semantic search's verdicts
 * today, any tool's later. It binds, in exactly one place, what such a call must
 * always carry - the usage sink that lands its tokens in the chat's gross totals
 * - so a tool's capability is `build a prompt -> complete -> parse` and cannot
 * reach the model without being counted.
 *
 * Adding a tool that asks the model something: write its prompt and parser in
 * `src/shared/tools/core/`, expose a `ToolHost` capability built on this
 * `complete` (as `answerWith` is, in `index.ts`), and touch no agent.
 *
 * `hub` is read per call because the agent starts after the shell paints; a call
 * before that fails cleanly instead of throwing.
 */
export interface SecondaryTurns {
  readonly complete: (
    request: OneShotRequest,
    signal: AbortSignal | undefined,
  ) => Promise<OneShotResult>;
}

export function createSecondaryTurns(options: {
  readonly hub: () => Pick<AgentHub, 'complete'> | undefined;
  readonly reportUsage: UsageSink;
}): SecondaryTurns {
  return {
    complete: (request, signal) => {
      const hub = options.hub();
      return hub === undefined
        ? Promise.resolve(err({ message: 'The agent is still starting' }))
        : hub.complete(request, signal, options.reportUsage);
    },
  };
}
// ---------------------------------------------------------------------------
// Server-switch cancellation (Milestone A criterion 6)
// ---------------------------------------------------------------------------

/**
 * Subscribes to `navigationEpoch` and cancels the chat controller's in-flight
 * turn on every *user*-initiated bump (document navigation, server switch,
 * render-process-gone, view-destroyed - see `NavigationEpochBumpReason`), so an
 * host-context-invalidating event the user caused cancels in-flight agent work
 * the same way pressing Stop does.
 *
 * An *agent*-initiated bump is deliberately ignored: the `browser_navigate`
 * tool moving the pane to another host so it can resolve a page name there is
 * the turn doing what it was asked, not a reason to abort it. The epoch still
 * moves (the broker discards in-flight replies from the previous document);
 * only the cancellation is skipped. Returns the unsubscribe function; the
 * composition root calls it alongside every other shutdown cleanup.
 *
 * `handleHostContextInvalidated()` already logs and swallows a `Result`-shaped
 * failure from `agentService.abort` internally (see its own doc comment) and
 * is documented never to throw for that case; the `.catch` here is
 * defense-in-depth against an `AgentService` implementation that violates its
 * own contract and rejects instead, so a bug in a *future* adapter cannot
 * turn into an unhandled promise rejection here.
 */
export function wireNavigationEpochCancellation(
  navigationEpoch: Pick<NavigationEpochTracker, 'subscribe'>,
  chatController: Pick<AgentChatController, 'handleHostContextInvalidated'>,
  logger: Logger,
): () => void {
  return navigationEpoch.subscribe((change) => {
    if (change.initiator === 'agent') return;
    chatController.handleHostContextInvalidated().catch(() => {
      logger.error('AGENT_CHAT_ABORT_ON_CONTEXT_CHANGE_FAILED');
    });
  });
}

// ---------------------------------------------------------------------------
// Fake-vs-real agent selection
// ---------------------------------------------------------------------------

/**
 * No convention for this existed anywhere in the repo before this change
 * (only Electron's own `ELECTRON_RENDERER_URL` was read from `process.env`
 * anywhere under `src/`) - this is the one this task establishes.
 */
export const FAKE_AGENT_SERVICE_ENV_VAR = 'ETOOLBOX_DAISY_FAKE_AGENT_SERVICE';

/**
 * Whether the deterministic fake should be used instead of the real SDK
 * adapter. `isPackaged` is checked first and unconditionally wins: an
 * installed production build must never be startable against a fake agent,
 * no matter what its environment happens to contain (a launcher script, a
 * leftover CI variable, ...). Only the unpackaged app launched directly for
 * E2E (`electron.launch({ args: [mainEntry], env })`) can ever honour the
 * variable.
 */
export function shouldUseFakeAgentService(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
): boolean {
  if (isPackaged) return false;
  return Boolean(env[FAKE_AGENT_SERVICE_ENV_VAR]);
}

/**
 * `globalThis` property name `tests/e2e/agent-chat.spec.ts` reads via
 * Playwright's `electronApplication.evaluate(...)`, which runs its callback
 * directly inside this same main process - so a value assigned here is
 * visible to that callback with no IPC of its own. Named obviously
 * test-only, deliberately not reachable through any `window.daisy.*`
 * surface: this is not a new production IPC channel, just a same-process
 * back door the deterministic E2E suite uses to drive the fake (`advance`/
 * `flush`/`scriptNextResponse` - implementation-plan.md step 07's "the fake
 * never self-delivers past a turn's first event; something must pump it").
 */
export const TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY = '__etoolboxDaisyTestFakeAgentService' as const;

/**
 * Publishes `fakeService` for the E2E suite to reach via
 * `TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY`. Called from exactly one place -
 * the fake runtime (`agents/fakeRuntime.ts`), which the agent hub only
 * builds when `shouldUseFakeAgentService` is true. `isPackaged` makes that
 * false unconditionally in a packaged build (see `shouldUseFakeAgentService`
 * above), so this global can never exist there, regardless of environment.
 */
export function exposeFakeAgentServiceForTests(fakeService: FakeAgentService): void {
  (globalThis as Record<string, unknown>)[TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY] = fakeService;
}

// ---------------------------------------------------------------------------
// Non-blocking agent service installation
// ---------------------------------------------------------------------------

/**
 * Everything `installAgentService` needs to take an already-constructed
 * `AgentService` (from whichever agent is configured) to "an
 * `AgentChatController` the rest of the app can use".
 */
export interface InstallAgentServiceDeps {
  readonly logger: Logger;
  readonly idGenerator: IdGenerator;
  readonly currentHostContext: () => HostContext | undefined;
  readonly navigationEpoch: () => number;
  /** The model-facing "where the browser pane is" block prepended to each prompt. */
  readonly currentPageContext: () => string | undefined;
  /** Optional append-only chat journal (implementation-plan.md step 09). */
  readonly chatJournal?: ChatJournal;
  /** Cancels in-flight bridge requests when a turn is cancelled. */
  readonly cancelBridgeRequests?: () => void;
  /**
   * Rewrites a prompt that begins with a bundled-skill reference into the
   * model-facing directive that loads that skill. Optional and passed through
   * verbatim to `createAgentChatController`; omitted means no rewrite.
   */
  readonly resolveSkillPrompt?: AgentChatControllerDeps['resolveSkillPrompt'];
  /** Reads every SDK session id a chat's journal recorded, for conversation deletion. See `AgentChatControllerDeps`. */
  readonly readChatSessionIds?: (chatId: ChatId) => readonly SessionId[];
  /** Removes a chat's stored journal file, for conversation deletion. See `AgentChatControllerDeps`. */
  readonly removeChatJournal?: (chatId: ChatId) => boolean;
  /** The user's rules for the pane's current project. See `AgentChatControllerDeps`. */
  readonly currentProjectRules?: () => ProjectRulesContext | undefined;
  /** Said once when the pane leaves a project that had rules. See `AgentChatControllerDeps`. */
  readonly projectRulesEndedNote?: string;
  /** The self-learning block for a conversation's first prompt. See `AgentChatControllerDeps`. */
  readonly currentMemos?: AgentChatControllerDeps['currentMemos'];
  /** The automatic reflection's prompt. See `AgentChatControllerDeps`. */
  readonly reflectionPrompt?: AgentChatControllerDeps['reflectionPrompt'];
  /** Swapped in via `replaceDelegate` - see that method's own doc comment. */
  readonly gatedController: StartupGatedAgentChatController;
}

/**
 * Runs `agentService.initialize()` and, once it succeeds, builds the real
 * `AgentChatController` and hands it to `deps.gatedController.replaceDelegate`.
 * Agent-neutral: the agent's own runtime (SDK client, child process, ...) has
 * already been started by its plugin folder, which then calls this through
 * `AgentHost.installService`. Any of this can run long after the window is
 * interactive; it is never on the startup critical path.
 *
 * Deliberately returns the rejection to its caller instead of swallowing it: a
 * failure here must not leave `gatedController` silently stuck answering
 * `serviceState: "starting"` forever with no trace in the logs.
 */
export async function installAgentService(
  deps: InstallAgentServiceDeps,
  agentService: AgentService,
): Promise<void> {
  await agentService.initialize();
  const controller = createAgentChatController({
    agentService,
    logger: deps.logger,
    idGenerator: deps.idGenerator,
    currentHostContext: deps.currentHostContext,
    navigationEpoch: deps.navigationEpoch,
    currentPageContext: deps.currentPageContext,
    ...(deps.chatJournal !== undefined ? { chatJournal: deps.chatJournal } : {}),
    ...(deps.cancelBridgeRequests !== undefined
      ? { cancelBridgeRequests: deps.cancelBridgeRequests }
      : {}),
    ...(deps.resolveSkillPrompt !== undefined
      ? { resolveSkillPrompt: deps.resolveSkillPrompt }
      : {}),
    ...(deps.readChatSessionIds !== undefined
      ? { readChatSessionIds: deps.readChatSessionIds }
      : {}),
    ...(deps.removeChatJournal !== undefined ? { removeChatJournal: deps.removeChatJournal } : {}),
    ...(deps.currentProjectRules !== undefined
      ? { currentProjectRules: deps.currentProjectRules }
      : {}),
    ...(deps.projectRulesEndedNote !== undefined
      ? { projectRulesEndedNote: deps.projectRulesEndedNote }
      : {}),
    ...(deps.currentMemos !== undefined ? { currentMemos: deps.currentMemos } : {}),
    ...(deps.reflectionPrompt !== undefined ? { reflectionPrompt: deps.reflectionPrompt } : {}),
  });
  await deps.gatedController.replaceDelegate(controller);
}

/**
 * Registers everything that does not depend on an agent runtime, then
 * kicks off `startAgentService` (in practice, the agent hub's `start`) without ever awaiting it - so the agent runtime's own startup
 * latency can never delay, gate, or skip `registerNonAgentHandlers`, no
 * matter what is added to either side later. This is the one place that
 * encodes "startup order must reflect real dependencies, not the order
 * features were added" as code a test can hold onto, rather than merely as
 * a comment in `index.ts`.
 *
 * A rejection from `startAgentService()` is always routed to
 * `onAgentServiceStartupFailed` - never left unhandled, never silently
 * dropped. `index.ts` wires that parameter to log loudly through the
 * existing `logger`, so a partially-wired app (agent runtime missing, corrupt
 * install, ...) is diagnosable from the log file instead of silent.
 */
export function startAppRuntime(deps: {
  readonly registerNonAgentHandlers: () => void;
  readonly startAgentService: () => Promise<void>;
  readonly onAgentServiceStartupFailed: (error: unknown) => void;
}): void {
  deps.registerNonAgentHandlers();
  // Never awaited: that is the entire point (see this function's own doc
  // comment). `void` marks the intentionally-unawaited promise for
  // `@typescript-eslint/no-floating-promises`; `.catch` is what keeps it
  // from ever becoming an *unhandled* rejection.
  void deps.startAgentService().catch(deps.onAgentServiceStartupFailed);
}

// ---------------------------------------------------------------------------
// Keeping an agent SDK's import cost off the window's startup path
// ---------------------------------------------------------------------------

/**
 * The two `WebContents` facts {@link runAfterFrameLoad} needs, kept as plain
 * callbacks so the decision it encodes stays Electron-free and unit-testable -
 * the same injected-facts style as `RuntimePathsEnv` (in the Copilot agent
 * folder) rather than importing Electron here.
 */
export interface FrameLoadSignal {
  /** `WebContents.isLoadingMainFrame()`. */
  readonly isLoadingMainFrame: () => boolean;
  /** `WebContents.once('did-finish-load', run)`. */
  readonly onceLoaded: (run: () => void) => void;
}

/**
 * Runs `start` once the frame has finished loading its initial document, or on
 * the next tick when it already has. `start` is invoked at most once.
 *
 * This exists because building the agent registry imports each agent's
 * `agent.ts`, which evaluates its SDK's whole module graph *synchronously on
 * the main thread*. That is not cheap for a large generated SDK (measured at
 * ~740 ms for `@openrouter/agent` - see docs/verification.md): run while the
 * renderer is still fetching its first resources, it starves the `app://`
 * protocol handler and the window stays blank for the block's whole duration.
 * Deferring to `did-finish-load` lets the shell paint first. Nothing visible
 * before then depends on an agent, because the chat surface answers
 * `serviceState: "starting"` until the service installs (see
 * `createStartupGatedAgentChatController`).
 *
 * The caller is responsible for a backstop when the load event never arrives
 * (a renderer failure); this helper only encodes *when*, never *whether*.
 */
export function runAfterFrameLoad(signal: FrameLoadSignal, start: () => void): void {
  let started = false;
  const run = (): void => {
    if (started) return;
    started = true;
    start();
  };
  if (signal.isLoadingMainFrame()) {
    signal.onceLoaded(run);
  } else {
    // Already loaded: still defer past the current tick so anything already
    // queued on the event loop (an in-flight IPC reply the shell is awaiting)
    // is serviced before the agent import blocks the thread.
    setImmediate(run);
  }
}

// ---------------------------------------------------------------------------
// Model / reasoning-effort preference cache (step 09)
// ---------------------------------------------------------------------------

/**
 * A synchronously-readable copy of the persisted model/reasoning-effort
 * defaults.
 *
 * This exists because of a genuine impedance mismatch, not as a convenience.
 * `SdkAgentServiceOptions.modelPreferences` is called on the `sendPrompt` path
 * and must be synchronous - a disk read before every single turn would add
 * latency to the one operation users feel most - while the authoritative copy
 * of the setting lives in the settings *file*, which is only readable
 * asynchronously.
 *
 * The cache is therefore seeded from the settings load that already happens at
 * startup, and updated by the one code path that can change the value
 * (`settings:set-model-preferences`, via {@link ModelPreferenceCache.set}).
 * There is no polling and no invalidation window: the setting cannot change
 * except through that channel, because the Settings window is the only writer
 * and it goes through that IPC.
 */
export interface ModelPreferenceCache {
  /** The preference to use for the next prompt. Never throws, never blocks. */
  current(): ModelPreference;
  /** Records a newly persisted preference. Called only after a successful save. */
  set(preference: ModelPreference): void;
}

export function createModelPreferenceCache(initial: ModelPreference): ModelPreferenceCache {
  let preference: ModelPreference = initial;
  return {
    current: () => preference,
    set(next: ModelPreference): void {
      preference = next;
    },
  };
}

/**
 * The chat states during which a turn is in flight.
 *
 * This is no longer a "model selection is locked" predicate: a model/effort
 * change is applied on the next prompt and never has to be refused or disabled
 * (see `src/shared/contracts/modelCatalog.ts`). It now answers a different
 * question - "may a runtime recycle happen yet?" - for the deferred recycler
 * below: stopping the child runtime that is serving a live turn would abort it,
 * so a proxy/token/active-provider recycle waits until this answers false.
 *
 * `cancelling` counts as in flight: cancellation is a request, not a completed
 * fact - the SDK session is still winding the turn down and has not yet
 * returned to `idle` - so recycling during it would race the very turn being
 * stopped.
 *
 * `error` and `closed` do NOT: both mean no turn is running, so a user whose
 * turn failed because of the model they picked can change it and have the
 * change applied immediately.
 */
export const AGENT_TURN_IN_FLIGHT_STATES: ReadonlySet<SessionStreamState> = new Set([
  'sending',
  'streaming',
  'runningTool',
  'cancelling',
]);

/** Whether a chat turn is currently in flight in `state`. */
export function isAgentTurnInFlight(state: SessionStreamState): boolean {
  return AGENT_TURN_IN_FLIGHT_STATES.has(state);
}

/**
 * Serializes the agent-runtime recycles a Settings change triggers, deferring
 * any that arrives while a turn is in flight.
 *
 * A proxy, token or active-provider change shapes the child runtime, which can
 * only be applied by stopping the process serving the live turn - so doing it
 * mid-turn would abort the turn. This is the "apply on the next turn" half of
 * the settings policy: when idle a recycle runs immediately (and `request`
 * resolves once it has, so the renderer's follow-up reload reads a ready
 * runtime); while `isTurnInFlight()` is true it is queued instead, and is run
 * as soon as the turn settles - or, at the latest, awaited by the next prompt
 * through the gated controller's `beforeSendMessage`. A recycle never starts
 * while a turn is in flight, and the queue is drained in order so a burst of
 * mid-turn changes lands in the order they were made.
 *
 * A throwing recycle is reported through `onError` and does not stop the rest
 * of the queue: one unresolvable proxy must not wedge every later change.
 */
export interface DeferredRuntimeRecycler {
  /**
   * Queues `recycle`, applying it at once when no turn is in flight. Resolves
   * once the recycle has been applied, or immediately when it was deferred.
   */
  request(recycle: () => Promise<void>): Promise<void>;
  /**
   * Applies any queued recycle once the turn has settled. A no-op while a
   * recycle is already running or a turn is still in flight, so it is safe to
   * call on every status change (and before every prompt).
   */
  drain(): Promise<void>;
}

export function createDeferredRuntimeRecycler(deps: {
  readonly isTurnInFlight: () => boolean;
  readonly onError: (error: unknown) => void;
}): DeferredRuntimeRecycler {
  const queue: Array<() => Promise<void>> = [];
  let running: Promise<void> | undefined;

  async function runQueue(): Promise<void> {
    while (queue.length > 0) {
      // Re-checked each iteration so a send that raced the drain leaves the
      // rest queued rather than recycling under a fresh turn.
      if (deps.isTurnInFlight()) return;
      const recycle = queue.shift();
      if (recycle === undefined) return;
      try {
        await recycle();
      } catch (error) {
        deps.onError(error);
      }
    }
  }

  function drain(): Promise<void> {
    if (running !== undefined) return running;
    if (queue.length === 0 || deps.isTurnInFlight()) return Promise.resolve();
    running = runQueue().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    request(recycle) {
      queue.push(recycle);
      return drain();
    },
    drain,
  };
}

/**
 * A fixed model catalogue used in place of the SDK's when the deterministic
 * fake agent service is in use.
 *
 * No real agent runtime is started under the fake, so `listModels()` has
 * nothing to answer and the Models section would otherwise be permanently
 * stuck on "the list of models could not be loaded" - leaving every selection
 * and persistence path in step 09 unreachable by the E2E suite.
 *
 * It is reached only where {@link shouldUseFakeAgentService} is already true,
 * which `isPackaged` makes false unconditionally in a packaged build, so this
 * cannot substitute for the real catalogue in a shipped app. The two entries
 * are deliberately different in kind: one with reasoning levels, one with
 * none, so "show only supported reasoning levels" is observable.
 */
export function fakeModelCatalog(): readonly ModelCatalogEntry[] {
  return [
    {
      id: 'fake-model-reasoning',
      name: 'Fake Model (reasoning)',
      supportedReasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low',
    },
    { id: 'fake-model-plain', name: 'Fake Model (no reasoning)', supportedReasoningEfforts: [] },
  ];
}
