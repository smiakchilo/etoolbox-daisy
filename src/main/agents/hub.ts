import {
  type AgentDefinition,
  type AgentHost,
  type AgentId,
  type AgentModule,
  type AgentRuntime,
  type AgentService,
  type AppSettings,
  type AuthPresence,
  type AuthStatus,
  type LoginOutcome,
  type LogoutResult,
  type ModelCatalogResult,
  err,
  resolveConfiguredAgentId,
} from '../../shared';
import { createFakeRuntime } from './fakeRuntime';

/**
 * The one object the rest of the main process talks to about agents. It owns
 * one {@link AgentRuntime} per registered agent, routes the agent-scoped auth
 * calls to the right one, and keeps exactly one of them - the configured
 * agent - installed as the live chat surface.
 *
 * It is agent-neutral: it never imports an agent folder. The registry hands it
 * the modules that loaded; an agent that failed to load, was disabled, or was
 * deleted simply has no runtime here, and every call for it degrades to a
 * plain "no such agent" answer instead of throwing.
 */
export interface AgentHub {
  start(settings: AppSettings | undefined): Promise<void>;
  /** Applies changed settings: switches agent, or lets the agent decide whether to recycle. */
  reconcile(settings: AppSettings): Promise<void>;
  /** Recycles the configured agent's runtime (after a credential change). */
  refresh(settings?: AppSettings): Promise<void>;
  stop(): Promise<void>;
  whenReady(): Promise<void>;
  /** The configured agent's model catalogue; an error result when none is available. */
  loadModelCatalog(): Promise<ModelCatalogResult>;
  getAuthStatus(agentId: AgentId): Promise<AuthStatus>;
  /**
   * Cheap, non-starting sign-in presence for `agentId`, used to gate the
   * Settings "Set active" control without starting a runtime. An unknown
   * agent, or one that cannot probe cheaply, answers `{ present: false }`.
   */
  getAuthPresence(agentId: AgentId): Promise<AuthPresence>;
  login(agentId: AgentId, settings: AppSettings | undefined): Promise<LoginOutcome>;
  cancelLogin(agentId: AgentId): void;
  logout(agentId: AgentId): Promise<LogoutResult>;
}

export interface AgentHubDeps {
  /** The enabled agents (from the meta catalogue). */
  readonly definitions: readonly AgentDefinition[];
  /** The modules that loaded successfully; ignored when `useFake` is true. */
  readonly modules: readonly AgentModule[];
  /** Stand a fake runtime in for every enabled agent; no agent module is used. */
  readonly useFake: boolean;
  readonly host: Omit<AgentHost, 'installService'>;
  /** Installs `service` as the live chat surface (see `installAgentService`). */
  readonly installService: (service: AgentService) => Promise<void>;
  /** Puts the chat surface into its "no agent available" state. */
  readonly markUnavailable: () => Promise<void>;
  /** Reports a runtime that could not be constructed or started; never throws. */
  readonly onRuntimeFailure?: (agentId: AgentId, error: unknown) => void;
}

const NO_SUCH_AGENT = 'No such agent';

