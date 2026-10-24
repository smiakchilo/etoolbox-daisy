import type { z } from 'zod';
import { createToolError, newRequestId } from '../../contracts';
import type {
  IdGenerator,
  JsonValue,
  RequestId,
  ToolCallId,
  ToolError,
  UserInputAnswer,
  UserInputRequest,
} from '../../contracts';
import { type Result, err, ok } from '../../result';
import type { DomReadSpec } from '../../contracts/webviewBridge';
import type { MemoHost } from '../../memos';
import type { SkillHost } from '../../skills';
import { computeDeadline, type ToolEnvelopeBase } from './envelope';
import type { EnvironmentFacts } from './environment';
import type { AnswerRequest, AnswerResult } from './answer';
import type { PageAuditRunner } from './pageAudit';
import type { ConfiguredHostInfo, OpenPageOutcome, OpenPageTarget } from './navigation';
import type { AemResponseOutcome } from './responseValidation';
import type {
  BridgeRequestOptions,
  BrokerOutcome,
  CurrentToolContext,
  ToolDescriptor,
  ToolExecutor,
} from './types';
import { firstIssueMessage } from './validationIssue';

/**
 * The plugin contract. A tool is one folder, `src/tools/<name>/`, whose
 * `tool.ts` exports a {@link ToolModule} named `tool`; the main-process
 * registry discovers it by glob. Nothing else in the application names a tool.
 */

/** The per-call context the SDK hands an executor: its tool-call id and abort signal. */
export type ToolExecutionContext = Parameters<ToolExecutor>[1];

/**
 * A closed vocabulary of semantic diagnostics a tool may report beyond a
 * response classification - outcomes the application wants in its log but
 * never shows the user. Kept in `src/shared` (a tool folder may import only
 * the shared barrel) and deliberately tiny: the one code today is a failed
 * background count.
 */
export type ToolDiagnosticCode = 'AEM_COUNT_FAILED';

/**
 * What a tool may ask of the application at run time. Deliberately small: a
 * tool cannot reach the session, the settings or the window, and it reaches
 * another tool only through {@link ToolHost.invokeTool}, and only a tool it
 * declared in its own `uses` list.
 */
