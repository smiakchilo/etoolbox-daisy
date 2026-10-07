import {
  createAgentChatController,
  type AgentChatController,
  type AemServerContext,
  type StartupGatedAgentChatController,
} from './agentChatController';
import type { FakeAgentService } from './agents/fakeAgentService';
import { type ActiveAemServer } from './browser/browserController';
import { type NavigationEpochTracker } from './browser/navigationEpoch';
import type { ChatJournal } from './chatJournal';
import type { Logger } from './logger';
import {
  type AgentService,
  type CurrentAemContext,
  type CurrentAemToolContext,
  type EnvironmentFacts,
  type IdGenerator,
  type ModelCatalogEntry,
  type ModelPreference,
  type ServerConfig,
  type SessionStreamState,
  type UserInputAnswer,
  type UserInputRequest,
  deriveCurrentPageContext,
  originsMatch,
  parseNavigationTarget,
  renderCurrentPageContextForModel,
  resolveEnvironmentRoots,
} from '../shared';

/**
 * The production composition root (`src/main/index.ts`) wires together every
 * component of the AEM-tool vertical slice - the bridge transport/broker
 * (`src/main/aem/**`), the SDK/fake `AgentService` adapters (`src/agent/**`),
 * and `agentChatController.ts` - but `index.ts` itself only runs inside
 * `app.whenReady()`, where nothing is independently callable by a test. This
 * module holds every piece of that wiring that has a decision worth testing
 * in isolation: which agent service to construct, how a `CurrentAemContext`/
 * `CurrentAemToolContext`/`AemServerContext` is derived from the browser
 * controller's live state, and how a request actually reaches the bridge
 * broker. `index.ts` only calls these functions inside `app.whenReady()`; it
 * adds no logic of its own on top of them.
 */

// ---------------------------------------------------------------------------
// Deriving "the current AEM server/document" for the tool pipeline
// ---------------------------------------------------------------------------

/**
 * Builds the `AgentChatControllerDeps.currentAemServerContext` provider from
 * `BrowserController.activeServer`. Returns a closure - not a snapshot - so
 * every call re-reads `getActiveServer()`: a server switch between one tool
 * call and the next must be visible on the very next call, never only from
 * whatever server was active when this function ran.
 */
export function createCurrentAemServerContext(
  getActiveServer: () => ActiveAemServer | undefined,
): () => AemServerContext | undefined {
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
 * same closure-not-snapshot rule as {@link createCurrentAemServerContext} -
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
  getActiveServer: () => ActiveAemServer | undefined,
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
        ? { contentRoots: facts.contentRoots, componentRoots: facts.componentRoots }
        : {}),
    });
    return context === undefined ? undefined : renderCurrentPageContextForModel(context);
  };
}

/**
 * Builds the "environment facts" provider the tool host and the page-context
 * block both read: the origin of the host the browser pane is on right now,
 * and that host's effective content/component roots.
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
): () => EnvironmentFacts | undefined {
  return () => {
    const documentUrl = getDocumentUrl();
    if (documentUrl === undefined) return undefined;
    const target = parseNavigationTarget(documentUrl);
    if (!target.ok) return undefined;
    const host = getHosts().find((candidate) => originsMatch(candidate.origin, target.origin));
    if (host === undefined) return undefined;
    const roots = resolveEnvironmentRoots(host.contentRoots, host.componentRoots);
    return {
      origin: target.origin,
      contentRoots: roots.contentRoots,
      componentRoots: roots.componentRoots,
    };
  };
}

/**
 * No server selected has to become a `CurrentAemContext` that makes
 * `classifyStaleness` (`toolContracts.ts`) fail *closed* for any request
 * already in flight, never one that happens to let a stray reply through.
 * `serverRevisionSchema` (`serverConfig.ts`) is `z.number().int().nonnegative()`,
 * so no real envelope can ever carry this sentinel - the comparison can only
 * ever disagree with it, which is exactly "stale_server_revision".
 */
const NO_ACTIVE_SERVER_REVISION_SENTINEL = -1;

/**
 * Builds the `BrokerDeps.currentContext` provider for `createAemBridgeBroker`.
 * Reads `getActiveServer()`/`navigationEpoch()` fresh on every call, for the
 * same reason as `createCurrentAemServerContext` above - the broker's own doc
 * comment requires this ("the live serverRevision + navigationEpoch, read
 * fresh at every decision point").
 */
export function createBridgeCurrentContext(
  getActiveServer: () => ActiveAemServer | undefined,
  navigationEpoch: () => number,
): () => CurrentAemContext {
  return () => ({
    serverRevision: getActiveServer()?.revision ?? NO_ACTIVE_SERVER_REVISION_SENTINEL,
    navigationEpoch: navigationEpoch(),
  });
}

/**
 * Resolves the one directory the bundled AEM skills may be loaded from.
 *
 * `toolPolicy.ts` only honours `bundledSkillDirectories` for *absolute*,
 * application-owned paths, so this must return an absolute path and must
 * derive it solely from the application's own install location - never from
 * settings, the user's home directory, the project directory, or anything an
 * AEM response could influence.
 *
 * Packaged builds get `resources/` copied next to the app by
 * electron-builder's `extraResources` (`from: resources`, `to: resources`),
 * which lands under `process.resourcesPath`. Unpackaged runs execute from
 * `out/main`, two levels below the repository root where `resources/` lives.
 */
