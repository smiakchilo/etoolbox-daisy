import { executeAemGetJson, type AemGetJsonRequest } from '../shared';
import { executeAemQuery, type AemQueryRequest } from '../shared';
import { deriveCurrentPageContext, renderCurrentPageContextForModel } from '../shared';
import type { AemBridgeBroker } from './aem/bridgeBroker';
import type { ActiveAemServer } from './browser/browserController';
import type { NavigationEpochTracker } from './browser/navigationEpoch';
import {
  createAgentChatController,
  type AgentChatController,
  type AemServerContext,
  type StartupGatedAgentChatController,
} from './agentChatController';
import type { ChatJournal } from './chatJournal';
import type { Logger } from './logger';
import type { AgentService } from '../agent/agentService';
import type { CurrentAemToolContext } from '../shared';
import type { CopilotClient } from '../agent';
import type { FakeAgentService } from '../agent/fakeAgentService';
import type { ModelPreference } from '../agent/sdkAgentService';
import type { ModelCatalogEntry } from '../shared';
import type { IdGenerator } from '../shared';
import type { CurrentAemContext } from '../shared';
import type { SessionStreamState } from '../shared';
import type { ToolResult } from '../shared';

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
): () => string | undefined {
  return () => {
    const server = getActiveServer();
    if (server === undefined) return undefined;
    const context = deriveCurrentPageContext({
      documentUrl: getDocumentUrl(),
      activeOrigin: server.origin,
    });
    return context === undefined ? undefined : renderCurrentPageContextForModel(context);
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

// ---------------------------------------------------------------------------
// Closing the envelope-passing gap between aemTool.ts and bridgeBroker.ts
// ---------------------------------------------------------------------------

/**
 * Everything `createBrokeredExecute`'s returned function needs besides the
 * `origin` `createAemGetJsonExecutor` already binds for every runtime deps
 * shape. Inferred as this module's own `TRuntimeDeps` for
 * `AemGetJsonExecutorConfig` - see that generic's own doc comment on why it
 * is never given a concrete shape by `aemTool.ts` itself.
 */
export interface BrokeredExecuteRuntimeDeps {
  /** Wall-clock time stamped onto a successful result (`AemGetJsonDeps.now`). */
  readonly now: () => number;
}

/**
 * Bridges `aemTool.ts`'s `AemGetJsonExecutorConfig.execute` shape - called
 * once per tool call as `execute(envelope, { origin, ...runtimeDeps })`,
 * where `runtimeDeps` is a single object built once at construction and
 * reused for every call - onto `AemGetJsonDeps.fetchThroughBridge`, whose
 * signature is `(url) => Promise<BrokerOutcome>` with no envelope parameter
 * at all, while `AemBridgeBroker.request(envelope, url)` needs one.
 *
 * The real, unmodified `executeAemGetJson` is still what runs the actual
 * request/response logic; this function never reimplements any of it. It
 * only closes the gap by building `fetchThroughBridge` fresh *inside* the
 * per-call `execute` invocation, where the current call's own `envelope` is
 * in scope - rather than once at construction time, where it is not.
 *
 * `BrokeredExecute` (the return type below) matches
 * `AemGetJsonExecutorConfig<BrokeredExecuteRuntimeDeps>["execute"]`
 * structurally (verified where it is actually passed to
 * `createAemGetJsonExecutor` in `index.ts`), but is not written as an
 * explicit instantiation of that generic - `TRuntimeDeps extends
 * Record<string, unknown>`, and TypeScript's generic-constraint check
 * rejects a plain named interface for that constraint even though the same
 * interface is perfectly assignable structurally wherever it is actually
 * used as a value (as `runtimeDeps` is, in every real call site).
 */
export type BrokeredExecute = (
  envelope: AemGetJsonRequest,
  deps: { readonly origin: string } & BrokeredExecuteRuntimeDeps,
) => Promise<ToolResult>;

export function createBrokeredExecute(broker: Pick<AemBridgeBroker, 'request'>): BrokeredExecute {
  return (envelope, deps) =>
    executeAemGetJson(envelope, {
      origin: deps.origin,
      now: deps.now,
      fetchThroughBridge: (url) => broker.request(envelope, url),
    });
}

/**
 * The `aem_query` counterpart of {@link BrokeredExecute}. Separate rather than
 * generic because the two envelope types are distinct members of a
 * discriminated union: one function taking `AemGetJsonRequest | AemQueryRequest`
 * could not hand either one to the right `execute*` without a cast.
 */
export type BrokeredQueryExecute = (
  envelope: AemQueryRequest,
  deps: { readonly origin: string } & BrokeredExecuteRuntimeDeps,
) => Promise<ToolResult>;

export function createBrokeredQueryExecute(
  broker: Pick<AemBridgeBroker, 'request'>,
): BrokeredQueryExecute {
  return (envelope, deps) =>
    executeAemQuery(envelope, {
      origin: deps.origin,
      now: deps.now,
      fetchThroughBridge: (url) => broker.request(envelope, url),
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
   * Passed to `createAemGetJsonExecutor` as `currentContext`. Throws if
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
        throw new Error(
          'aem_get_json tool context requested before the chat controller was bound.',
        );
      }
      return bound.currentAemToolContext();
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
// Fake-vs-real AgentService selection
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
 * `index.ts`'s `createFakeService` factory passed to `selectAgentService`
 * below - which `selectAgentService`'s own doc comment guarantees is "only
 * called when `shouldUseFakeAgentService` is true". `isPackaged` makes that
 * false unconditionally in a packaged build (see `shouldUseFakeAgentService`
 * above), so this global can never exist there, regardless of environment.
 */
export function exposeFakeAgentServiceForTests(fakeService: FakeAgentService): void {
  (globalThis as Record<string, unknown>)[TEST_FAKE_AGENT_SERVICE_GLOBAL_KEY] = fakeService;
}

export interface SelectAgentServiceOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isPackaged: boolean;
  readonly logger: Logger;
  /** Builds the deterministic fake. Only called when `shouldUseFakeAgentService` is true. */
  readonly createFakeService: () => AgentService;
  /** Builds the real SDK-backed adapter. Only called when `shouldUseFakeAgentService` is false. */
  readonly createRealService: () => AgentService;
}

/**
 * Selects and constructs the `AgentService` the rest of the composition root
 * wires up. A plain decision-plus-factory-call function, deliberately
 * synchronous: any async work a real construction needs (starting the SDK
 * client process, `agentService.initialize()`) is the composition root's own
 * job, ordered around this call - not this function's.
 */
export function selectAgentService(options: SelectAgentServiceOptions): AgentService {
  if (shouldUseFakeAgentService(options.env, options.isPackaged)) {
    // "Log clearly when the fake is selected - a silent swap would be very
    // confusing to debug."
    options.logger.warn('AGENT_SERVICE_FAKE_SELECTED');
    return options.createFakeService();
  }
  return options.createRealService();
}

// ---------------------------------------------------------------------------
// Non-blocking Copilot runtime startup
// ---------------------------------------------------------------------------

/**
 * Everything `startAgentServiceInBackground` needs to take the real (or
 * fake) `AgentService` from "not started" to "an `AgentChatController` the
 * rest of the app can use", entirely off the critical path that gets the
 * window visible and interactive.
 */
export interface StartAgentServiceInBackgroundDeps {
  /**
   * The real path's not-yet-started SDK client, or `undefined` on the fake
   * path (mirrors `index.ts`'s own `useFakeAgentService ? undefined :
   * createHardenedCopilotClient()`). `Pick<CopilotClient, "start">` rather
   * than the full type: this module needs nothing else from it, and a
   * narrower dependency is easier to fake in tests.
   */
  readonly copilotClient: Pick<CopilotClient, 'start'> | undefined;
  /**
   * Builds the `AgentService` - i.e. `selectAgentService(...)` - deferred
   * until *after* `copilotClient.start()` resolves. Must not be called
   * before that resolves: the real adapter's `authSource`/`toolHandlers`
   * assume a started client (see `index.ts`'s own comment on why
   * `client.start()` must run first).
   */
  readonly buildAgentService: () => AgentService;
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
 * Runs the slow part of standing up the agent chat surface -
 * `copilotClient.start()` and `agentService.initialize()`, seconds on the
 * real path - and, once both succeed, builds the real `AgentChatController`
 * and hands it to `deps.gatedController.replaceDelegate`. The composition root
 * (`index.ts`) calls this without awaiting it (`void
 * startAgentServiceInBackground(...).catch(...)`), so none of this can ever
 * delay registering any other IPC handler or the window becoming
 * interactive - that is the entire point of this function existing
 * separately from `index.ts`'s synchronous wiring.
 *
 * Deliberately returns the rejection to its caller instead of swallowing it:
 * a failure here (Copilot CLI missing, corrupt install, `initialize()`
 * itself rejecting) must not leave `gatedController` silently stuck
 * answering `serviceState: "starting"` forever with no trace in the logs -
 * see `index.ts`'s own `.catch()` on this call.
 */
export async function startAgentServiceInBackground(
  deps: StartAgentServiceInBackgroundDeps,
): Promise<void> {
  if (deps.copilotClient) {
    await deps.copilotClient.start();
  }
  const agentService = deps.buildAgentService();
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
 * Registers everything that does not depend on the Copilot runtime, then
 * kicks off `startAgentService` (in practice, `startAgentServiceInBackground`
 * above) without ever awaiting it - so the agent runtime's own startup
 * latency can never delay, gate, or skip `registerNonAgentHandlers`, no
 * matter what is added to either side later. This is the one place that
 * encodes "startup order must reflect real dependencies, not the order
 * features were added" as code a test can hold onto, rather than merely as
 * a comment in `index.ts`.
 *
 * A rejection from `startAgentService()` is always routed to
 * `onAgentServiceStartupFailed` - never left unhandled, never silently
 * dropped. `index.ts` wires that parameter to log loudly through the
 * existing `logger`, so a partially-wired app (Copilot CLI missing, corrupt
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
 * The Copilot runtime is never started under the fake, so `listModels()` has
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