export interface ToolHost {
  readonly bridge: {
    /**
     * One authenticated read through the browser pane. `envelope` is the request
     * the broker guards (deadline, server revision, navigation epoch); `url`
     * is the same-origin path the tool built.
     */
    request(
      envelope: ToolEnvelopeBase,
      url: string,
      options?: BridgeRequestOptions,
    ): Promise<BrokerOutcome>;
    /**
     * Reads elements from the document the pane is showing (selector in, text
     * or markup out). Optional so a test fake need not model it; the live
     * broker always supplies it. Resolves a JSON `response` outcome carrying a
     * `WebviewBridgeDomResult`.
     */
    readDom?(envelope: ToolEnvelopeBase, spec: DomReadSpec): Promise<BrokerOutcome>;
  };
  /** Read fresh on every call; the model can never influence it. */
  readonly currentContext: () => CurrentToolContext;
  /**
   * The facts of the host the browser pane is currently on - its origin and
   * its effective content/component/DAM roots - or `undefined` when the live URL
   * does not match a configured host. Read fresh on every call; like
   * {@link currentContext}, the model can never influence it.
   */
  readonly environmentFacts: () => EnvironmentFacts | undefined;
  /**
   * Every configured host, as the model may see it: label, origin and effective
   * roots. Read fresh on every call, so a host added, renamed or re-rooted in
   * Settings is visible immediately. The model reads origins from here; it
   * never supplies one.
   */
  readonly configuredHosts: () => readonly ConfiguredHostInfo[];
  /**
   * Opens a page on a configured host in the browser pane. The origin is
   * resolved by the application from `target.serverId` - the model supplies a
   * host *label*, which the tool maps to this id - so no origin, scheme or
   * port can reach the pane from a tool argument. The path is re-validated
   * here even though the tool already validated it.
   */
  readonly openPage: (target: OpenPageTarget) => Promise<OpenPageOutcome>;
  /**
   * Puts an interactive question to the user and resolves with their answer.
   *
   * This is the one capability a tool needs that is neither an AEM read nor a
   * value the model supplies: an `ask_user` tool blocks on it while the user
   * chooses. The application resolves it from the live chat turn (never from
   * the model's arguments) and rejects it - the returned promise rejects - if
   * the turn is aborted or torn down before the user answers.
   */
  readonly requestUserInput: (request: UserInputRequest) => Promise<UserInputAnswer>;
  /**
   * Optional: one **stateless model call** on the active agent, for a tool that
   * must ask the model for a verdict it cannot compute itself (the semantic
   * search asks the active agent about each hit page this way). It runs outside the chat session -
   * no conversation history, no tools, no skills, no transcript events - with
   * the active provider/model/proxy, and returns one true/false per item.
   *
   * The capability is optional only so an agent that cannot make such a call
   * can exist; the app wires it for Copilot, OpenRouter and the fake. A tool
   * that needs it reports `AGENT_UNAVAILABLE` when it is absent.
   *
   * It is one *capability* over the reusable secondary-turn routine
   * (`AgentRuntime.complete`, `src/shared/agents/oneShot.ts`): the tokens it
   * spends are counted in the chat's totals by construction. A tool that asks the
   * model something else adds its own capability beside this one, not a new
   * agent method.
   */
  readonly answer?: (
    request: AnswerRequest,
    signal: AbortSignal | undefined,
  ) => Promise<AnswerResult>;
  /**
   * One request to a host the browser pane is not on, made by the application
   * itself with **no cookies and no session**. The application, not the tool,
   * enforces the limits (http/https only, redirect and size caps, no private or
   * loopback addresses), and reports a refusal as a `blocked` outcome. Absent in
   * a host that offers no outside access.
   */
  readonly externalFetch?: (
    url: string,
    options: BridgeRequestOptions,
    signal: AbortSignal | undefined,
  ) => Promise<BrokerOutcome>;
  /**
   * Audits one page with Lighthouse and returns its scores and failing audits.
   * The application runs it in a hidden browser window it owns: a configured
   * host's page loads with the pane's session, any other page without cookies
   * and only if it passes the same address policy as `externalFetch`. Absent
   * in a host that cannot audit pages.
   */
  readonly pageAudit?: PageAuditRunner;
  /**
   * The skills the application loaded (bundled and the user's): the one way a
   * skill tool reaches a skill's body, its files or its scripts. The model
   * names a skill and a path relative to it; the application resolves both and
   * never lets either leave the skill's own folder.
   */
  readonly skills: SkillHost;
  /**
   * Optional: the memo store - the `memo` tool writes a self-learning lesson
   * through it. The application decides the file, the folder and the stamp;
   * the tool supplies only the title, text, trigger and optional skill.
   */
  readonly memos?: MemoHost;
  readonly clock: () => number;
  readonly idGenerator: IdGenerator;
  /**
   * Optional diagnostics sink: records how a tool classified the finished HTTP
   * response (`AemResponseOutcome['kind']`), so `logs/tools.log` stops reading
   * a `200` that carried no usable JSON as an outright success. Diagnostics
   * only - it never influences a tool's result.
   */
  readonly recordResponseClassification?: (
    requestId: RequestId,
    kind: AemResponseOutcome['kind'],
  ) => void;
  /**
   * Optional progress sink for a tool that can take a while: a short,
   * human-readable note (e.g. "Reading 12 of 20") the renderer shows on the
   * running tool call's billet, so a long read is visibly working. `toolCallId`
   * is the calling tool's own `ToolExecutionContext.toolCallId` - the note is
   * attached to that call, not invented. UX only: it never affects the result,
   * it is never journaled, and a tool that omits it simply shows no progress.
   */
  readonly reportToolProgress?: (toolCallId: ToolCallId, text: string) => void;
  /**
   * Optional: adds one-click `actions` (button labels) to the `ask_user`
   * question this turn currently has pending, for an action whose availability
   * is only decided while the question is up (the search's "Load all", once its
   * exact total settles). UX only and best effort: it is a no-op when no
   * question is pending (already answered, turn over), it is never journaled,
   * and a tool that omits it simply offers the action on its next question. The
   * caller must still validate an answer that selects such an action.
   */
  readonly addUserInputActions?: (actions: readonly string[]) => void;
  /**
   * Optional diagnostics sink for a semantic outcome a tool reaches that is
   * not a response classification and never reaches the user. Today its one
   * code is `AEM_COUNT_FAILED`: the background honest-count a search may run
   * did not prove an exact total, so the table silently keeps its capped
   * fallback. Diagnostics only - it never affects a tool's result.
   */
  readonly reportToolDiagnostic?: (code: ToolDiagnosticCode) => void;
  /**
   * Runs another enabled tool's executor directly - the tool-to-tool bridge. A
   * composite tool uses it to chain tools deterministically instead of relying
   * on the model to relay one tool's JSON into the next.
   *
   * `name` must be listed in the caller's `uses` list; a tool may
   * not call itself, and nesting is depth-limited. `parent` is the caller's own
   * execution context: its abort signal is passed through, so a Stop cancels
   * the nested call too. The nested call is shown in the transcript and the
   * chat journal like a call the model made. It resolves `err(ToolError)` -
   * never throws - when the target is undeclared, missing or disabled.
   */
  readonly invokeTool: (
    name: string,
    args: Readonly<Record<string, JsonValue>>,
    parent: ToolExecutionContext,
  ) => Promise<Result<JsonValue, ToolError>>;
}