export function resolveBundledSkillsDirectory(params: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly mainDir: string;
  readonly join: (...segments: readonly string[]) => string;
}): string {
  return params.isPackaged
    ? params.join(params.resourcesPath, 'resources', 'skills')
    : params.join(params.mainDir, '..', '..', 'resources', 'skills');
}

// ---------------------------------------------------------------------------
// Tying the knot: the tool executor needs the chat controller's context
// provider, but the chat controller is built from the agent service, which
// is built from the tool executor.
// ---------------------------------------------------------------------------

export interface LateBoundAemToolContext {
  /**
   * Passed to every tool executor (via `ToolHost.currentContext`). Throws if
   * called before `bind` - which would mean a tool call reached the
   * executor before the composition root finished wiring the chat
   * controller, a construction-order bug worth failing loudly on rather
   * than masking with a placeholder context.
   */
  readonly currentContext: () => CurrentAemToolContext;
  /** Supplies the real provider once the chat controller exists. Call exactly once. */
  readonly bind: (controller: Pick<AgentChatController, 'currentAemToolContext'>) => void;
}

export function createLateBoundAemToolContext(): LateBoundAemToolContext {
  let bound: Pick<AgentChatController, 'currentAemToolContext'> | undefined;
  return {
    currentContext: () => {
      if (bound === undefined) {
        throw new Error('Tool context requested before the chat controller was bound');
      }
      return bound.currentAemToolContext();
    },
    bind: (controller) => {
      bound = controller;
    },
  };
}

/**
 * The tool host's interactive-question capability, late-bound for the same
 * reason as {@link LateBoundAemToolContext}: the tool registry (and its host)
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

// ---------------------------------------------------------------------------
// Server-switch cancellation (Milestone A criterion 6)
// ---------------------------------------------------------------------------

/**
 * Subscribes to `navigationEpoch` and cancels the chat controller's in-flight
 * turn on every bump (document navigation, server switch, render-process-
 * gone, view-destroyed - see `NavigationEpochBumpReason`), so an AEM-context-
 * invalidating event cancels in-flight agent work the same way pressing Stop
 * does. Returns the unsubscribe function; the composition root calls it
 * alongside every other shutdown cleanup.
 *
 * `handleAemContextInvalidated()` already logs and swallows a `Result`-shaped
 * failure from `agentService.abort` internally (see its own doc comment) and
 * is documented never to throw for that case; the `.catch` here is
 * defense-in-depth against an `AgentService` implementation that violates its
 * own contract and rejects instead, so a bug in a *future* adapter cannot
 * turn into an unhandled promise rejection here.
 */
export function wireNavigationEpochCancellation(
  navigationEpoch: Pick<NavigationEpochTracker, 'subscribe'>,
  chatController: Pick<AgentChatController, 'handleAemContextInvalidated'>,
  logger: Logger,
): () => void {
  return navigationEpoch.subscribe(() => {
    chatController.handleAemContextInvalidated().catch(() => {
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
 * `globalThis` property name `tests/e2e/step07-agent-chat.spec.ts` reads via
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
  readonly currentAemServerContext: () => AemServerContext | undefined;
  readonly navigationEpoch: () => number;
  /** The model-facing "where the browser pane is" block prepended to each prompt. */
  readonly currentPageContext: () => string | undefined;
  /** Optional append-only chat journal (implementation-plan.md step 09). */
  readonly chatJournal?: ChatJournal;
  /** Cancels in-flight AEM bridge requests when a turn is cancelled. */
  readonly cancelAemRequests?: () => void;
  /**
   * Rewrites a prompt that begins with a bundled-skill reference into the
   * model-facing directive that loads that skill. Optional and passed through
   * verbatim to `createAgentChatController`; omitted means no rewrite.
   */
  readonly resolveSkillPrompt?: (prompt: string) => string;
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
    currentAemServerContext: deps.currentAemServerContext,
    navigationEpoch: deps.navigationEpoch,
    currentPageContext: deps.currentPageContext,
    ...(deps.chatJournal !== undefined ? { chatJournal: deps.chatJournal } : {}),
    ...(deps.cancelAemRequests !== undefined ? { cancelAemRequests: deps.cancelAemRequests } : {}),
    ...(deps.resolveSkillPrompt !== undefined
      ? { resolveSkillPrompt: deps.resolveSkillPrompt }
      : {}),
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
 * The chat states during which model selection is locked
 * (implementation-plan.md step 09: "disable changes during an active turn").
 *
 * `cancelling` is included alongside the three obviously-active states.
 * Cancellation is a request, not a completed fact - the SDK session is still
 * winding the turn down and has not yet returned to `idle` - so a `setModel`
 * accepted during it would race the very turn being stopped. Waiting for
 * `idle` costs the user a moment and removes the race entirely.
 *
 * `error` and `closed` are *not* locked: both mean no turn is running, and
 * locking them would strand a user whose turn failed because of the model
 * they picked, unable to pick a different one - the exact situation in which
 * changing the model is the fix.
 */
export const MODEL_SELECTION_LOCKED_STATES: ReadonlySet<SessionStreamState> = new Set([
  'sending',
  'streaming',
  'runningTool',
  'cancelling',
]);

/** Whether model selection must be refused/disabled in `state`. */
export function isModelSelectionLocked(state: SessionStreamState): boolean {
  return MODEL_SELECTION_LOCKED_STATES.has(state);
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
