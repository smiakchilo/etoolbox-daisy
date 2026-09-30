import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ReasoningSummary,
  SessionConfig,
  SessionEvent,
  Tool,
  ToolInvocation,
} from '@github/copilot-sdk';

import {
  type AgentEvent,
  type AemToolExecutor,
  agentEventSchema,
  applyAgentEvent,
  type AssistantTextDeltaEvent,
  type CanSendBlockReason,
  canSendMessage,
  type ChatId,
  createDeltaFoldState,
  createToolError,
  type DeltaFoldState,
  err,
  foldTextDelta,
  type IdGenerator,
  type JsonValue,
  jsonValueSchema,
  type MessageId,
  messageIdSchema,
  newRequestId,
  ok,
  parseAuthStatus,
  renderFoldedText,
  renderToolFailureForModel,
  type Result,
  reasoningIdSchema,
  type SdkSessionId,
  sdkSessionIdSchema,
  type SessionStatus,
  type SessionStreamState,
  type ToolCallId,
  toolCallIdSchema,
  type ToolDescriptor,
  type ToolError,
  type TurnId,
} from '../shared';
import {
  type AgentAuthState,
  type AgentService,
  type AgentServiceError,
  createAgentServiceError,
  type OpenConversationRequest,
  type SendPromptRequest,
  type Unsubscribe,
} from './agentService';
import {
  createHardenedSession,
  type HardenedSessionClient,
  type HardenedToolPolicy,
  resumeHardenedSession,
} from './toolPolicy';

/**
 * The real, SDK-backed `AgentService` (implementation-plan.md step 07).
 * Behaviourally interchangeable with `fakeAgentService.ts`: every public
 * method here follows the exact same one-active-conversation /
 * refuse-not-queue / self-checking-coherence rules that file documents in
 * detail, applied to a live `@github/copilot-sdk` session instead of a
 * scripted queue. Read `fakeAgentService.ts`'s module doc first if anything
 * below seems under-explained - this file leans on it rather than repeating
 * it.
 *
 * INJECTION SEAM: this module accepts an already-constructed
 * `HardenedSessionClient`-shaped client and an `AgentAuthStatusSource`,
 * rather than building either itself. It never calls
 * `createHardenedCopilotClient` - that would make this module untestable
 * without live Copilot auth and a real runtime child process, which is the
 * opposite of what a unit-testable adapter needs. A production caller wires
 * a real `CopilotClient` in for the session client and a projected
 * `AgentAuthState` source (see `AgentAuthStatusSource`) for auth;
 * `tests/unit/agent/sdkAgentService.test.ts` wires in fakes for both.
 *
 * SELF-CHECKING COHERENCE: exactly like the fake, every event this adapter
 * is about to hand to a listener first goes through two independent checks -
 * `agentEventSchema.parse` (shape: lengths, non-empty strings, brand format)
 * and `applyAgentEvent` (the state machine) - via `applyAndEmit`. Either
 * check failing throws, which is caught by this module's own SDK-event
 * dispatch wrapper and converted into a best-effort `error` event rather
 * than crashing the process; see `handleSdkEvent`.
 *
 * FINDINGS surfaced while building this adapter (see the session report for
 * the full write-up):
 *
 * 1. `streaming` is deliberately absent from `HARDENED_SESSION_CONFIG_DEFAULTS`
 *    (toolPolicy.ts) - confirmed with its owner, not a gap to fix there. The
 *    SDK's own default is `false` (`@default false`, `dist/types.d.ts`), so
 *    without an explicit override `assistant.message_delta` never fires.
 *    Streaming is a functional need of *this* adapter, not a hardening
 *    posture, so it is this module's job to pass `streaming: true` as an
 *    override - see `BASE_SESSION_OVERRIDES` below - which is legal precisely
 *    because `streaming` is not one of the keys `HardenedSessionOverrides`/
 *    `HardenedResumeOverrides` omit.
 * 2. `HARDENED_SESSION_CONFIG_DEFAULTS` forces `includeSubAgentStreamingEvents:
 *    false` and - unlike `streaming` - that key IS `Omit`ted from both
 *    override types, i.e. it is a non-negotiable security posture, not a
 *    default this adapter could ever flip back. It only suppresses sub-agent
 *    **streaming deltas**, per the SDK's own doc comment; `subagent.*`
 *    lifecycle events and other non-streaming sub-agent events (including,
 *    by the same reasoning, sub-agent tool events) are still forwarded
 *    regardless of that flag. This adapter's own `agentId !== undefined`
 *    filter is therefore a second, independent barrier, not redundant with
 *    the config-level one - see the "sub-agent event filtering" tests, which
 *    exercise both a suppressed-by-config delta and a still-forwarded
 *    non-streaming event to prove the filter earns its place.
 * 3. `tool.result` is NOT built from `tool.execution_complete` (a prior
 *    version of this file did this; corrected after reading
 *    `dist/session.js`'s `_executeToolAndRespond`). Our tool handler runs in
 *    OUR OWN process - the SDK calls it directly and holds the return value
 *    locally; it never emits a local event carrying that value. The only way
 *    a result-bearing event reaches us at all is a round trip back from the
 *    native runtime, which is exactly the path `docs/compatibility.md` §6.1
 *    records as unverified for external tools, and if the request is
 *    cancelled first (`_claimExternalTool` returns false) NOTHING is sent -
 *    no result, no error, ever. Building the user-visible tool outcome on
 *    that meant the single most important thing the tool step renders
 *    depended on an event this adapter could not prove fires and could not
 *    test deterministically. Since we are the executor, we already know the
 *    outcome exactly - see `AemToolExecutor`/`wrapToolExecutor` below:
 *    `tool.result` is emitted directly from the registered handler's own
 *    settle (resolve/reject), never from any SDK event.
 *    `tool.execution_start`/`tool.execution_complete`/`external_tool.completed`
 *    are all left unmapped as a result (the latter is, per the SDK's own
 *    docs, a UI-dismissal signal only regardless).
 * 4. `EventSequencer` (agentEvents.ts) is a duplicate/gap *detector* for a
 *    downstream consumer of an already-sequenced stream - it does not
 *    assign sequence numbers, and has no method that could. Neither this
 *    adapter nor `fakeAgentService.ts` (the behavioural reference) uses it
 *    to produce events; both use a simple per-chat counter instead. This
 *    contradicts the brief's "`sequence` is assigned by our adapter, via
 *    `EventSequencer`" - the class is real and exported, but it is the
 *    wrong primitive for that job.
 * 5. `HARDENED_SESSION_CONFIG_DEFAULTS` wires `onPermissionRequest:
 *    allowlistedToolPermissions(policy)` (toolPolicy.ts) - approve-once for
 *    a `kind: "custom-tool"` request whose `toolName` matches the policy's
 *    `availableTools` allowlist, deny-all otherwise (every non-custom-tool
 *    permission kind - shell, read, write, mcp, url, memory, hook, extension
 *    management - is still unconditionally rejected). This resolved what
 *    was originally a gap: a registered `AemToolExecutor` now runs
 *    end-to-end live without needing `skipPermission: true` on its `Tool`
 *    declaration. Consequently, the later task that supplies the real
 *    handler (s07-tool) must NOT set `skipPermission: true` - doing so
 *    would let the SDK auto-approve that tool regardless of the allowlist,
 *    bypassing the one-source-of-truth posture this design deliberately
 *    keeps in `toolPolicy.ts`.
 */

