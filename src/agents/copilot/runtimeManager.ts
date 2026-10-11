import type { AppSettings } from '../../shared';
import type { CopilotClient, ProxyEnvOverrides } from './copilotClient';
import { meta } from './meta';

/**
 * Owns the one Copilot runtime client the whole app talks to - both the
 * `agent:*` auth handlers (`ipc/agent.ts`) and the chat/model surface - and
 * recycles it when the settings that shape the runtime change.
 *
 * Before this existed there were two clients: one cached privately in
 * `ipc/agent.ts` for sign-in/out, one created in `index.ts` for chat and the
 * model catalogue. That is a known defect in its own right (opening Settings
 * could spawn a second `copilot-runtime.exe`; the measured residual is recorded
 * in `docs/backlog.md`, "Real-path Copilot runtime process count and quit
 * cleanup"),
 * and it also made the agents
 * surface's proxy selection impossible to honour honestly: the proxy is an
 * environment variable the child process is started with, so applying it
 * means stopping the old runtime and starting a new one, and *both* callers
 * have to be looking at the same client for that to mean anything. They now
 * both read it from here.
 *
 * Recycling is deliberately NOT a bespoke restart path. It reuses
 * `StartupGatedAgentChatController.replaceDelegate` (see its own doc
 * comment): the new runtime's controller is installed first and the previous
 * controller - and so the previous `AgentService` - is disposed as part of
 * that install, then the previous client process is stopped. Installing
 * before stopping means a listener never observes a missing delegate; the
 * two runtimes overlap for only the few seconds `client.start()` takes.
 *
 * Which settings changes matter is decided here, not by the caller: a model
 * or reasoning-effort change does not touch the runtime and must not cause a
 * recycle (that would restart the runtime for something it can be told at
 * prompt time - see `sdkAgentService.ts`'s `modelPreferences`), while a
 * change to the active provider or its proxy does. The comparison is on a
 * cheap descriptor string, so an unchanged write is a no-op rather than a
 * redundant restart.
 *
 * A stored personal-access token is resolved into the child's environment on
 * every install, exactly like the proxy. It is deliberately *not* part of the
 * descriptor: overwriting a token reuses the same `secretRef`, so the settings
 * document is unchanged and a descriptor comparison would miss it. A token
 * set/clear therefore calls {@link CopilotRuntimeManager.refresh}, which
 * recycles unconditionally - the same treatment sign-in/out gets, and for the
 * same reason (the running process resolved its credential once, at start).
 */

/** Descriptor used before any provider-bearing runtime has been installed, and after `stop()`. */
const NO_RUNTIME_DESCRIPTOR = '<none>';

/**
 * Everything a freshly-built client needs to be shaped correctly. Both fields
 * are credentials the child process resolves once, at start: the proxy it
 * tunnels through and the personal-access token it authenticates with. They
 * are resolved together, per install, so a recycle can never apply one and
 * forget the other.
 */
export interface RuntimeClientOptions {
  readonly proxy?: ProxyEnvOverrides;
  readonly githubToken?: string;
}

export interface CopilotRuntimeManagerDeps {
  /**
   * Whether a settings change may trigger a recycle. False on the fake-agent
   * path (`shouldUseFakeAgentService`): there is no child process to proxy
   * and `reconcile` must not throw away the fake's state (the E2E suite
   * drives it directly). The client object is still created and still backs
   * the `agent:*` auth handlers - only chat is faked.
   */
  readonly recycleOnSettingsChange: boolean;
  /**
   * Starts `client` (skipped when `undefined`, i.e. the fake path), builds
   * and initializes the `AgentService`, and installs its controller via
   * `gatedController.replaceDelegate`. In practice this is
   * `runtime.ts`'s installer, which builds the SDK-backed service and hands it
   * to `AgentHost.installService` - so the manager adds no second startup
   * ordering of its own.
   */
  readonly startRuntime: (client: CopilotClient | undefined) => Promise<void>;
  /** Stops a client that is no longer serving the app. Never throws. */
  readonly stopClient: (client: CopilotClient) => Promise<void>;
  /** Builds a client with the given runtime credentials, or none. */
  readonly createClient: (options: RuntimeClientOptions) => CopilotClient;
  /**
   * Resolves the active provider's configured proxy into environment
   * overrides, reading the entry's password from `secretStore`. Returns
   * `undefined` when no proxy is selected. A rejection here aborts the
   * recycle *before* the working runtime is touched.
   */
  readonly resolveProxyOverrides: (
    settings: AppSettings | undefined,
  ) => Promise<ProxyEnvOverrides | undefined>;
  /**
   * Resolves the active provider's stored personal-access token, reading its
   * plaintext from `secretStore`. `undefined` when none is stored, which
   * leaves the runtime to interactive sign-in. A rejection here aborts the
   * recycle, exactly like {@link resolveProxyOverrides}.
   */
  readonly resolveGithubToken: (settings: AppSettings | undefined) => Promise<string | undefined>;
}

