import type {
  CopilotSession,
  PermissionHandler,
  ResumeSessionConfig,
  SessionConfig,
  SystemMessageConfig,
} from '@github/copilot-sdk';

/**
 * Session-level hardening defaults that replicate what the SDK's
 * `mode: "empty"` would apply via its internal `configDefaultsForMode()` /
 * `updateSessionOptionsForMode()` (verified in `dist/cjs/client.js`), without
 * actually setting `mode: "empty"`.
 *
 * We avoid `mode: "empty"` because it unconditionally sets
 * `COPILOT_DISABLE_KEYTAR=1` after the environment is built, which cannot be
 * overridden and breaks vault-backed authentication (verified live: same
 * `COPILOT_HOME`, same vault entry, `isAuthenticated` flips from `true` to
 * `false` purely because of `mode: "empty"`). Everything else that mode does
 * is an ordinary `SessionConfigBase` default, so we set those fields
 * ourselves and keep `mode` unset (equivalent to `"copilot-cli"`, which is
 * the mode that leaves `useLoggedInUser`/keytar lookups intact).
 *
 * NOTE ON SCOPE: the upstream task brief described these as client-level
 * options ("Set these explicitly on the client"). Real SDK source
 * (`dist/types.d.ts`) shows every one of them is a `SessionConfigBase` field,
 * applied per session - there is no client-level equivalent. This module
 * therefore applies them per `createHardenedSession`/`resumeHardenedSession`
 * call instead, which is also required anyway because `ResumeSessionConfig`
 * is never persisted (see the module doc below).
 */
const HARDENED_SESSION_CONFIG_DEFAULTS = {
  enableSessionTelemetry: false,
  mcpOAuthTokenStorage: 'in-memory',
  skipEmbeddingRetrieval: true,
  embeddingCacheStorage: 'in-memory',
  enableOnDemandInstructionDiscovery: false,
  enableFileHooks: false,
  enableHostGitOperations: false,
  enableSessionStore: false,
  enableSkills: false,
  memory: { enabled: false },
  // The SDK defaults this to `true`, which forwards sub-agent streaming deltas
  // (those carrying an `agentId`) onto the same connection as the top-level
  // assistant's. Interleaved into one accumulator they would splice another
  // agent's text into the user's reply. Suppressed here rather than only
  // filtered downstream, so the content never reaches us at all. Note this
  // suppresses sub-agent *deltas* only - `subagent.*` lifecycle and
  // non-streaming sub-agent events are still forwarded, so a consumer that
  // accumulates text must still ignore events with a defined `agentId`.
  includeSubAgentStreamingEvents: false,
  // The SDK defaults this to `{ enabled: true, maxSizeBytes: 51200 }`, which
  // does not reject an oversized tool result - it silently writes it to a file
  // in the OS temp directory and hands the model a path instead. For this app
  // that would spill private AEM author content onto disk outside our control,
  // with no error and nothing surfaced to the user. Disabled so a tool result
  // either reaches the model intact or fails visibly.
  largeOutput: { enabled: false },
  customAgentsLocalOnly: true,
  enableConfigDiscovery: false,
  enableExperimentalMode: false,
  mcpServers: {},
} as const satisfies Partial<SessionConfig>;

/**
 * Builds the session's system message: strips the tool-inventory
 * ("environment_context") section the same way `mode: "empty"` would, and
 * appends the application's own instruction text.
 *
 * `customize` mode carries an append-style `content` alongside its section
 * overrides, so both happen in one config. The instruction text is taken from
 * the validated policy rather than from caller `overrides`, because
 * `systemMessage` is `Omit`ted from the override types - letting a caller pass
 * a raw `systemMessage` would let it drop the section strip, or switch to
 * `mode: "replace"`, which the SDK documents as removing every built-in
 * guardrail.
 */
function buildSystemMessage(policy: HardenedToolPolicy): SystemMessageConfig {
  const instructions = policy.instructions?.trim();
  return {
    mode: 'customize',
    sections: { environment_context: { action: 'remove' } },
    ...(instructions !== undefined && instructions !== '' ? { content: instructions } : {}),
  };
}

/**
 * Fields `mode: "empty"` re-applies via `session.rpc.options.update()` *after*
 * `createSession`/`resumeSession` (verified in `dist/cjs/client.js`,
 * `updateSessionOptionsForMode`), rather than through the create/resume
 * config itself. `installedPlugins` in particular is not a `SessionConfig`
 * field at all - it is only settable through this RPC.
 */
