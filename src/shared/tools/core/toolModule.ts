import type { z } from 'zod';
import { createToolError, newRequestId } from '../../contracts';
import type { IdGenerator, JsonValue, RequestId, ToolError } from '../../contracts';
import { err, ok } from '../../result';
import { computeDeadline, type ToolEnvelopeBase } from './envelope';
import type { EnvironmentFacts } from './environment';
import type { AemResponseOutcome } from './responseValidation';
import type {
  AemToolExecutor,
  BrokerOutcome,
  CurrentAemToolContext,
  ToolDescriptor,
} from './types';
import { firstIssueMessage } from './validationIssue';

/**
 * The plugin contract. A tool is one folder, `src/tools/<name>/`, whose
 * `tool.ts` exports a {@link ToolModule} named `tool`; the main-process
 * registry discovers it by glob. Nothing else in the application names a tool.
 */

/**
 * What a tool may ask of the application at run time. Deliberately small: a
 * tool cannot reach the session, the settings, the window, or another tool.
 */
export interface ToolHost {
  readonly bridge: {
    /**
     * One authenticated read through the AEM pane. `envelope` is the request
     * the broker guards (deadline, server revision, navigation epoch); `url`
     * is the same-origin path the tool built.
     */
    request(envelope: ToolEnvelopeBase, url: string): Promise<BrokerOutcome>;
  };
  /** Read fresh on every call; the model can never influence it. */
  readonly currentContext: () => CurrentAemToolContext;
  /**
   * The facts of the host the browser pane is currently on - its origin and
   * its effective content/component roots - or `undefined` when the live URL
   * does not match a configured host. Read fresh on every call; like
   * {@link currentContext}, the model can never influence it.
   */
  readonly environmentFacts: () => EnvironmentFacts | undefined;
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
}

export interface ToolModule {
  readonly name: string;
  readonly descriptor: ToolDescriptor;
  /** The source-qualified allowlist entry (`custom:<name>`) the policy grants. */
  readonly allowlistEntry: string;
  /**
   * Turns the tool off without deleting it: a disabled tool is still
   * type-checked, but is never registered, allowlisted, or described to the
   * model.
   */
  readonly disabled?: boolean;
  /** One paragraph telling the model when to use this tool; joined into the session instructions. */
  readonly instructions: string;
  readonly createExecutor: (host: ToolHost) => AemToolExecutor;
}

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
  readonly currentContext: () => CurrentAemToolContext;
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
>(spec: ToolExecutorSpec<TEnvelope, TSuccess, TRuntimeDeps>): AemToolExecutor {
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
          firstIssueMessage(parsedEnvelope.error.issues, 'Failed to build an AEM request'),
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
  return (
    `AEM tool error [${error.code}]: ${error.message} ` +
    `(requestId=${error.requestId}, retryable=${String(error.retryable)}, ` +
    `requiredAction=${error.requiredAction})`
  );
}

/** The shared, read-only framing that opens every session's instructions. */
export const AEM_ASSISTANT_INSTRUCTIONS_PREFIX =
  'You are a read-only assistant for Adobe Experience Manager (AEM) content authors. ' +
  'Each user prompt begins with a current-page context block the application supplies: it ' +
  "names the AEM host, that host's content roots and component roots, and, when available, " +
  'the JCR content path of the page currently open in the browser pane. Treat references ' +
  "such as 'this page', 'here', 'this host', and 'this instance' as that context, and a " +
  'request that names no path or server as targeting it - do not ask the user to restate ' +
  'where they are. Scope content searches to the content roots and component searches to the ' +
  'component roots named above. The only external capabilities available to you are the tools ' +
  'described next, and they act on the AEM instance the user currently has open.';

/**
 * The read-only, no-side-channel policy every session carries, whether or not
 * any skill is loaded. This used to live in the on-demand `aem-tool-selection`
 * skill; it moved here because a skill is only read when the model chooses to
 * load it, so it could never *guarantee* an invariant that must always hold.
 */
export const AEM_ASSISTANT_INSTRUCTIONS_POLICY =
  'This session is strictly read-only against AEM: there is no tool to create, update, ' +
  'delete, move, copy, reorder, version, replicate, activate, deactivate, publish, unpublish, ' +
  'roll out, package, or change users or permissions. Never attempt to reach AEM by any other ' +
  'route - not /crx or CRXDE, Package Manager, the Sling POST servlet, curl, shell commands, ' +
  'files, or any external tool or server - and do not suggest them. If the user asks for a ' +
  'change, say that the application is read-only against AEM and offer to gather the ' +
  'information that would support the change. The application binds every request to the AEM ' +
  'instance open in the browser pane: never put a host, scheme, port, or full URL into a tool ' +
  'argument.';

/** The shared closing on error handling. */
export const AEM_ASSISTANT_INSTRUCTIONS_SUFFIX =
  'If a tool reports an error, read its message and ' +
  "'requiredAction' and explain them to the user rather than retrying the identical request " +
  'blindly.';

/**
 * Session instructions for a real AEM session: the shared, read-only framing,
 * then one paragraph per enabled tool (its instructions), then the shared
 * closing on error handling. With no enabled tool the middle is empty and the
 * text still states plainly that no capability exists.
 */
export function composeAssistantInstructions(fragments: readonly string[]): string {
  return [
    AEM_ASSISTANT_INSTRUCTIONS_PREFIX,
    AEM_ASSISTANT_INSTRUCTIONS_POLICY,
    ...fragments,
    AEM_ASSISTANT_INSTRUCTIONS_SUFFIX,
  ].join(' ');
}