export interface CopilotRuntimeManager {
  /**
   * The current client. Always defined once this manager exists: a
   * not-yet-started client is created up front so `agent:get-auth-status`
   * can lazily start one even if the chat runtime's background startup has
   * not run (or failed) - exactly the behaviour `ipc/agent.ts` used to
   * provide for itself.
   */
  getClient(): CopilotClient;
  /**
   * Resolves once the runtime's current install - the first `start` or the
   * most recent `reconcile`/`refresh` - has settled, so a caller that must
   * read through the *new* client can wait for it instead of observing a
   * not-yet-started one mid-recycle. Never rejects: a failed install is
   * reported through the client's own unstarted state (see `install`'s
   * `inFlight = run.catch(...)`), and the reader's own call then fails
   * honestly rather than the wait throwing.
   */
  whenReady(): Promise<void>;
  /** First startup. `settings` seeds which proxy the runtime is started with. */
  start(settings: AppSettings | undefined): Promise<void>;
  /** Recycles the runtime if - and only if - `settings` changed something that shapes it. */
  reconcile(settings: AppSettings): Promise<void>;
  /**
   * Unconditionally recycles the runtime - used after a credential change
   * (sign-in/out, or a token being set/cleared), where the *running*
   * process's cached credential resolution is stale regardless of settings
   * (see `ipc/agent.ts`'s former `resetClient`). Not gated on
   * {@link CopilotRuntimeManagerDeps.recycleOnSettingsChange}: auth is real
   * even on the fake-agent path, so its client must be recycled there too.
   *
   * `settings` overrides the document the recycle is resolved against. The
   * auth path omits it, recycling from the settings the runtime was last
   * started with; a token change passes a freshly-reloaded document, because
   * the *first* token set mints the `secretRef` into `settings.json` and the
   * captured document would still be the token-less one.
   */
  refresh(settings?: AppSettings): Promise<void>;
  /** Stops the runtime without starting a replacement (window teardown). */
  stop(): Promise<void>;
}

export function createCopilotRuntimeManager(
  deps: CopilotRuntimeManagerDeps,
): CopilotRuntimeManager {
  // Created eagerly and unstarted: cheap and synchronous (see
  // `createHardenedCopilotClient`'s own doc comment), and it makes
  // `getClient()` non-nullable for the auth handlers, which may run before
  // `start()` has resolved its proxy. Carries no credentials: resolving a
  // stored proxy/token is asynchronous, and this client exists only to answer
  // auth before the first real install completes.
  let client: CopilotClient = deps.createClient({});
  let descriptor = NO_RUNTIME_DESCRIPTOR;
  let currentSettings: AppSettings | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  function describe(settings: AppSettings | undefined): string {
    if (settings === undefined) return NO_RUNTIME_DESCRIPTOR;
    // Which agent is configured is the host's concern (it recycles across agents);
    // this runtime only cares about the proxy that shapes its own child process.
    return `${meta.id}|${settings.agents[meta.id]?.proxy ?? ''}`;
  }

  function install(settings: AppSettings | undefined): Promise<void> {
    // Serialized: a login recycle and a settings recycle racing would
    // otherwise interleave two `replaceDelegate` calls and leave whichever
    // finished last owning the public surface, with one client leaked
    // running. A failed install rejects *this* caller but leaves the chain
    // usable, so one unresolvable proxy cannot wedge every later recycle.
    const run = inFlight.then(async () => {
      const proxy = await deps.resolveProxyOverrides(settings);
      const githubToken = await deps.resolveGithubToken(settings);
      const next = deps.createClient({
        ...(proxy !== undefined ? { proxy } : {}),
        ...(githubToken !== undefined ? { githubToken } : {}),
      });
      const previous = client;
      client = next;
      currentSettings = settings;
      descriptor = describe(settings);
      await deps.startRuntime(next);
      await deps.stopClient(previous);
    });
    inFlight = run.catch(() => undefined);
    return run;
  }

  return {
    getClient: () => client,

    whenReady: () => inFlight,

    start: (settings) => install(settings),

    reconcile: (settings) => {
      if (!deps.recycleOnSettingsChange) return Promise.resolve();
      if (describe(settings) === descriptor) return Promise.resolve();
      return install(settings);
    },

    refresh: (settings) => install(settings ?? currentSettings),

    stop: () => {
      const previous = client;
      descriptor = NO_RUNTIME_DESCRIPTOR;
      currentSettings = undefined;
      return deps.stopClient(previous);
    },
  };
}