const POST_CREATE_OPTIONS_PATCH = {
  skipCustomInstructions: true,
  customAgentsLocalOnly: true,
  coauthorEnabled: false,
  manageScheduleEnabled: false,
  includedBuiltinSkills: [] as string[],
  installedPlugins: [] as never[],
} as const;

/**
 * A tool policy the caller must construct explicitly and non-omittably.
 * `availableTools` supports the same source-qualified syntax as the SDK
 * (`builtin:*`, `mcp:*`, `custom:*`, or exact names) - a bare `"*"` is
 * rejected by the runtime itself (`validateToolFilterList`). An explicit `[]`
 * is a valid, meaningful "deny every tool" policy, not an omission.
 */
export interface HardenedToolPolicy {
  readonly availableTools: string[];
  readonly excludedTools?: string[];
  /**
   * Instruction text appended to the system prompt after the SDK's own
   * sections. Used for the bundled base AEM instruction that describes a
   * read-only AEM assistant.
   *
   * Appended, never substituted: the SDK's safety and tool-instruction
   * sections stay in place.
   */
  readonly instructions?: string;
}

/**
 * Denies every permission request. There is no scenario in this step's
 * temporary diagnostic surface (or any planned use of `createHardenedSession`
 * before a real permission-review UI exists in a later step) where an
 * unattended auto-approval is acceptable; `approveAll` is explicitly
 * forbidden by docs/requirements-decisions.md.
 */
export function denyAllPermissions(): PermissionHandler {
  return () => ({
    kind: 'reject',
    feedback:
      "Denied by EToolbox Daisy's hardened tool policy (no interactive reviewer configured)",
  });
}

/**
 * Matches a permission request's bare `toolName` against one allowlist entry,
 * which may be either bare (`aem_get_json`) or source-qualified
 * (`custom:aem_get_json`). The prefix is not hard-coded: any entry whose part
 * after the last `:` matches counts, so this does not silently stop working if
 * the SDK's qualifier syntax gains another source.
 */
function allowlistEntryMatches(entry: string, toolName: string): boolean {
  if (entry === toolName) return true;
  const separator = entry.lastIndexOf(':');
  return separator !== -1 && entry.slice(separator + 1) === toolName;
}

/**
 * Approves exactly the custom tools named in `policy`'s allowlist, and rejects
 * every other permission request.
 *
 * This is what makes an allowlisted tool actually executable. The SDK asks for
 * permission before invoking a custom tool, so a session wired to
 * {@link denyAllPermissions} refuses its own allowlisted tool on every call -
 * a failure that only shows up against a live runtime, because the deterministic
 * fake never raises a permission request.
 *
 * It is deliberately *not* `approveAll`, which
 * docs/requirements-decisions.md forbids: deny remains the default, the single
 * `availableTools` allowlist stays the one source of truth for what may run,
 * and every other permission kind the runtime can ask about - shell, file read
 * and write, MCP, URL fetch, memory, hooks, extension management - is still
 * rejected outright.
 *
 * Approval is `approve-once`, never `approve-for-session`/`-for-location`/
 * `-permanently`: the decision is re-made on every call from the policy in
 * memory, and nothing is persisted to disk or remembered by the runtime.
 */
export function allowlistedToolPermissions(policy: HardenedToolPolicy): PermissionHandler {
  const allowlist = [...policy.availableTools];
  const rejectRequest = denyAllPermissions();
  return (request, invocation) => {
    if (request.kind !== 'custom-tool') {
      return rejectRequest(request, invocation);
    }
    const permitted = allowlist.some((entry) => allowlistEntryMatches(entry, request.toolName));
    return permitted ? { kind: 'approve-once' } : rejectRequest(request, invocation);
  };
}

/**
 * Throws unless `policy.availableTools` was explicitly supplied (even as an
 * empty array). This replaces the guarantee `mode: "empty"` would otherwise
 * give us: without it, the SDK's default mode (`"copilot-cli"`) silently
 * grants the full built-in tool inventory when `availableTools` is omitted.
 */
function assertExplicitAllowlist(policy: HardenedToolPolicy): void {
  if (policy == null || !Array.isArray(policy.availableTools)) {
    throw new Error(
      'createHardenedSession()/resumeHardenedSession() require an explicit ' +
        'HardenedToolPolicy.availableTools allowlist (an array - possibly empty ' +
        "to deny every tool). Refusing to create a session with the SDK's " +
        'implicit default tool access',
    );
  }
}