export function createAgentHub(deps: AgentHubDeps): AgentHub {
  const runtimes = new Map<AgentId, AgentRuntime>();
  let activeId: AgentId | undefined;
  let lastSettings: AppSettings | undefined;

  // A non-active agent (a sign-in, a token refresh) must never replace the
  // live chat surface, so each agent's install is gated on being the active one.
  const hostFor = (agentId: AgentId): AgentHost => ({
    ...deps.host,
    installService: async (service) => {
      if (agentId === activeId) await deps.installService(service);
    },
  });

  const report = (agentId: AgentId, error: unknown): void =>
    deps.onRuntimeFailure?.(agentId, error);

  const buildRuntime = (definition: AgentDefinition): AgentRuntime | undefined => {
    const host = hostFor(definition.id);
    try {
      if (deps.useFake) return createFakeRuntime(host);
      const module = deps.modules.find((m) => m.id === definition.id);
      return module?.createRuntime(host);
    } catch (error) {
      report(definition.id, error);
      return undefined;
    }
  };

  for (const definition of deps.definitions) {
    const runtime = buildRuntime(definition);
    if (runtime !== undefined) runtimes.set(definition.id, runtime);
  }

  const configuredId = (settings: AppSettings | undefined): AgentId | undefined =>
    resolveConfiguredAgentId(settings?.agents ?? {}, deps.definitions);

  const active = (): AgentRuntime | undefined =>
    activeId === undefined ? undefined : runtimes.get(activeId);

  // Every runtime call the hub makes on the caller's behalf is fenced: a
  // broken agent is reported and treated as unavailable, never propagated.
  const guarded = async (
    agentId: AgentId,
    action: (runtime: AgentRuntime) => Promise<void>,
  ): Promise<void> => {
    const runtime = runtimes.get(agentId);
    if (runtime === undefined) return;
    try {
      await action(runtime);
    } catch (error) {
      report(agentId, error);
      if (agentId === activeId) await deps.markUnavailable();
    }
  };

  const startActive = async (settings: AppSettings | undefined): Promise<void> => {
    if (activeId === undefined || !runtimes.has(activeId)) {
      await deps.markUnavailable();
      return;
    }
    await guarded(activeId, (runtime) => runtime.start(settings));
  };

  return {
    async start(settings) {
      lastSettings = settings;
      activeId = configuredId(settings);
      await startActive(settings);
    },

    async reconcile(settings) {
      lastSettings = settings;
      const next = configuredId(settings);
      if (next === activeId) {
        if (activeId !== undefined) {
          await guarded(activeId, (runtime) => runtime.reconcile(settings));
        }
        return;
      }
      const previous = activeId;
      activeId = next;
      if (previous !== undefined) await guarded(previous, (runtime) => runtime.stop());
      await startActive(settings);
    },

    async refresh(settings) {
      if (settings !== undefined) lastSettings = settings;
      if (activeId === undefined) return;
      await guarded(activeId, (runtime) => runtime.refresh(settings ?? lastSettings));
    },

    async stop() {
      await Promise.all([...runtimes.keys()].map((id) => guarded(id, (runtime) => runtime.stop())));
    },

    async whenReady() {
      await active()?.whenReady();
    },

    async loadModelCatalog() {
      const runtime = active();
      if (runtime === undefined) return err({ message: 'No agent is available' });
      try {
        return await runtime.loadModelCatalog();
      } catch {
        return err({ message: 'The agent could not list its models' });
      }
    },

    async getAuthStatus(agentId) {
      const runtime = runtimes.get(agentId);
      if (runtime === undefined) {
        return { apiVersion: 1, isAuthenticated: false, statusMessage: NO_SUCH_AGENT };
      }
      try {
        return await runtime.getAuthStatus();
      } catch (error) {
        report(agentId, error);
        return {
          apiVersion: 1,
          isAuthenticated: false,
          statusMessage: 'The agent is not responding',
        };
      }
    },

    async getAuthPresence(agentId) {
      const runtime = runtimes.get(agentId);
      if (runtime?.getAuthPresence === undefined) return { present: false };
      try {
        return await runtime.getAuthPresence();
      } catch (error) {
        report(agentId, error);
        return { present: false };
      }
    },

    async login(agentId, settings) {
      const runtime = runtimes.get(agentId);
      if (runtime === undefined) return { status: 'failed', message: NO_SUCH_AGENT };
      if (runtime.login === undefined) {
        return { status: 'failed', message: 'This agent does not support signing in' };
      }
      try {
        return await runtime.login(settings ?? lastSettings);
      } catch (error) {
        report(agentId, error);
        return { status: 'failed', message: 'Sign-in could not be started' };
      }
    },

    cancelLogin(agentId) {
      try {
        runtimes.get(agentId)?.cancelLogin?.();
      } catch (error) {
        report(agentId, error);
      }
    },

    async logout(agentId) {
      const runtime = runtimes.get(agentId);
      if (runtime?.logout === undefined) {
        return { apiVersion: 1, warning: NO_SUCH_AGENT };
      }
      try {
        return await runtime.logout();
      } catch (error) {
        report(agentId, error);
        return { apiVersion: 1, warning: 'Sign-out could not be completed' };
      }
    },
  };
}
