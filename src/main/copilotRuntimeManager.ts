import type { CopilotClient, ProxyEnvOverrides } from '../agent';
import { activeAgentId } from './settingsStore';
import type { AppSettings } from '../shared';

/**
 * Owns the one Copilot runtime client the whole app talks to - both the
 * `agent:*` auth handlers (`ipc/agent.ts`) and the chat/model surface - and
 * recycles it when the settings that shape the runtime change.
 *
 * Before this existed there were two clients: one cached privately in
 * `ipc/agent.ts` for sign-in/out, one created in `index.ts` for chat and the
 * model catalogue. That is a known defect in its own right (opening Settings
 * could spawn a second `copilot-runtime.exe`; see
 * `docs/handoff-two-copilot-clients.md`), and it also made the agents
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
 */

/** Descriptor used before any provider-bearing runtime has been installed, and after `stop()`. */
const NO_RUNTIME_DESCRIPTOR = '<none>';

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
   * `startAgentServiceInBackground` from `agentComposition.ts`, bound to the
   * composition root's executors and skill directory - so the manager adds
   * no second startup ordering of its own.
   */
  readonly startRuntime: (client: CopilotClient | undefined) => Promise<void>;
  /** Stops a client that is no longer serving the app. Never throws. */
  readonly stopClient: (client: CopilotClient) => Promise<void>;
  /** Builds a client with the given proxy environment, or none when `undefined`. */
  readonly createClient: (proxy: ProxyEnvOverrides | undefined) => CopilotClient;
  /**
   * Resolves the active provider's configured proxy into environment
   * overrides, reading the entry's password from `secretStore`. Returns
   * `undefined` when no proxy is selected. A rejection here aborts the
   * recycle *before* the working runtime is touched.
   */
  readonly resolveProxyOverrides: (
    settings: AppSettings | undefined,
  ) => Promise<ProxyEnvOverrides | undefined>;
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
  /** First startup. `settings` seeds which proxy the runtime is started with. */
  start(settings: AppSettings | undefined): Promise<void>;
  /** Recycles the runtime if - and only if - `settings` changed something that shapes it. */
  reconcile(settings: AppSettings): Promise<void>;
  /**
   * Unconditionally recycles the runtime - used after a sign-in/out, where
   * the *running* process's cached credential resolution is stale regardless
   * of settings (see `ipc/agent.ts`'s former `resetClient`). Not gated on
   * {@link CopilotRuntimeManagerDeps.recycleOnSettingsChange}: auth is real
   * even on the fake-agent path, so its client must be recycled there too.
   */
  refresh(): Promise<void>;
  /** Stops the runtime without starting a replacement (window teardown). */
  stop(): Promise<void>;
}

export function createCopilotRuntimeManager(
  deps: CopilotRuntimeManagerDeps,
): CopilotRuntimeManager {
  // Created eagerly and unstarted: cheap and synchronous (see
  // `createHardenedCopilotClient`'s own doc comment), and it makes
  // `getClient()` non-nullable for the auth handlers, which may run before
  // `start()` has resolved its proxy.
  let client: CopilotClient = deps.createClient(undefined);
  let descriptor = NO_RUNTIME_DESCRIPTOR;
  let currentSettings: AppSettings | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  function describe(settings: AppSettings | undefined): string {
    if (settings === undefined) return NO_RUNTIME_DESCRIPTOR;
    const agentId = activeAgentId(settings);
    return `${agentId}|${settings.agents[agentId]?.proxy ?? ''}`;
  }

  function install(settings: AppSettings | undefined): Promise<void> {
    // Serialized: a login recycle and a settings recycle racing would
    // otherwise interleave two `replaceDelegate` calls and leave whichever
    // finished last owning the public surface, with one client leaked
    // running. A failed install rejects *this* caller but leaves the chain
    // usable, so one unresolvable proxy cannot wedge every later recycle.
    const run = inFlight.then(async () => {
      const proxy = await deps.resolveProxyOverrides(settings);
      const next = deps.createClient(proxy);
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

    start: (settings) => install(settings),

    reconcile: (settings) => {
      if (!deps.recycleOnSettingsChange) return Promise.resolve();
      if (describe(settings) === descriptor) return Promise.resolve();
      return install(settings);
    },

    refresh: () => install(currentSettings),

    stop: () => {
      const previous = client;
      descriptor = NO_RUNTIME_DESCRIPTOR;
      currentSettings = undefined;
      return deps.stopClient(previous);
    },
  };
}
