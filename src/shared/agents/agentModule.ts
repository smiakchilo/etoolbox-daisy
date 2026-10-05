import type { AuthPresence, AuthStatus, LoginOutcome, LogoutResult } from '../agent-auth';
import type { AgentDefinition, AgentId, AppSettings, ModelCatalogEntry } from '../contracts';
import type { Result } from '../result';
import type { AemToolExecutor, ToolDescriptor } from '../tools';
import type { AgentService } from './agentService';

/**
 * The agent plugin contract. An agent is one folder, `src/agents/<name>/`,
 * holding two entry points and everything the provider needs that nothing
 * else does:
 *
 *  - `meta.ts` exports {@link AgentMeta} as `meta`. It is SDK-free and Node-free
 *    so the renderer can read it too (to list the agent in Settings). It is
 *    loaded eagerly, by glob, in both processes.
 *  - `agent.ts` exports {@link AgentModule} as `agent`. It is the only file that
 *    may pull in the provider's SDK, and the main-process registry loads it
 *    lazily and in isolation, so a module that throws on import disables that
 *    one agent and nothing else.
 *
 * Nothing else in the application names an agent. Deleting the folder removes
 * the provider; setting `disabled: true` in `meta.ts` turns it off without
 * deleting it.
 */

/** What the renderer and the settings layer need to know about an agent. */
export interface AgentMeta extends AgentDefinition {
  /**
   * Turns the agent off without deleting it: a disabled agent is still
   * type-checked, but its `agent.ts` is never loaded, it is not listed in
   * Settings, and it can never be selected.
   */
  readonly disabled?: boolean;
}

/** A user's model / reasoning-effort defaults; `model: null` means "no preference". */
export interface ModelPreference {
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

/**
 * The connection details the host resolves for an agent from its settings node
 * and the secret store. Only the host reads `secretStore`, so an agent never
 * sees a credential store - just the values it must start its runtime with.
 */
export interface AgentConnection {
  readonly proxy?: { readonly httpsProxy: string; readonly httpProxy: string };
  /** A stored personal access token, when one is set for the agent. */
  readonly accessToken?: string;
}

/** The tool surface every agent session is given; an agent maps it to its SDK. */
export interface AgentToolkit {
  /** Source-qualified allowlist entries of the enabled tools (`custom:<name>`). */
  readonly allowlistEntries: readonly string[];
  /** The composed session instructions (shared framing plus each tool's fragment). */
  readonly instructions: string;
  readonly toolHandlers: Readonly<Record<string, AemToolExecutor>>;
  readonly toolDescriptors: readonly ToolDescriptor[];
  /** The application's own bundled skill directories. */
  readonly bundledSkillDirectories: readonly string[];
}

/**
 * What an agent may ask of the application at run time. Deliberately small: an
 * agent cannot reach the window, the settings store, the secret store, or
 * another agent.
 */
export interface AgentHost {
  readonly isPackaged: boolean;
  /** Resolves the proxy and token for `agentId` from `settings` (`undefined` before settings load). */
  readonly resolveConnection: (
    agentId: AgentId,
    settings: AppSettings | undefined,
  ) => Promise<AgentConnection>;
  /**
   * Initializes `service`, wraps it in the chat controller and installs it as
   * the live chat surface, replacing (and disposing) the previous one.
   */
  readonly installService: (service: AgentService) => Promise<void>;
  /** Read at service-build time, after the tool registry exists. */
  readonly toolkit: () => AgentToolkit;
  /** Read fresh on every use, so a Settings change reaches an open conversation. */
  readonly modelPreferences: () => ModelPreference;
}

export type ModelCatalogResult = Result<readonly ModelCatalogEntry[], { readonly message: string }>;

/**
 * One agent's live runtime. The host holds exactly one per registered agent
 * and only ever talks to the configured one. Every method must be safe to call
 * whatever state the runtime is in; none may throw synchronously.
 */
export interface AgentRuntime {
  /** First startup; builds and installs the agent's {@link AgentService}. */
  start(settings: AppSettings | undefined): Promise<void>;
  /** Recycles the runtime if - and only if - `settings` changed something that shapes it. */
  reconcile(settings: AppSettings): Promise<void>;
  /** Unconditionally recycles the runtime (after a credential change). */
  refresh(settings?: AppSettings): Promise<void>;
  /** Stops the runtime without replacing it (window teardown). */
  stop(): Promise<void>;
  /** Resolves once the current install has settled; never rejects. */
  whenReady(): Promise<void>;
  getAuthStatus(): Promise<AuthStatus>;
  /**
   * A cheap, non-starting presence probe (`{ present }`) used to gate the
   * Settings "Set active" control for a provider that is not active, without
   * starting its runtime. Optional: an agent that cannot answer cheaply omits
   * it, and the host falls back to `{ present: false }` - the defended state
   * for a control that must not claim a provider can serve when it cannot.
   * Must never start the runtime and never reject.
   */
  readonly getAuthPresence?: () => Promise<AuthPresence>;
  /** Absent for an agent that needs no sign-in (`requiresAuth: false`). */
  readonly login?: (settings: AppSettings | undefined) => Promise<LoginOutcome>;
  readonly cancelLogin?: () => void;
  readonly logout?: () => Promise<LogoutResult>;
  loadModelCatalog(): Promise<ModelCatalogResult>;
}

export interface AgentModule {
  readonly id: AgentId;
  readonly createRuntime: (host: AgentHost) => AgentRuntime;
}