/**
 * The application-supplied part of a {@link ToolHost}: everything except
 * `invokeTool`, which the registry binds per calling tool.
 */
export type ToolHostServices = Omit<ToolHost, 'invokeTool'>;

/** What every tool declares, whether or not the model may call it. */
interface ToolModuleBase {
  readonly name: string;
  /**
   * Turns the tool off without deleting it: a disabled tool is still
   * type-checked, but is never registered, allowlisted, or described to the
   * model.
   */
  readonly disabled?: boolean;
  /**
   * The other tools this one calls through {@link ToolHost.invokeTool}. A
   * composite ("synthetic") tool declares its parts here; a call to any tool
   * not listed is refused.
   */
  readonly uses?: readonly string[];
  /**
   * A composite whose parts are an implementation detail: the calls it makes
   * through {@link ToolHost.invokeTool} are not reported to the chat, so no
   * nested billet appears (`aem_get_json` over `http_fetch`).
   */
  readonly transparent?: boolean;
  readonly createExecutor: (host: ToolHost) => ToolExecutor;
}

/**
 * A tool the model may call: it must describe itself and carry the allowlist
 * entry the policy grants. `internal` is absent (or `false`).
 */
export interface ModelToolModule extends ToolModuleBase {
  readonly internal?: false;
  readonly descriptor: ToolDescriptor;
  /** The source-qualified allowlist entry (`custom:<name>`) the policy grants. */
  readonly allowlistEntry: string;
  /** One paragraph telling the model when to use this tool; joined into the session instructions. */
  readonly instructions: string;
}

/**
 * A building block for other tools, not a tool for the model: it is callable
 * only through {@link ToolHost.invokeTool} by a tool that lists it in `uses`,
 * and is never handed to the agent, allowlisted, or described to the model -
 * so it needs no descriptor, allowlist entry or instructions. Its calls are
 * still journaled and rendered like any other tool call.
 */
export interface InternalToolModule extends ToolModuleBase {
  readonly internal: true;
}

/**
 * The plugin contract, as it is actually used: either a {@link ModelToolModule}
 * (the model may call it) or an {@link InternalToolModule} (only another tool
 * reaches it, through `invokeTool`).
 */
export type ToolModule = ModelToolModule | InternalToolModule;

/** A tool's own `execute` outcome: its success shape (tagged with `operation`) or an error. */
export type ToolOutcome<TSuccess extends { readonly ok: true; readonly operation: string }> =
  TSuccess | { readonly ok: false; readonly error: ToolError };

export interface ToolExecutorSpec<
  TEnvelope extends ToolEnvelopeBase,
  TSuccess extends { readonly ok: true; readonly operation: string },
  TRuntimeDeps extends Record<string, unknown>,
> {
  readonly operation: string;
  readonly argsSchema: z.ZodType;
  readonly requestSchema: z.ZodType<TEnvelope>;
  readonly render: (success: TSuccess) => string;
  /** Overrides the default { textResultForLlm, resultType } payload, e.g. to keep structured fields for the transcript. */
  readonly toPayload?: (success: TSuccess) => JsonValue;
  readonly execute: (
    envelope: TEnvelope,
    deps: { readonly origin: string } & TRuntimeDeps,
  ) => Promise<ToolOutcome<TSuccess>>;
  readonly runtimeDeps: TRuntimeDeps;
  readonly currentContext: () => CurrentToolContext;
  readonly clock: () => number;
  readonly idGenerator: IdGenerator;
  /** Message used when the executor throws something that is not an `Error`. */
  readonly failureFallbackMessage: string;
}

/**
 * The executor every read tool shares. Order of operations: an already-aborted
 * signal is honoured first; the model's untrusted `args` are validated next;
 * the target and every other envelope field the model does not supply come from
 * `currentContext()`; the resulting envelope is re-validated before it reaches
 * `execute`. Success resolves the rendered
 * `{ textResultForLlm, resultType: "success" }` payload; every failure resolves
 * `err(ToolError)` rather than throwing.
 */
export function createToolExecutor<
  TEnvelope extends ToolEnvelopeBase,
  TSuccess extends { readonly ok: true; readonly operation: string },
  TRuntimeDeps extends Record<string, unknown>,
