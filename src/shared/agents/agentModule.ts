import type { AuthPresence, AuthStatus, LoginOutcome, LogoutResult } from '../agent-auth';
import type { AgentDefinition, AgentId, AppSettings, ModelCatalogEntry } from '../contracts';
import type { Result } from '../result';
import type { AgentService } from './agentService';
import type { OneShotCall } from './oneShot';
import type { ToolExecutor, ToolDescriptor } from '../tools';

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

/**
 * The WHATWG `fetch` an agent uses when it makes its own HTTP calls
 * in-process (rather than spawning a child process that reads
 * `HTTPS_PROXY`). The input is spelled `string | URL | Request` rather than
 * `RequestInfo | URL` on purpose: `RequestInfo` is a DOM-only alias that does
 * not resolve in the Node-typed programs that also compile this file (agents
 * and main), so naming it would make this type `any` there.
 */
export type AgentFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The tool surface every agent session is given; an agent maps it to its SDK. */
export interface AgentToolkit {
  /** Source-qualified allowlist entries of the enabled tools (`custom:<name>`). */
  readonly allowlistEntries: readonly string[];
  /** The composed session instructions (shared framing plus each tool's fragment). */
  readonly instructions: string;
  readonly toolHandlers: Readonly<Record<string, ToolExecutor>>;
  readonly toolDescriptors: readonly ToolDescriptor[];
}

/**
 * What an agent may ask of the application at run time. Deliberately small: an
 * agent cannot reach the window, the settings store, the secret store, or
 * another agent.
 */
export interface AgentHost {
  readonly isPackaged: boolean;
  /**
   * An absolute directory this agent owns for its runtime state (sessions, its
   * account config). Application-owned and technical - kept outside the
   * user-visible data folder - and private to this agent: no other agent is
   * handed the same one. The host creates the parent, not this directory; an
   * agent creates it on first use if its SDK does not.
   */
  readonly stateDirectory: string;
  /**
   * Resolves the proxy and token for `agentId` from `settings` (`undefined` before settings load).
   */
  readonly resolveConnection: (
    agentId: AgentId,
    settings: AppSettings | undefined,
  ) => Promise<AgentConnection>;
  /**
   * Wraps an already-resolved {@link AgentConnection} in a `fetch` that routes
   * through its proxy - or the direct connection when no proxy is selected.
   * The host owns the proxy transport (`undici`'s `ProxyAgent` in main), so an
   * in-process agent makes its HTTP calls through this instead of importing a
   * proxy library itself. A child-process agent cannot use it and instead
   * reads the proxy URL from {@link AgentConnection.proxy} for its environment.
   *
   * Synchronous and side-effect-free: no proxy means the global `fetch`
   * unchanged, and the same connection always yields an equivalent fetcher.
   */
  readonly createProxyFetch: (connection: AgentConnection) => AgentFetch;
  /**
   * Initializes `service`, wraps it in the chat controller and installs it as
   * the live chat surface, replacing (and disposing) the previous one.
   */
  readonly installService: (service: AgentService) => Promise<void>;
  /**
   * Read at service-build time, after the tool registry exists.
   */
  readonly toolkit: () => AgentToolkit;
  /** Read fresh on every use, so a Settings change reaches an open conversation. */
  readonly modelPreferences: () => ModelPreference;
  /**
   * Optional: a short progress note for the sign-in surface while it is
   * preparing something (finding or downloading the CLI). The application
   * pushes it to the Settings Agents tab; it is never journaled.
   */
  readonly reportAuthProgress?: (agentId: AgentId, text: string) => void;
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
  /**
   * The one routine behind every secondary agentic turn (see `oneShot.ts`): a
   * stateless model call a tool makes on the chat's behalf - the semantic
   * search's verdicts today, other tools' later. It is not a chat turn: no
   * conversation history, no tools, no skills, no AgentEvents, and it must never
   * touch the installed `AgentService`'s session. Implemented on a fresh,
   * tools-disabled session (Copilot) or a fresh conversation state (OpenRouter),
   * with the active model preference, proxy and the caller's abort signal. It
   * returns the reply text; what a tool asks and how it parses the reply is the
   * tool's business, in `src/shared/tools/core/`.
   *
   * Optional: an agent that cannot make such a call leaves it absent; a tool
   * that needs it reports the capability as unavailable.
   *
   * **Every model call it makes must be reported to `reportUsage`** (a failed,
   * cancelled or retried attempt included, since it spent tokens too): these
   * calls are part of the chat's gross usage, which the footer gauge and the
   * usage panel show, but - being no chat turn - they emit no AgentEvents of
   * their own. Build each body with `buildModelUsage`.
   * `tests/support/agentOneShotConformance.ts` holds an agent that defines
   * `complete` to this.
   */
  readonly complete?: OneShotCall; /** Absent for an agent that needs no sign-in (`requiresAuth: false`). */
  readonly login?: (settings: AppSettings | undefined) => Promise<LoginOutcome>;
  readonly cancelLogin?: () => void;
  readonly logout?: () => Promise<LogoutResult>;
  loadModelCatalog(): Promise<ModelCatalogResult>;
}

export interface AgentModule {
  readonly id: AgentId;
  readonly createRuntime: (host: AgentHost) => AgentRuntime;
}
