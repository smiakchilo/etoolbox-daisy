import { z } from 'zod';
import {
  type AemToolExecutor,
  type CurrentAemToolContext,
  type EnvironmentFacts,
  type IdGenerator,
  type JsonValue,
  type RequestId,
  type RequiredAction,
  type ToolDescriptor,
  type ToolErrorCode,
  type ToolOutcome,
  createToolExecutor,
  envelopeCommonShape,
  originSchema,
  requestIdSchema,
} from '../../shared';

/**
 * The `aem_environment_facts` tool, self-contained.
 *
 * Reports where content and components live on the AEM instance the browser
 * pane is currently on: the host origin and its effective content/component
 * roots. The facts are resolved by the application from the live pane URL and
 * the settings document (see `ToolHost.environmentFacts`), so this tool takes
 * no arguments - the model can never name the host. It performs no AEM request.
 */

export const aemEnvironmentFactsArgsSchema = z.object({}).strict();

export type AemEnvironmentFactsArgs = z.infer<typeof aemEnvironmentFactsArgsSchema>;

export const AEM_ENVIRONMENT_FACTS_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: 'aem_environment_facts',
  description:
    'Reports where content and components live on the AEM instance the browser pane is ' +
    'currently on: the host origin, the content root(s) to scope content searches to, and the ' +
    'component root(s) for component questions. Content roots default to `/content` and ' +
    'component roots to `/apps` when the host configures none. Takes no arguments - the ' +
    'application supplies the current host and its roots.',
  parameters: z.toJSONSchema(aemEnvironmentFactsArgsSchema, { io: 'input' }),
};

/** The key `sdkAgentService.ts`'s `toolHandlers` registers this executor under. */
export const AEM_ENVIRONMENT_FACTS_TOOL_NAME: string = AEM_ENVIRONMENT_FACTS_TOOL_DESCRIPTOR.name;

/** The `aem_environment_facts` allowlist entry. */
export const AEM_ENVIRONMENT_FACTS_ALLOWLIST_ENTRY = 'custom:aem_environment_facts';

export const aemEnvironmentFactsRequestSchema = z
  .object({
    operation: z.literal('aem_environment_facts'),
    ...envelopeCommonShape,
    args: aemEnvironmentFactsArgsSchema,
  })
  .strict();

export type AemEnvironmentFactsRequest = z.infer<typeof aemEnvironmentFactsRequestSchema>;

export const aemEnvironmentFactsSuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('aem_environment_facts'),
    requestId: requestIdSchema,
    sourceOrigin: originSchema,
    contentRoots: z.array(z.string().min(1)),
    componentRoots: z.array(z.string().min(1)),
    fetchedAt: z.number().int().nonnegative(),
  })
  .strict();

export type AemEnvironmentFactsSuccess = z.infer<typeof aemEnvironmentFactsSuccessSchema>;

export type AemEnvironmentFactsResult = ToolOutcome<AemEnvironmentFactsSuccess>;

export function renderEnvironmentFactsSuccess(result: AemEnvironmentFactsSuccess): string {
  return [
    `AEM environment facts for ${result.sourceOrigin}`,
    `Content roots: ${result.contentRoots.join(', ')}`,
    `Component roots: ${result.componentRoots.join(', ')}`,
  ].join('\n');
}

/**
 * The full structured success *plus* the SDK's render fields, so the transcript
 * can render the facts from the result itself - the default read-tool payload
 * (`{ textResultForLlm, resultType }`) carries nothing the renderer can read.
 * Mirrors `aem_create_page`'s `toSuccessPayload`.
 */
function toSuccessPayload(result: AemEnvironmentFactsSuccess): JsonValue {
  return {
    ...result,
    textResultForLlm: renderEnvironmentFactsSuccess(result),
    resultType: 'success',
  };
}

const ERROR_MESSAGES = {
  unmatched_host:
    'The browser pane is not on a configured AEM host, so its environment facts are unknown. ' +
    'Open the AEM instance in the browser pane, or add its address in Settings, then try again',
} as const;

type ErrorMessageKey = keyof typeof ERROR_MESSAGES;

interface ErrorMapping {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly requiredAction: RequiredAction;
}

const ERROR_MAPPINGS: Readonly<Record<ErrorMessageKey, ErrorMapping>> = {
  unmatched_host: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'select_server' },
};

function toolError(key: ErrorMessageKey, requestId: RequestId): AemEnvironmentFactsResult {
  const mapping = ERROR_MAPPINGS[key];
  return {
    ok: false,
    error: {
      code: mapping.code,
      message: ERROR_MESSAGES[key],
      requestId,
      retryable: mapping.retryable,
      requiredAction: mapping.requiredAction,
    },
  };
}

export interface AemEnvironmentFactsDeps {
  readonly origin: string;
  readonly environmentFacts: () => EnvironmentFacts | undefined;
  readonly now: () => number;
}

export function executeAemEnvironmentFacts(
  envelope: AemEnvironmentFactsRequest,
  deps: AemEnvironmentFactsDeps,
): Promise<AemEnvironmentFactsResult> {
  const facts = deps.environmentFacts();
  if (facts === undefined) {
    return Promise.resolve(toolError('unmatched_host', envelope.requestId));
  }
  return Promise.resolve({
    ok: true,
    operation: 'aem_environment_facts',
    requestId: envelope.requestId,
    sourceOrigin: facts.origin,
    contentRoots: [...facts.contentRoots],
    componentRoots: [...facts.componentRoots],
    fetchedAt: deps.now(),
  });
}

export interface AemEnvironmentFactsExecutorConfig<TRuntimeDeps extends Record<string, unknown>> {
  readonly execute: (
    envelope: AemEnvironmentFactsRequest,
    deps: { readonly origin: string } & TRuntimeDeps,
  ) => Promise<AemEnvironmentFactsResult>;
  readonly runtimeDeps: TRuntimeDeps;
  readonly currentContext: () => CurrentAemToolContext;
  readonly clock: () => number;
  readonly idGenerator: IdGenerator;
}

export function createAemEnvironmentFactsExecutor<TRuntimeDeps extends Record<string, unknown>>(
  config: AemEnvironmentFactsExecutorConfig<TRuntimeDeps>,
): AemToolExecutor {
  return createToolExecutor({
    operation: 'aem_environment_facts',
    argsSchema: aemEnvironmentFactsArgsSchema,
    requestSchema: aemEnvironmentFactsRequestSchema,
    render: renderEnvironmentFactsSuccess,
    toPayload: toSuccessPayload,
    failureFallbackMessage: 'AEM environment facts could not be read',
    ...config,
  });
}