/**
 * Supplies the sign-in status this service seeds and opportunistically
 * refreshes `getAuthState()` from. Deliberately a separate constructor
 * option from `client` (not a method added to `HardenedSessionClient`),
 * per the brief's "a client ... plus an injectable auth-status provider".
 *
 * Returns this app's own {@link AgentAuthState} DTO, not the SDK's raw
 * `GetAuthStatusResponse`: the two are not the same shape. The raw response
 * has no `apiVersion`, so a caller that wired a bare `CopilotClient` in here
 * (as this adapter used to expect) produced an `apiVersion` validation
 * failure on every real start. The SDK boundary owns the conversion -
 * `toAuthStatus` in `copilotClient.ts` - and the composition root passes the
 * projected value in. A test fake therefore supplies the DTO directly.
 */
export interface AgentAuthStatusSource {
  getAuthStatus(): Promise<AgentAuthState>;
}

/**
 * The seam a tool module plugs its real AEM tool execution into - see finding
 * 3. Defined in `src/shared/tools/types.ts` so a tool module can own its own
 * executor without importing this SDK boundary; re-exported here because this
 * adapter's own options and wrapper name it.
 */
export type { AemToolExecutor };

export interface SdkAgentServiceOptions {
  readonly client: HardenedSessionClient;
  readonly policy: HardenedToolPolicy;
  readonly authSource: AgentAuthStatusSource;
  /**
   * Mints every `RequestId` this adapter needs to generate on its own (never
   * `chatId`/`turnId` - always caller-supplied - and never `messageId`/
   * `toolCallId` - always adopted from the SDK's own values; see
   * `agentService.ts`'s `SendPromptRequest` doc and this module's own
   * `messageIdSchema.parse`/`toolCallIdSchema.parse` call sites). Defaults
   * to `crypto.randomUUID`; tests pass a counter for reproducible ids.
   */
  readonly idGenerator?: IdGenerator;
  /**
   * Registers this adapter's own AEM tool executors, keyed by tool name.
   * Each is wrapped (see `wrapToolExecutor`) into an SDK `Tool.handler` and
   * passed to `createHardenedSession`/`resumeHardenedSession` as `tools`, so
   * the SDK calls back into our own process for that tool name instead of a
   * runtime round trip - see finding 3. Optional / defaults to none: the
   * real AEM handler (s07-tool) does not exist yet, so this is presently an
   * empty seam. Registration is deliberately name+function only, with no
   * `skipPermission` - approval is decided solely by `toolPolicy.ts`'s
   * allowlist (see finding 5), and s07-tool must keep it that way.
   */
  readonly toolHandlers?: Readonly<Record<string, AemToolExecutor>>;
  /**
   * The model-facing `description`/`parameters` for each registered tool,
   * supplied by the composition root from the tool registry (this adapter
   * imports no tool). A `toolHandlers` key without a descriptor here still
   * registers with `name`/`handler` only.
   */
  readonly toolDescriptors?: readonly ToolDescriptor[];
  /**
   * The user's persisted model / reasoning-effort defaults
   * (implementation-plan.md step 09), read fresh on every use rather than
   * captured once.
   *
   * A function, not a value, for the requirement's sake: "Changing the model
   * while idle ... takes effect on the next prompt". A value captured at
   * construction would freeze whatever was stored when the Copilot runtime
   * started, so a change made in Settings would not reach an already-open
   * conversation until the application restarted.
   *
   * Optional: omitted means "express no preference", which leaves model
   * selection entirely to the runtime's own default - the behaviour before
   * step 09.
   */
  readonly modelPreferences?: () => ModelPreference;
}

/**
 * The SDK's reasoning-effort union.
 *
 * Derived from `SessionConfig` rather than imported: the SDK declares
 * `ReasoningEffort` in `dist/types.d.ts` but does not re-export it from the
 * package root, and reaching into `@github/copilot-sdk/dist/types.js` would
 * depend on the package's internal file layout. `SessionConfig` is part of the
 * public barrel, so this stays a supported reference.
 */
type ReasoningEffort = NonNullable<SessionConfig['reasoningEffort']>;