>(spec: ToolExecutorSpec<TEnvelope, TSuccess, TRuntimeDeps>): ToolExecutor {
  return async (args, context) => {
    if (context.signal?.aborted === true) {
      const requestId = newRequestId(spec.idGenerator);
      return err(
        createToolError('CANCELLED', 'The request was cancelled before it started', requestId),
      );
    }

    const parsedArgs = spec.argsSchema.safeParse(args);
    if (!parsedArgs.success) {
      const requestId = newRequestId(spec.idGenerator);
      return err(
        createToolError(
          'INVALID_ARGUMENT',
          firstIssueMessage(parsedArgs.error.issues, `Invalid ${spec.operation} arguments`),
          requestId,
        ),
      );
    }

    const current = spec.currentContext();
    const requestId = newRequestId(spec.idGenerator);
    const candidate = {
      operation: spec.operation,
      requestId,
      chatId: current.chatId,
      turnId: current.turnId,
      serverId: current.serverId,
      serverRevision: current.serverRevision,
      navigationEpoch: current.navigationEpoch,
      deadlineMs: computeDeadline(spec.clock),
      args: parsedArgs.data,
    };
    const parsedEnvelope = spec.requestSchema.safeParse(candidate);
    if (!parsedEnvelope.success) {
      return err(
        createToolError(
          'UNEXPECTED_RESPONSE',
          firstIssueMessage(parsedEnvelope.error.issues, 'Failed to build an bridge request'),
          requestId,
        ),
      );
    }

    try {
      const result = await spec.execute(parsedEnvelope.data, {
        ...spec.runtimeDeps,
        origin: current.origin,
      });
      if (!result.ok) return err(result.error);
      if (result.operation !== spec.operation) {
        // Unreachable while `execute` is the tool's own handler; handled so a
        // future change fails closed with a readable message.
        return err(
          createToolError(
            'UNEXPECTED_RESPONSE',
            'Internal error: unexpected tool result shape',
            requestId,
          ),
        );
      }
      const payload: JsonValue = spec.toPayload?.(result) ?? {
        textResultForLlm: spec.render(result),
        resultType: 'success',
      };
      return ok(payload);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message.slice(0, 500) : spec.failureFallbackMessage;
      return err(createToolError('UNEXPECTED_RESPONSE', message, requestId));
    }
  };
}

/** How the model reads any tool's failure. Tool-agnostic: it renders the shared error taxonomy. */
export function renderToolFailureForModel(error: ToolError): string {
  const base =
    `Tool error [${error.code}]: ${error.message} ` +
    `(requestId=${error.requestId}, retryable=${String(error.retryable)}, ` +
    `requiredAction=${error.requiredAction})`;
  if (error.requiredAction !== 'sign_in_to_host') return base;
  return `${base}. ${SIGN_IN_DIRECTIVE}`;
}

/** Appended to a failure that needs a sign-in: the model must stop probing and tell the user. */
export const SIGN_IN_DIRECTIVE =
  'The host no longer recognises the user. Do not retry and do not navigate or call other tools to work around it; ' +
  'tell the user briefly that they need to sign in to the host again (the browser pane shows its sign-in page), then stop.';

/**
 * Where the enabled tools' paragraphs go inside the session-instructions
 * template (`resources/rules/session.md`): everything before it is the
 * shared framing and policy, everything after it the shared closing.
 */
export const SESSION_INSTRUCTIONS_TOOLS_PLACEHOLDER = '{{tools}}';

/**
 * Session instructions for a real browser session. The shared prose lives in a
 * markdown resource the application reads (`resources/rules/session.md`)
 * and hands in as `template`; this function only splices the enabled tools'
 * paragraphs (their instructions) in at the one {@link SESSION_INSTRUCTIONS_TOOLS_PLACEHOLDER}.
 * With no enabled tool the middle is empty and the template still states
 * plainly that no capability exists.
 *
 * A template without exactly one placeholder is a broken install: it throws, so
 * the session can never run without the read-only policy the template carries.
 */
export function composeAssistantInstructions(
  template: string,
  fragments: readonly string[],
): string {
  const parts = template.split(SESSION_INSTRUCTIONS_TOOLS_PLACEHOLDER);
  const [before, after] = parts;
  if (parts.length !== 2 || before === undefined || after === undefined) {
    throw new Error(
      `The session instructions template must contain exactly one ${SESSION_INSTRUCTIONS_TOOLS_PLACEHOLDER}`,
    );
  }
  return [before.trim(), ...fragments, after.trim()].join('\n\n');
}
