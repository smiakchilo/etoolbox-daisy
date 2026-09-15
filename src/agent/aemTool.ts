import type { AemToolExecutor } from './sdkAgentService';
import type { HardenedToolPolicy } from './toolPolicy';
import {
  AEM_GET_JSON_TOOL_DESCRIPTOR,
  AEM_QUERY_TOOL_DESCRIPTOR,
  aemGetJsonArgsSchema,
  aemQueryArgsSchema,
  computeDeadline,
  toolRequestEnvelopeSchema,
  type Clock,
  type ToolOperation,
  type ToolRequestEnvelope,
} from '../shared/contracts/toolContracts';
import { createToolError, type ToolError } from '../shared/contracts/errors';
import {
  renderToolResultForModel,
  type ToolResult,
  type ToolSuccess,
} from '../shared/contracts/toolResult';
import {
  newRequestId,
  type ChatId,
  type IdGenerator,
  type RequestId,
  type ServerId,
  type TurnId,
} from '../shared/contracts/ids';
import { err, ok, type Result } from '../shared/result';
import type { JsonValue } from '../shared/contracts/agentEvents';

/**
 * Wires the existing `aem_get_json` handler (`src/main/aem/aemGetJson.ts`) up
 * to the SDK adapter's own `AemToolExecutor` seam (`sdkAgentService.ts`) as
 * the single model-facing tool (implementation-plan.md step 07, task
 * s07-tool). This module is wiring and boundary enforcement, not new domain
 * logic: the JCR path/argument validation, the AEM error taxonomy, the HTTP
 * classification, and the deadline/queueing policy all already exist
 * elsewhere and are reused here, never reimplemented.
 *
 * BOUNDARY: this module never imports `src/main/aem/aemGetJson.ts`.
 * `tsconfig.agent.json` references only `tsconfig.shared.json` - not
 * `tsconfig.main.json` - while `tsconfig.main.json` itself references
 * `tsconfig.agent.json`; importing the other way would be both a layering
 * violation and a circular project reference. `createAemGetJsonExecutor`
 * below instead takes the real `executeAemGetJson` as an injected `execute`
 * callback, generic over whatever `deps` shape it needs besides `origin`
 * (in practice `AemGetJsonDeps`'s `fetchThroughBridge`/`now`). Because
 * `TRuntimeDeps` is never given a concrete shape by this module, the real
 * `executeAemGetJson` can be passed in unmodified by the main-process
 * composition root that wires a live session (a later task) - there is no
 * redeclared copy of `AemGetJsonDeps` here for it to drift from.
 *
 * TOOL DEFINITION: this module does not assemble a full SDK `Tool` object
 * (name/description/parameters/handler) either. `sdkAgentService.ts`'s
 * `SdkAgentServiceOptions.toolHandlers` is a name-keyed `AemToolExecutor`
 * map; the adapter's own `sdkTools` construction looks up `description`/
 * `parameters` for a registered name from `toolContracts.ts`'s
 * `TOOL_DESCRIPTORS` table (the same table `AEM_GET_JSON_TOOL_DESCRIPTOR`
 * lives in), so the model-facing schema can never hand-drift from the one
 * that validates the call. That lookup - like this module - never sets
 * `skipPermission` or `defer` on the resulting `Tool`: approval is decided
 * solely by `toolPolicy.ts`'s allowlist (docs/compatibility.md 6.3), and one
 * registered tool never crosses the SDK's built-in tool-search deferral
 * threshold, so pinning `defer: "never"` would be speculative.
 */

/** The `aem_get_json` arm of `ToolRequestEnvelope` - the only member this executor builds. */
export type AemGetJsonRequestEnvelope = Extract<ToolRequestEnvelope, { operation: 'aem_get_json' }>;

/** The key `sdkAgentService.ts`'s `SdkAgentServiceOptions.toolHandlers` must register this executor under. */
export const AEM_GET_JSON_TOOL_NAME: string = AEM_GET_JSON_TOOL_DESCRIPTOR.name;

/**
 * Everything about "where a request goes" that the model must never choose,
 * read fresh on every call via `currentContext()` - the same pattern
 * `bridgeBroker.ts`'s `BrokerDeps.currentContext` uses for the staleness
 * fields alone. The model's tool arguments (`path`/`properties`/
 * `includeChildren`, per `aemGetJsonArgsSchema`) are the only per-call input
 * this executor accepts from the SDK; none of the fields below are
 * reachable from them, and this executor has no parameter that could carry
 * an origin from tool arguments even if a caller tried to supply one.
 */