/**
 * The reasoning-summary mode requested whenever a reasoning effort is
 * configured, so the model emits readable thinking (`assistant.reasoning` /
 * `assistant.reasoning_delta`) for the transcript's transient "Thinking"
 * billet. `'concise'` rather than `'detailed'`: the collapsed billet shows one
 * rolling line and the full text is only revealed on expansion, so a concise
 * summary is enough and a detailed one would inflate a stream that is
 * discarded the moment the block ends.
 *
 * Deliberately tied to `reasoningEffort` being set: a model the user runs at
 * its own default reasoning level is left untouched, so this cannot change the
 * behaviour of a preference the user did not express.
 */
const REASONING_SUMMARY: ReasoningSummary = 'concise';

/**
 * A model choice and, optionally, the reasoning effort to run it at.
 *
 * `model: null` means "no preference" - not "the default model". The
 * distinction matters on resume: with no preference there is nothing to apply,
 * so a resumed session keeps whatever model it was already using, which is
 * what "Do not silently replace the model when resuming" requires.
 */
export interface ModelPreference {
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

/**
 * Whether two preferences are the same choice. Used to decide if
 * `session.setModel` needs calling at all, so that an unchanged preference
 * costs no RPC before every prompt.
 */
function sameModelPreference(a: ModelPreference | undefined, b: ModelPreference): boolean {
  return a !== undefined && a.model === b.model && a.reasoningEffort === b.reasoningEffort;
}

/**
 * Projects a preference onto the SDK's session-config fields, omitting each
 * key entirely when there is nothing to express (required under
 * `exactOptionalPropertyTypes`, where `undefined` and "absent" differ).
 *
 * The `reasoningEffort` cast is the one deliberate type assertion in this
 * path. The SDK types it as the closed union
 * `"low" | "medium" | "high" | "xhigh" | "max"`, while this application stores
 * it as an open string - a decision `appSettings.ts` documents at length, so
 * that a level the SDK adds later is not rejected by a stale enum baked into
 * this codebase. The value is not arbitrary: `settings:set-model-preferences`
 * only persists a level that appeared in that very model's own
 * `supportedReasoningEfforts`, as reported by the SDK itself. So the string is
 * SDK-sourced; only its *type* has been widened in transit.
 */
function modelSessionConfig(preference: ModelPreference): {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: ReasoningSummary;
} {
  if (preference.model === null) return {};
  return {
    model: preference.model,
    ...(preference.reasoningEffort !== null
      ? {
          reasoningEffort: preference.reasoningEffort as ReasoningEffort,
          reasoningSummary: REASONING_SUMMARY,
        }
      : {}),
  };
}

/**
 * Session-creation override applied on both create and resume. `streaming`
 * - see finding 1 - is fixed; `tools` is built once per adapter instance
 * from `options.toolHandlers` (below `createSdkAgentService`'s own scope,
 * not here, since it needs the adapter's closures to emit `tool.result`).
 */
const BASE_SESSION_OVERRIDES = { streaming: true };

/** Mirrors `fakeAgentService.ts`'s identically-named constant. */
const TURN_IN_FLIGHT_STATES: ReadonlySet<SessionStreamState> = new Set([
  'sending',
  'streaming',
  'runningTool',
]);

/**
 * Maps a `canSendMessage` refusal reason to an `AgentServiceError`.
 * Duplicated from `fakeAgentService.ts`'s private (non-exported)
 * `blockReasonToError` rather than imported - the brief requires matching
 * it, not modifying that file to export it. Kept byte-for-byte identical in
 * behaviour so the two adapters never disagree about what a given
 * `CanSendBlockReason` means at this boundary.
 */
function blockReasonToError(reason: CanSendBlockReason): AgentServiceError {
  switch (reason) {
    case 'session_closed':
      return createAgentServiceError('PRECONDITION_FAILED', 'This conversation has been closed.');
    case 'not_authenticated':
      return createAgentServiceError(
        'COPILOT_UNAVAILABLE',
        'Not signed in to Copilot.',
        'sign_in_to_copilot',
      );
    case 'session_error':
      return createAgentServiceError(
        'PRECONDITION_FAILED',
        'The previous turn ended in an error; it must be dismissed before sending another prompt.',
      );
    case 'turn_in_progress':
      return createAgentServiceError(
        'PRECONDITION_FAILED',
        'A turn is already in progress on this conversation.',
      );
    default: {
      return reason;
    }
  }
}

// ---------------------------------------------------------------------------
// SDK payload -> normalized value helpers
// ---------------------------------------------------------------------------

const toolArgumentsSchema = z.record(z.string(), jsonValueSchema);

/** Validates an SDK-supplied `arguments`/`args` value; falls back to `{}` rather than throwing on garbage. */
function toToolArguments(value: unknown): Record<string, JsonValue> {
  const parsed = toolArgumentsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

type PermissionCompletedResult = Extract<
  SessionEvent,
  { type: 'permission.completed' }
>['data']['result'];

/**
 * Human-readable rejection reason for a permission denial. Never reached for
 * an approval - see the `permission.completed` case in `handleSdkEvent`,
 * which returns before calling this for any `approved*` result.
 */
function permissionDenialReason(result: PermissionCompletedResult): string {
  switch (result.kind) {
    case 'denied-interactively-by-user':
      return result.feedback !== undefined && result.feedback.length > 0
        ? result.feedback.slice(0, 500)
        : 'Denied by the user.';
    case 'denied-by-content-exclusion-policy':
      return result.message.slice(0, 500);
    case 'denied-by-permission-request-hook':
      return result.message !== undefined && result.message.length > 0
        ? result.message.slice(0, 500)
        : 'Denied by a permission-request hook.';
    case 'denied-by-rules':
      return "Denied by the application's configured approval rules.";
    case 'denied-no-approval-rule-and-could-not-request-from-user':
      return 'Denied: no approval rule matched and the user could not be asked.';
    case 'cancelled':
      return 'The permission request was cancelled.';
    default:
      return "Denied by the application's tool policy.";
  }
}

function defaultIdGenerator(): IdGenerator {
  return () => randomUUID();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Everything this adapter tracks about the one turn currently in flight. */
interface CurrentTurn {
  readonly turnId: TurnId;
  readonly messageIds: Set<MessageId>;
  readonly toolCallIds: Set<ToolCallId>;
}

/** What this adapter remembers about a pending `permission.requested` for a custom tool. */
interface PendingPermission {
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly arguments: Record<string, JsonValue>;
}

export function createSdkAgentService(options: SdkAgentServiceOptions): AgentService {
  const { client, policy, authSource } = options;
  const idGenerator = options.idGenerator ?? defaultIdGenerator();
  const readModelPreference: () => ModelPreference =
    options.modelPreferences ?? (() => ({ model: null, reasoningEffort: null }));

  let authState: AgentAuthState = { apiVersion: 1, isAuthenticated: false };
  const eventListeners = new Set<(event: AgentEvent) => void>();
  const authListeners = new Set<(state: AgentAuthState) => void>();
  const sequenceByChatId = new Map<ChatId, number>();

  let openChatId: ChatId | undefined;
  let openSession: Awaited<ReturnType<HardenedSessionClient['createSession']>> | undefined;
  let openUnsubscribe: (() => void) | undefined;
  let streamState: SessionStreamState = 'idle';
  let currentTurn: CurrentTurn | undefined;
  /**
   * The preference the currently open session is known to be running under,
   * or `undefined` for "unknown".
   *
   * `undefined` is the honest answer for a *resumed* session: the runtime
   * persisted whichever model that session last used, and this adapter has no
   * way to read it back that does not amount to guessing. Treating unknown as
   * "needs applying" is what makes a stored preference take effect on the
   * first prompt after a resume, while an absent preference still leaves the
   * resumed session's own model untouched.
   */
  let appliedModelPreference: ModelPreference | undefined;
  const pendingPermissionsByRequestId = new Map<string, PendingPermission>();
  const deltaFoldByMessageId = new Map<MessageId, DeltaFoldState>();

  function nextSequence(chatId: ChatId): number {
    const sequence = sequenceByChatId.get(chatId) ?? 0;
    sequenceByChatId.set(chatId, sequence + 1);
    return sequence;
  }

  /** See this module's doc comment, "SELF-CHECKING COHERENCE". */
  function applyAndEmit(event: AgentEvent): void {
    const validated = agentEventSchema.parse(event);
    const before: SessionStatus = {
      state: streamState,
      authenticated: authState.isAuthenticated,
      browserReady: true,
    };
    const applied = applyAgentEvent(before, validated);
    if (!applied.ok) {
      throw new Error(
        `sdkAgentService produced an illegal event sequence (${applied.error.message}). ` +
          'This is a bug in this adapter, not in the caller.',
      );
    }
    streamState = applied.value.state;
    for (const listener of eventListeners) listener(validated);
  }

  function makeSessionStateEvent(
    chatId: ChatId,
    state: SessionStreamState,
    turnId?: TurnId,
  ): AgentEvent {
    const sequence = nextSequence(chatId);
    return turnId === undefined
      ? { type: 'session.state.changed', chatId, sequence, state }
      : { type: 'session.state.changed', chatId, sequence, turnId, state };
  }

  /**
   * Wraps one `AemToolExecutor` into the SDK's own `Tool.handler` shape, so
   * the SDK calls straight into this adapter's process instead of a runtime
   * round trip - see finding 3. `tool.result` is emitted from here, not from
   * `handleSdkEvent`, on the executor's own settle (resolve or reject), and
   * always carries the executor's real `outcome` (`{ ok: true, data }` or
   * `{ ok: false, error }`) so the UI renders a genuine failed tool call -
   * message, code, `requiredAction` - rather than a call that "completed"
   * with the error only mentioned in the model's own prose.
   *
   * What is returned to the SDK itself (as opposed to what `tool.result`
   * carries) is a *rendering* of that same `outcome`, not a second source of
   * truth: success returns the executor's own `Result.value` untouched;
   * failure renders `outcome.error` x
   * of throwing, so the model reads the identical error text the UI's
   * `tool.result` is built from - see the `resultType` branch below.
   *
   * Cancellation guard: `turnAtInvocation` is captured synchronously, before
   * awaiting the executor. If `currentTurn` is no longer that exact object
   * by the time the executor settles - aborted, the turn ended, or a
   * different conversation is now open - nothing is emitted. This is the
   * same "drop it, the turn is gone" rule `handleSdkEvent`'s turn-scoped
   * cases apply to late SDK events, generalized to this adapter's own
   * asynchronous tool execution; it is also what keeps a stale settle from
   * ever calling `applyAndEmit` with a chat/state combination `sessionState.ts`
   * would reject as illegal (for example after the chat has moved to `idle`).
   */
  function wrapToolExecutor(executor: AemToolExecutor): NonNullable<Tool['handler']> {
    return async (rawArgs: unknown, invocation: ToolInvocation): Promise<unknown> => {
      const turnAtInvocation = currentTurn;
      const toolCallId = toolCallIdSchema.parse(invocation.toolCallId);
      let outcome:
        | { readonly ok: true; readonly data: JsonValue }
        | { readonly ok: false; readonly error: ToolError };
      try {
        const result = await executor(toToolArguments(rawArgs), {
          toolCallId,
          signal: invocation.signal,
        });
        outcome = result.ok ? { ok: true, data: result.value } : { ok: false, error: result.error };
      } catch (caught) {
        outcome = {
          ok: false,
          error: createToolError(
            'UNEXPECTED_RESPONSE',
            caught instanceof Error ? caught.message.slice(0, 500) : 'Tool execution failed.',
            newRequestId(idGenerator),
          ),
        };
      }
      if (
        currentTurn !== undefined &&
        currentTurn === turnAtInvocation &&
        openChatId !== undefined
      ) {
        applyAndEmit({
          type: 'tool.result',
          chatId: openChatId,
          sequence: nextSequence(openChatId),
          toolCallId,
          outcome,
        });
      }
      // A failure is a fully designed outcome, not an exceptional one - both
      // an `err(ToolError)` from the executor itself and an exception we
      // caught above collapse to the same `outcome.ok === false` shape by
      // this point. Rendering and returning it (rather than throwing) is
      // what makes the SDK's own `isToolResultObject()`
      // (`dist/cjs/session.js`) treat this as a structured result instead of
      // falling back to `JSON.stringify(rawResult)` - `resultType` is
      // mandatory for that even though the wire schema marks it optional
      // (docs/compatibility.md 5.3). Throwing here would collapse
      // `outcome.error` to a bare `Error.message` string, discarding its
      // code, `requiredAction`, and requestId - exactly the loss `tool.result`
      // above (still built from the untouched `outcome`) does not suffer,
      // so the UI and the model now see the same failure.
      if (!outcome.ok) {
        return {
          textResultForLlm: renderToolFailureForModel(outcome.error),
          resultType: 'failure',
        };
      }
      return outcome.data;
    };
  }

  /**
   * Looks up the shared, zod-derived `description`/`parameters` for a
   * registered tool name from `options.toolDescriptors` - the registry's own
   * descriptors - so this adapter never hand-writes (and cannot drift from)
   * that schema. A `toolHandlers` key that names something outside that list
   * still registers with `name`/`handler` only, matching this
   * function's prior behaviour, rather than silently failing to register.
   */
  const toolDescriptorsByName: ReadonlyMap<string, ToolDescriptor> = new Map(
    (options.toolDescriptors ?? []).map((descriptor) => [descriptor.name, descriptor]),
  );

  /**
   * Every registered `AemToolExecutor`, wrapped once at construction time
   * (not per `openConversation`) since only one conversation is ever open at
   * a time and the wrapper reads `currentTurn`/`openChatId` fresh on each
   * invocation rather than capturing a chat at build time.
   */
  const sdkTools: Tool[] = Object.entries(options.toolHandlers ?? {}).map(([name, executor]) => {
    const descriptor = toolDescriptorsByName.get(name);
    return {
      name,
      ...(descriptor !== undefined
        ? {
            description: descriptor.description,
            parameters: descriptor.parameters as Record<string, unknown>,
          }
        : {}),
      handler: wrapToolExecutor(executor),
    };
  });

  /** Passed to both `createHardenedSession` and `resumeHardenedSession` below. */
  const sessionOverrides = { ...BASE_SESSION_OVERRIDES, tools: sdkTools };

  /**
   * Refreshes the cached `authState` from `authSource`, notifying listeners
   * only when the value actually changed. Best-effort: a failure here keeps
   * the last known good value rather than clobbering it - see this module's
   * report for why this exists (the `AgentService` interface has no setter
   * for auth state, so this adapter has to decide for itself when to look
   * again; `openConversation`/`sendPrompt` are the two call sites).
   */
  async function refreshAuthState(): Promise<void> {
    try {
      const raw = await authSource.getAuthStatus();
      const next = parseAuthStatus(raw);
      const changed = JSON.stringify(next) !== JSON.stringify(authState);
      authState = next;
      if (changed) {
        for (const listener of authListeners) listener(authState);
      }
    } catch (error) {
      console.error(
        'sdkAgentService: failed to refresh Copilot auth status; keeping the last known value',
        error,
      );
    }
  }

  /**
   * Cancels the turn in flight on `chatId`. Clears `currentTurn` (and any
   * pending permission bookkeeping) BEFORE awaiting `session.abort()` -
   * this is the guard that makes post-abort suppression work against a real
   * SDK: any event for the aborted turn that the SDK still delivers after
   * this point arrives while `currentTurn` is already `undefined`, so every
   * turn-scoped case in `handleSdkEvent` drops it. `session.abort()` itself
   * is treated as advisory - its rejection does not stop the
   * `cancelling` -> `idle` sequence below, which is what actually drives
   * this adapter's state machine (see this module's own doc comment and
   * `sessionState.ts`'s `cancelling` documentation). No `error` event is
   * ever emitted for a deliberate abort, and no `RequestId` is minted for
   * one - see `agentService.ts`'s `SendPromptRequest` doc and
   * `ids.ts`'s `RequestId` doc for why.
   */
  async function performAbort(chatId: ChatId): Promise<void> {
    const turn = currentTurn;
    if (turn === undefined) {
      throw new Error(
        'sdkAgentService.performAbort called with no turn in flight - internal invariant violated.',
      );
    }
    currentTurn = undefined;
    pendingPermissionsByRequestId.clear();
    try {
      await openSession?.abort();
    } catch (error) {
      console.error(
        'sdkAgentService: session.abort() rejected; proceeding with cancelling -> idle regardless',
        error,
      );
    }
    applyAndEmit(makeSessionStateEvent(chatId, 'cancelling', turn.turnId));
    applyAndEmit(makeSessionStateEvent(chatId, 'idle', turn.turnId));
  }

  /**
   * Aborts the in-flight turn on `chatId` (if any), emits the terminal
   * `"closed"` state, unsubscribes from and disconnects the SDK session, and
   * clears every piece of this adapter's per-conversation bookkeeping.
   * Shared by `closeConversation` and by `openConversation`'s implicit
   * replacement of a different, already-open chat.
   */
  async function teardown(chatId: ChatId): Promise<void> {
    if (TURN_IN_FLIGHT_STATES.has(streamState)) {
      await performAbort(chatId);
    }
    applyAndEmit(makeSessionStateEvent(chatId, 'closed'));
    const session = openSession;
    const unsubscribe = openUnsubscribe;
    openSession = undefined;
    openUnsubscribe = undefined;
    if (openChatId === chatId) openChatId = undefined;
    appliedModelPreference = undefined;
    pendingPermissionsByRequestId.clear();
    deltaFoldByMessageId.clear();
    unsubscribe?.();
    if (session !== undefined) {
      try {
        await session.disconnect();
      } catch (error) {
        console.error('sdkAgentService: error disconnecting SDK session during teardown', error);
      }
    }
  }

  /**
   * Best-effort fallback when a raw SDK event fails either self-check in
   * `applyAndEmit` (illegal shape or illegal transition) or otherwise throws
   * while being mapped. Drops the current turn (its state is now unknown)
   * and surfaces a generic `error` event rather than letting the exception
   * propagate out of the SDK's own event emitter.
   */
  function reportInternalMappingFailure(chatId: ChatId, eventType: string, caught: unknown): void {
    console.error('sdkAgentService: failed to process SDK session event', eventType, caught);
    currentTurn = undefined;
    pendingPermissionsByRequestId.clear();
    if (streamState === 'closed') return;
    try {
      applyAndEmit({
        type: 'error',
        chatId,
        sequence: nextSequence(chatId),
        error: createToolError(
          'UNEXPECTED_RESPONSE',
          'An internal error occurred while processing the agent event stream.',
          newRequestId(idGenerator),
        ),
      });
    } catch (innerCaught) {
      console.error('sdkAgentService: failed to emit the fallback error event', innerCaught);
    }
  }

  /**
   * Projects one raw SDK `SessionEvent` onto zero or more normalized
   * `AgentEvent`s. Only the event types listed below are mapped; everything
   * else (~120 other SDK event types, including `abort`,
   * `tool.execution_start`, `tool.execution_complete`, and
   * `external_tool.completed` - see finding 3 in this module's doc comment
   * for why the tool-lifecycle events specifically are deliberately
   * excluded) is ignored. `tool.result` is emitted elsewhere, from
   * `wrapToolExecutor` below - not from this function.
   */
  function handleSdkEvent(chatId: ChatId, event: SessionEvent): void {
    if (chatId !== openChatId) return;
    if (streamState === 'closed') return;
    // Sub-agent event: never surfaced into the user's own message/tool
    // stream - see finding 2 in this module's doc comment.
    if (event.agentId !== undefined) return;

    try {
      switch (event.type) {
        case 'assistant.message_start': {
          if (currentTurn === undefined) return;
          const messageId = messageIdSchema.parse(event.data.messageId);
          currentTurn.messageIds.add(messageId);
          deltaFoldByMessageId.set(messageId, createDeltaFoldState(messageId));
          applyAndEmit({
            type: 'assistant.message.started',
            chatId,
            sequence: nextSequence(chatId),
            turnId: currentTurn.turnId,
            messageId,
          });
          return;
        }
        case 'assistant.message_delta': {
          if (currentTurn === undefined) return;
          const messageId = messageIdSchema.parse(event.data.messageId);
          if (!currentTurn.messageIds.has(messageId)) return;
          if (event.data.deltaContent.length === 0) return;
          const deltaEvent: AssistantTextDeltaEvent = {
            type: 'assistant.text.delta',
            chatId,
            sequence: nextSequence(chatId),
            turnId: currentTurn.turnId,
            messageId,
            delta: event.data.deltaContent,
          };
          const fold = deltaFoldByMessageId.get(messageId);
          if (fold !== undefined) {
            deltaFoldByMessageId.set(messageId, foldTextDelta(fold, deltaEvent));
          }
          applyAndEmit(deltaEvent);
          return;
        }
        case 'assistant.message': {
          if (currentTurn === undefined) return;
          const messageId = messageIdSchema.parse(event.data.messageId);
          if (!currentTurn.messageIds.has(messageId)) return;
          const fold = deltaFoldByMessageId.get(messageId);
          deltaFoldByMessageId.delete(messageId);
          if (fold !== undefined) {
            const streamed = renderFoldedText(fold);
            if (streamed.length > 0 && streamed !== event.data.content) {
              // The SDK's final content can legitimately differ from the
              // streamed reconstruction (server-side post-processing,
              // docs/compatibility.md). Logged only as a diagnostic signal:
              // `event.data.content` is authoritative regardless and is what
              // gets emitted below - REPLACING the streamed text, never
              // concatenated with it.
              console.error(
                `sdkAgentService: final content for message "${messageId}" differs from its ` +
                  "streamed deltas; using the SDK's final content (authoritative).",
              );
            }
          }
          applyAndEmit({
            type: 'assistant.message.completed',
            chatId,
            sequence: nextSequence(chatId),
            turnId: currentTurn.turnId,
            messageId,
            content: event.data.content,
          });
          return;
        }
        case 'assistant.reasoning_delta': {
          if (currentTurn === undefined) return;
          if (event.data.deltaContent.length === 0) return;
          applyAndEmit({
            type: 'assistant.reasoning.delta',
            chatId,
            sequence: nextSequence(chatId),
            turnId: currentTurn.turnId,
            reasoningId: reasoningIdSchema.parse(event.data.reasoningId),
            delta: event.data.deltaContent,
          });
          return;
        }
        case 'assistant.reasoning': {
          if (currentTurn === undefined) return;
          applyAndEmit({
            type: 'assistant.reasoning.completed',
            chatId,
            sequence: nextSequence(chatId),
            turnId: currentTurn.turnId,
            reasoningId: reasoningIdSchema.parse(event.data.reasoningId),
            content: event.data.content,
          });
          return;
        }
        case 'external_tool.requested': {
          if (currentTurn === undefined) return;
          const toolCallId = toolCallIdSchema.parse(event.data.toolCallId);
          if (currentTurn.toolCallIds.has(toolCallId)) return;
          currentTurn.toolCallIds.add(toolCallId);
          applyAndEmit({
            type: 'tool.call.requested',
            chatId,
            sequence: nextSequence(chatId),
            toolCallId,
            toolName: event.data.toolName,
            arguments: toToolArguments(event.data.arguments),
          });
          applyAndEmit({
            type: 'tool.call.approved',
            chatId,
            sequence: nextSequence(chatId),
            toolCallId,
          });
          return;
        }
        case 'permission.requested': {
          if (currentTurn === undefined) return;
          const request = event.data.permissionRequest;
          // Only a custom-tool request is representable as a `tool.call.*`
          // event - shell/write/read/mcp/etc. permission kinds have no
          // corresponding variant in this module's contract.
          if (request.kind !== 'custom-tool') return;
          pendingPermissionsByRequestId.set(event.data.requestId, {
            ...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
            toolName: request.toolName,
            arguments: toToolArguments(request.args),
          });
          return;
        }
        case 'permission.completed': {
          if (currentTurn === undefined) return;
          const pending = pendingPermissionsByRequestId.get(event.data.requestId);
          pendingPermissionsByRequestId.delete(event.data.requestId);
          if (pending === undefined) return;
          if (
            event.data.result.kind === 'approved' ||
            event.data.result.kind === 'approved-for-session' ||
            event.data.result.kind === 'approved-for-location'
          ) {
            // `external_tool.requested` (guaranteed for custom tools) is
            // what drives `tool.call.requested`/`tool.call.approved` -
            // nothing to do here for an approval.
            return;
          }
          const rawToolCallId = event.data.toolCallId ?? pending.toolCallId;
          if (rawToolCallId === undefined) return;
          const toolCallId = toolCallIdSchema.parse(rawToolCallId);
          if (!currentTurn.toolCallIds.has(toolCallId)) {
            currentTurn.toolCallIds.add(toolCallId);
            applyAndEmit({
              type: 'tool.call.requested',
              chatId,
              sequence: nextSequence(chatId),
              toolCallId,
              toolName: pending.toolName,
              arguments: pending.arguments,
            });
          }
          applyAndEmit({
            type: 'tool.call.rejected',
            chatId,
            sequence: nextSequence(chatId),
            toolCallId,
            reason: permissionDenialReason(event.data.result),
          });
          return;
        }
        case 'session.idle': {
          if (currentTurn === undefined) return;
          const turnId = currentTurn.turnId;
          currentTurn = undefined;
          pendingPermissionsByRequestId.clear();
          applyAndEmit(makeSessionStateEvent(chatId, 'idle', turnId));
          return;
        }
        case 'session.error': {
          const turnId = currentTurn?.turnId;
          currentTurn = undefined;
          pendingPermissionsByRequestId.clear();
          const toolError = createToolError(
            'COPILOT_UNAVAILABLE',
            'The Copilot agent reported an error.',
            newRequestId(idGenerator),
          );
          applyAndEmit(
            turnId === undefined
              ? { type: 'error', chatId, sequence: nextSequence(chatId), error: toolError }
              : { type: 'error', chatId, sequence: nextSequence(chatId), turnId, error: toolError },
          );
          return;
        }
        default:
          return;
      }
    } catch (caught) {
      reportInternalMappingFailure(chatId, event.type, caught);
    }
  }

  return {
    async initialize(): Promise<Result<void, AgentServiceError>> {
      try {
        const raw = await authSource.getAuthStatus();
        authState = parseAuthStatus(raw);
        return ok(undefined);
      } catch (error) {
        console.error('sdkAgentService: failed to read initial Copilot auth status', error);
        return err(
          createAgentServiceError(
            'COPILOT_UNAVAILABLE',
            'Could not determine Copilot sign-in status.',
            'sign_in_to_copilot',
          ),
        );
      }
    },

    getAuthState(): AgentAuthState {
      return authState;
    },

    getOpenSessionId(): SdkSessionId | undefined {
      const raw = openSession?.sessionId;
      if (raw === undefined) return undefined;
      const parsed = sdkSessionIdSchema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    },

    onAuthStateChanged(listener: (state: AgentAuthState) => void): Unsubscribe {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },

    onEvent(listener: (event: AgentEvent) => void): Unsubscribe {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    async openConversation(
      request: OpenConversationRequest,
    ): Promise<Result<ChatId, AgentServiceError>> {
      await refreshAuthState();

      if (openChatId === request.chatId) {
        return ok(request.chatId);
      }
      if (openChatId !== undefined) {
        await teardown(openChatId);
      }

      try {
        // Step 09: a *new* session carries the preference in its own creation
        // config, so the very first prompt already runs on the chosen model.
        // A *resumed* session deliberately does not - "Do not silently replace
        // the model when resuming" - and instead has the preference applied
        // (if there is one) through `setModel` before its next prompt, which
        // preserves that session's conversation history either way.
        const preference = readModelPreference();
        const session = request.resume
          ? await resumeHardenedSession(
              client,
              request.resume.sdkSessionId,
              policy,
              sessionOverrides,
            )
          : await createHardenedSession(client, policy, {
              ...sessionOverrides,
              ...modelSessionConfig(preference),
            });
        const unsubscribe = session.on((event) => {
          handleSdkEvent(request.chatId, event);
        });
        openChatId = request.chatId;
        openSession = session;
        openUnsubscribe = unsubscribe;
        streamState = 'idle';
        currentTurn = undefined;
        appliedModelPreference = request.resume ? undefined : preference;
        pendingPermissionsByRequestId.clear();
        deltaFoldByMessageId.clear();
        return ok(request.chatId);
      } catch (error) {
        const action = request.resume ? 'resume' : 'create';
        console.error(`sdkAgentService: failed to ${action} SDK session`, error);
        return err(
          createAgentServiceError(
            request.resume ? 'RESUME_FAILED' : 'COPILOT_UNAVAILABLE',
            request.resume
              ? 'Could not resume the existing Copilot session.'
              : 'Could not start a new Copilot session.',
          ),
        );
      }
    },

    async sendPrompt(request: SendPromptRequest): Promise<Result<void, AgentServiceError>> {
      if (openChatId === undefined || openChatId !== request.chatId) {
        return err(
          createAgentServiceError(
            'INVALID_ARGUMENT',
            `"${request.chatId}" is not the open conversation.`,
          ),
        );
      }

      await refreshAuthState();

      const status: SessionStatus = {
        state: streamState,
        authenticated: authState.isAuthenticated,
        browserReady: true,
      };
      const gate = canSendMessage(status);
      if (!gate.canSend) {
        return err(blockReasonToError(gate.reason));
      }

      const session = openSession;
      if (session === undefined) {
        // Unreachable in practice (openChatId !== undefined implies a
        // session was stored alongside it), kept only so the compiler does
        // not need a non-null assertion below.
        return err(
          createAgentServiceError(
            'PRECONDITION_FAILED',
            'No active Copilot session for this conversation.',
          ),
        );
      }

      // Step 09: "Changing the model while idle preserves history and takes
      // effect on the next prompt." This is that next prompt. Done here rather
      // than when the setting changed, because the Settings window must not
      // reach into a live session; and done *before* the turn is marked as
      // started, so that a rejected model switch leaves the conversation idle
      // and re-promptable instead of stuck in a turn that never began.
      //
      // `setModel` is documented by the SDK as preserving conversation
      // history, which is what makes an in-place switch legitimate at all.
      const preference = readModelPreference();
      if (preference.model !== null && !sameModelPreference(appliedModelPreference, preference)) {
        try {
          await session.setModel(preference.model, {
            ...(preference.reasoningEffort !== null
              ? {
                  reasoningEffort: preference.reasoningEffort as ReasoningEffort,
                  reasoningSummary: REASONING_SUMMARY,
                }
              : {}),
          });
          appliedModelPreference = preference;
        } catch (error) {
          // An unavailable model is reported, never worked around. Silently
          // falling back to whatever the session was using would be exactly
          // the "silently replace the model" behaviour step 09 forbids, and
          // the user would be billed for and reasoning about a model they did
          // not choose.
          console.error('sdkAgentService: session.setModel() rejected', error);
          return err(
            createAgentServiceError(
              'COPILOT_UNAVAILABLE',
              `Copilot could not switch to the model "${preference.model}". Choose a different model in Settings.`,
            ),
          );
        }
      }

      currentTurn = { turnId: request.turnId, messageIds: new Set(), toolCallIds: new Set() };
      // Applied synchronously, before the SDK send call even starts: a
      // second sendPrompt() called before any SDK event arrives must already
      // see "turn_in_progress" - mirrors fakeAgentService.ts exactly.
      applyAndEmit(makeSessionStateEvent(request.chatId, 'sending', request.turnId));

      try {
        await session.send({
          prompt: request.prompt,
          ...(request.displayPrompt !== undefined ? { displayPrompt: request.displayPrompt } : {}),
        });
        return ok(undefined);
      } catch (error) {
        console.error('sdkAgentService: session.send() rejected', error);
        currentTurn = undefined;
        const toolError = createToolError(
          'COPILOT_UNAVAILABLE',
          'Could not send the prompt to Copilot.',
          newRequestId(idGenerator),
        );
        applyAndEmit({
          type: 'error',
          chatId: request.chatId,
          sequence: nextSequence(request.chatId),
          turnId: request.turnId,
          error: toolError,
        });
        return err(
          createAgentServiceError('COPILOT_UNAVAILABLE', 'Could not send the prompt to Copilot.'),
        );
      }
    },

    async abort(chatId: ChatId): Promise<Result<void, AgentServiceError>> {
      if (openChatId === undefined || openChatId !== chatId) {
        return err(
          createAgentServiceError('INVALID_ARGUMENT', `"${chatId}" is not the open conversation.`),
        );
      }
      if (!TURN_IN_FLIGHT_STATES.has(streamState)) {
        return ok(undefined);
      }
      await performAbort(chatId);
      return ok(undefined);
    },

    async closeConversation(chatId: ChatId): Promise<Result<void, AgentServiceError>> {
      if (openChatId === undefined || openChatId !== chatId) {
        return err(
          createAgentServiceError('INVALID_ARGUMENT', `"${chatId}" is not the open conversation.`),
        );
      }
      await teardown(chatId);
      return ok(undefined);
    },

    async dispose(): Promise<void> {
      eventListeners.clear();
      authListeners.clear();
      currentTurn = undefined;
      appliedModelPreference = undefined;
      pendingPermissionsByRequestId.clear();
      deltaFoldByMessageId.clear();
      const session = openSession;
      const unsubscribe = openUnsubscribe;
      openSession = undefined;
      openUnsubscribe = undefined;
      openChatId = undefined;
      streamState = 'closed';
      unsubscribe?.();
      if (session !== undefined) {
        try {
          await session.disconnect();
        } catch (error) {
          console.error('sdkAgentService: error disconnecting SDK session during dispose', error);
        }
      }
    },
  };
}