type HardenedSessionOverrides = Omit<
  SessionConfig,
  | keyof typeof HARDENED_SESSION_CONFIG_DEFAULTS
  | 'availableTools'
  | 'excludedTools'
  | 'onPermissionRequest'
  | 'systemMessage'
  | 'skillDirectories'
>;

type HardenedResumeOverrides = Omit<
  ResumeSessionConfig,
  | keyof typeof HARDENED_SESSION_CONFIG_DEFAULTS
  | 'availableTools'
  | 'excludedTools'
  | 'onPermissionRequest'
  | 'systemMessage'
  | 'skillDirectories'
>;

/**
 * The runtime's own skill machinery stays off (`enableSkills: false`): a skill
 * is loaded by the application's `load_skill` tool like any other app tool, listed in
 * `availableTools` as `custom:load_skill`, so no runtime-side skill directory exists.
 */
function buildHardenedConfig<TOverrides extends object>(
  policy: HardenedToolPolicy,
  overrides: TOverrides,
): TOverrides &
  typeof HARDENED_SESSION_CONFIG_DEFAULTS & {
    availableTools: string[];
    onPermissionRequest: PermissionHandler;
    systemMessage: SystemMessageConfig;
  } {
  assertExplicitAllowlist(policy);
  return {
    ...overrides,
    ...HARDENED_SESSION_CONFIG_DEFAULTS,
    availableTools: [...policy.availableTools],
    // `excludedTools` is typed `string[] | ToolSet` (no `undefined` member) on
    // the SDK's own config types, so under `exactOptionalPropertyTypes` the
    // key must be omitted entirely rather than set to `undefined` when the
    // caller didn't supply one.
    ...(policy.excludedTools !== undefined ? { excludedTools: policy.excludedTools } : {}),
    onPermissionRequest: allowlistedToolPermissions(policy),
    systemMessage: buildSystemMessage(policy),
  };
}

/**
 * Applies the restrictions that only exist as an `options.update()` RPC
 * (`installedPlugins`) plus the rest of the post-create patch, immediately
 * after session creation/resume. Must run on *every* create and resume:
 * `ResumeSessionConfig` restrictions are not persisted by the runtime, so a
 * plain `client.resumeSession(id, {...})` without re-supplying them would
 * silently drop back to defaults.
 */
async function applyPostCreateHardening(session: CopilotSession): Promise<void> {
  const result = await session.rpc.options.update({ ...POST_CREATE_OPTIONS_PATCH });
  if (!result.success) {
    throw new Error(
      `Failed to apply hardened post-create session options for session "${session.sessionId}"`,
    );
  }
}

/**
 * Minimal shape of `CopilotClient` this module needs, so unit tests can pass
 * a fake instead of a real SDK client.
 */
export interface HardenedSessionClient {
  createSession(config: SessionConfig): Promise<CopilotSession>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession>;
  /**
   * Permanently deletes the SDK's stored session data (`CopilotClient`'s own
   * `deleteSession`). Optional because this is the only member a test fake
   * never needs and the only one not exercised by create/resume - the real
   * client always supplies it. Absent means "this client persists no session
   * state", which the adapter treats as an idempotent no-op.
   */
  deleteSession?(sessionId: string): Promise<void>;
}

/**
 * Creates a session with the hardened defaults applied, refusing to proceed
 * unless the caller supplied an explicit tool allowlist.
 */
export async function createHardenedSession(
  client: HardenedSessionClient,
  policy: HardenedToolPolicy,
  overrides: HardenedSessionOverrides = {},
): Promise<CopilotSession> {
  const config = buildHardenedConfig(policy, overrides);
  const session = await client.createSession(config);
  await applyPostCreateHardening(session);
  return session;
}

/**
 * Resumes a session with the same hardened defaults re-applied (see
 * `applyPostCreateHardening`'s doc comment for why this cannot be skipped on
 * resume).
 */
export async function resumeHardenedSession(
  client: HardenedSessionClient,
  sessionId: string,
  policy: HardenedToolPolicy,
  overrides: HardenedResumeOverrides = {},
): Promise<CopilotSession> {
  const config = buildHardenedConfig(policy, overrides);
  const session = await client.resumeSession(sessionId, config);
  await applyPostCreateHardening(session);
  return session;
}