export interface CurrentAemToolContext {
  readonly origin: string;
  readonly serverId: ServerId;
  readonly serverRevision: number;
  readonly navigationEpoch: number;
  readonly chatId: ChatId;
  readonly turnId: TurnId;
}

export interface AemGetJsonExecutorConfig<TRuntimeDeps extends Record<string, unknown>> {
  /**
   * The real `executeAemGetJson` (or, in tests, a fake with the same
   * shape). `TRuntimeDeps` is inferred from `runtimeDeps` below rather than
   * declared here, so this module never asserts a concrete type for
   * `AemGetJsonDeps` and cannot drift from it.
   */
  readonly execute: (
    envelope: AemGetJsonRequestEnvelope,
    deps: { readonly origin: string } & TRuntimeDeps,
  ) => Promise<ToolResult>;
  /** Everything `execute` needs besides `origin`, which this module binds itself from `currentContext()`. */
  readonly runtimeDeps: TRuntimeDeps;
  readonly currentContext: () => CurrentAemToolContext;
  /** Used only to compute the envelope's absolute `deadlineMs` (`computeDeadline`). */
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

/**
 * Renders a successful `ToolResult` into the exact shape the SDK's own
 * `isToolResultObject()` (`dist/cjs/session.js`) requires before it will
 * treat a handler's return value as structured rather than falling back to
 * `JSON.stringify(rawResult)` (docs/compatibility.md 5.3). `resultType` is
 * mandatory here even though the wire schema marks it optional - the
 * compiled JS is stricter than the type declarations, and the JS is what
 * runs.
 *
 * There is no failure counterpart in this module: a failing `ToolResult` (or
 * a validation/envelope/thrown failure of this executor's own) is returned
 * as `err(ToolError)` instead (see `createAemGetJsonExecutor` below) so
 * `sdkAgentService.ts`'s `wrapToolExecutor` can build both the UI-visible
 * failed `tool.result` and this same rendered text from one shared
 * `ToolError`, rather than this module rendering text that adapter would
 * then have to re-derive or discard.
 */
function toSuccessPayload(result: ToolSuccess): JsonValue {
  return {
    textResultForLlm: renderToolResultForModel(result),
    resultType: 'success',
  };
}

function firstIssueMessage(
  issues: readonly { readonly message: string }[],
  fallback: string,
): string {
  const message = issues[0]?.message;
  return message !== undefined && message.length > 0 ? message.slice(0, 500) : fallback;
}

/**
 * Builds and re-validates the request envelope shared by every AEM tool.
 *
 * Returns the whole `ToolRequestEnvelope` union rather than the caller's
 * specific arm: narrowing it here would need a cast, because a discriminated
 * union cannot be narrowed by a value the compiler only knows as
 * `ToolOperation`. Each caller instead re-checks `envelope.operation` against
 * its own literal, which costs one branch and keeps this file cast-free.
 */
function buildValidatedEnvelope(
  operation: ToolOperation,
  args: unknown,
  current: CurrentAemToolContext,
  requestId: RequestId,
  clock: Clock,
): Result<ToolRequestEnvelope, ToolError> {
  const candidateEnvelope = {
    operation,
    requestId,
    chatId: current.chatId,
    turnId: current.turnId,
    serverId: current.serverId,
    serverRevision: current.serverRevision,
    navigationEpoch: current.navigationEpoch,
    deadlineMs: computeDeadline(clock),
    args,
  };
  const parsedEnvelope = toolRequestEnvelopeSchema.safeParse(candidateEnvelope);
  if (!parsedEnvelope.success) {
    // Every field above is either already-validated `args` or an
    // application-owned value, so a failure here is a bug in this module,
    // not a model-input problem - still rendered as a readable failure
    // rather than thrown, for the same reason as every other branch.
    return err(
      createToolError(
        'UNEXPECTED_RESPONSE',
        firstIssueMessage(parsedEnvelope.error.issues, 'Failed to build an AEM request.'),
        requestId,
      ),
    );
  }
  return ok(parsedEnvelope.data);
}

/**
 * Builds the `AemToolExecutor` `sdkAgentService.ts` registers for
 * `aem_get_json`.
 *
 * Order of operations, and why:
 * 1. An already-aborted `context.signal` is honoured before anything else -
 *    no validation, no envelope, no call to `config.execute`.
 * 2. The model's own `args` are validated with `aemGetJsonArgsSchema` before
 *    any other step, because they are untrusted input
 *    (requirements-decisions.md section 2).
 * 3. The AEM target and every other envelope field the model does not
 *    supply are read from `config.currentContext()`, never from `args`.
 * 4. The resulting envelope is itself re-validated with
 *    `toolRequestEnvelopeSchema` before being handed to `config.execute`.
 *
 * This function never *throws* for an expected failure, but it also no
 * longer resolves every branch the same way: success resolves `ok(payload)`
 * with this module's own rendered `{ textResultForLlm, resultType: "success" }`
 * (`toSuccessPayload`); every failure - validation, envelope-build, a
 * domain failure from `config.execute`, or a caught exception from it -
 * resolves `err(ToolError)` instead. That `ToolError` is this executor's
 * only failure output; `sdkAgentService.ts`'s `wrapToolExecutor` is what
 * turns it into both the UI-visible failed `tool.result` (built from the
 * untouched `ToolError`) and the model-facing rendered text (via the same
 * `renderToolResultForModel` this module uses for success), from that one
 * shared value. Returning `err(...)` here is not "throwing" in the sense
 * that loses information - the caller (`wrapToolExecutor`) still renders it
 * in full; only an actual JS exception thrown out of this function would
 * lose the code/`requiredAction`/requestId, which is why every branch below
 * still resolves rather than throwing.
 */
export function createAemGetJsonExecutor<TRuntimeDeps extends Record<string, unknown>>(
  config: AemGetJsonExecutorConfig<TRuntimeDeps>,
): AemToolExecutor {
  return async (args, context) => {
    if (context.signal?.aborted === true) {
      const requestId = newRequestId(config.idGenerator);
      return err(
        createToolError('CANCELLED', 'The request was cancelled before it started.', requestId),
      );
    }

    const parsedArgs = aemGetJsonArgsSchema.safeParse(args);
    if (!parsedArgs.success) {
      const requestId = newRequestId(config.idGenerator);
      return err(
        createToolError(
          'INVALID_ARGUMENT',
          firstIssueMessage(parsedArgs.error.issues, 'Invalid aem_get_json arguments.'),
          requestId,
        ),
      );
    }

    // Bound here, from the application's own current context - never from
    // `args` above, whose schema has no origin-shaped field and is not
    // consulted again past this point.
    const current = config.currentContext();
    const requestId = newRequestId(config.idGenerator);
    const built = buildValidatedEnvelope(
      'aem_get_json',
      parsedArgs.data,
      current,
      requestId,
      config.clock,
    );
    if (!built.ok) return err(built.error);

    const envelope = built.value;
    if (envelope.operation !== 'aem_get_json') {
      // Unreachable: the literal passed above and the schema's discriminant
      // are the same field, so a successful parse cannot change it. Handled
      // instead of asserted so a change to this file that broke that
      // invariant would still fail closed with a readable message rather
      // than a thrown type error.
      return err(
        createToolError(
          'UNEXPECTED_RESPONSE',
          'Internal error: unexpected tool envelope shape.',
          requestId,
        ),
      );
    }

    try {
      const result = await config.execute(envelope, {
        ...config.runtimeDeps,
        origin: current.origin,
      });
      if (!result.ok) return err(result.error);
      return ok(toSuccessPayload(result));
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message.slice(0, 500) : 'AEM request failed.';
      return err(createToolError('UNEXPECTED_RESPONSE', message, requestId));
    }
  };
}

/** The `aem_query` arm of `ToolRequestEnvelope` - the only member this executor builds. */
export type AemQueryRequestEnvelope = Extract<ToolRequestEnvelope, { operation: 'aem_query' }>;

/** The key `sdkAgentService.ts`'s `SdkAgentServiceOptions.toolHandlers` must register this executor under. */
export const AEM_QUERY_TOOL_NAME: string = AEM_QUERY_TOOL_DESCRIPTOR.name;

export interface AemQueryExecutorConfig<TRuntimeDeps extends Record<string, unknown>> {
  /** The real `executeAemQuery` (or, in tests, a fake with the same shape). */
  readonly execute: (
    envelope: AemQueryRequestEnvelope,
    deps: { readonly origin: string } & TRuntimeDeps,
  ) => Promise<ToolResult>;
  readonly runtimeDeps: TRuntimeDeps;
  readonly currentContext: () => CurrentAemToolContext;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

/**
 * Builds the `AemToolExecutor` `sdkAgentService.ts` registers for
 * `aem_query` (implementation-plan.md step 08).
 *
 * Structurally identical to {@link createAemGetJsonExecutor}, and
 * deliberately so: the same abort-first ordering, the same
 * validate-args-before-anything-else rule, the same application-bound
 * envelope, and the same `err(ToolError)`-not-throw failure discipline. The
 * only differences are which schema validates the arguments and which
 * operation the envelope names - in particular, this executor has no
 * parameter that could carry an endpoint, origin, or URL from tool
 * arguments, exactly as the get-json one has none that could carry an
 * origin.
 */
export function createAemQueryExecutor<TRuntimeDeps extends Record<string, unknown>>(
  config: AemQueryExecutorConfig<TRuntimeDeps>,
): AemToolExecutor {
  return async (args, context) => {
    if (context.signal?.aborted === true) {
      const requestId = newRequestId(config.idGenerator);
      return err(
        createToolError('CANCELLED', 'The request was cancelled before it started.', requestId),
      );
    }

    const parsedArgs = aemQueryArgsSchema.safeParse(args);
    if (!parsedArgs.success) {
      const requestId = newRequestId(config.idGenerator);
      return err(
        createToolError(
          'INVALID_ARGUMENT',
          firstIssueMessage(parsedArgs.error.issues, 'Invalid aem_query arguments.'),
          requestId,
        ),
      );
    }

    const current = config.currentContext();
    const requestId = newRequestId(config.idGenerator);
    const built = buildValidatedEnvelope(
      'aem_query',
      parsedArgs.data,
      current,
      requestId,
      config.clock,
    );
    if (!built.ok) return err(built.error);

    const envelope = built.value;
    if (envelope.operation !== 'aem_query') {
      return err(
        createToolError(
          'UNEXPECTED_RESPONSE',
          'Internal error: unexpected tool envelope shape.',
          requestId,
        ),
      );
    }

    try {
      const result = await config.execute(envelope, {
        ...config.runtimeDeps,
        origin: current.origin,
      });
      if (!result.ok) return err(result.error);
      return ok(toSuccessPayload(result));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message.slice(0, 500) : 'AEM query failed.';
      return err(createToolError('UNEXPECTED_RESPONSE', message, requestId));
    }
  };
}

/**
 * Bundled base instruction appended via `HardenedToolPolicy.instructions`
 * (toolPolicy.ts) for a real AEM session. Framed narrowly and consistently
 * with `AEM_GET_JSON_TOOL_DESCRIPTOR`'s own description: read-only, one
 * tool, no invented capability.
 */
export const AEM_ASSISTANT_INSTRUCTIONS =
  'You are a read-only assistant for Adobe Experience Manager (AEM) content authors. ' +
  "The only external capabilities available to you are the 'aem_get_json' tool, which reads " +
  "JCR/Sling node data from the AEM instance the user currently has open, and the 'aem_query' " +
  'tool, which runs a QueryBuilder search against that same instance. You cannot write, ' +
  "delete, or otherwise modify anything in AEM through this session. Use 'aem_get_json' when " +
  "you already know the path and 'aem_query' when you need to find nodes you cannot name. A " +
  "query returns one page at a time: to see further results, call 'aem_query' again with a " +
  "higher 'offset', and never present one page as the complete set of matches. If the tool " +
  "reports an error, read its message and 'requiredAction' and explain them to the user rather " +
  'than retrying the identical request blindly.';

/**
 * The allowlist entry `aem_get_json` is registered under
 * (`HardenedToolPolicy.availableTools`), in the source-qualified syntax
 * `toolPolicy.ts`'s `allowlistEntryMatches` and the SDK's own
 * `validateToolFilterList` both expect.
 */
export const AEM_GET_JSON_ALLOWLIST_ENTRY = 'custom:aem_get_json';

/** The `aem_query` counterpart of {@link AEM_GET_JSON_ALLOWLIST_ENTRY}. */
export const AEM_QUERY_ALLOWLIST_ENTRY = 'custom:aem_query';

/**
 * Builds the `HardenedToolPolicy` for a real AEM session: allows exactly the
 * two custom tools this module registers, supplies the bundled base
 * instruction through `instructions`, and points `skillDirectories` at the
 * application's own bundled skills when one is supplied.
 *
 * `bundledSkillDirectories` is a parameter rather than something this module
 * resolves itself: the location depends on whether the app is packaged
 * (`process.resourcesPath`) or running from source, which is composition
 * knowledge that belongs in `src/main`, not here. Omitting it leaves
 * `enableSkills` at its hardened `false` default (toolPolicy.ts), so skills
 * are never enabled by accident.
 */
export function buildAemToolPolicy(
  bundledSkillDirectories?: readonly string[],
): HardenedToolPolicy {
  const base = {
    availableTools: [AEM_GET_JSON_ALLOWLIST_ENTRY, AEM_QUERY_ALLOWLIST_ENTRY],
    instructions: AEM_ASSISTANT_INSTRUCTIONS,
  };
  return bundledSkillDirectories !== undefined && bundledSkillDirectories.length > 0
    ? { ...base, bundledSkillDirectories }
    : base;
}
