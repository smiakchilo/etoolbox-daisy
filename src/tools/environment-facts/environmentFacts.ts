import { z } from 'zod';
import {
  type AemToolExecutor,
  type JsonValue,
  type RequestId,
  type Result,
  type ToolDescriptor,
  type ToolError,
  type ToolErrorCode,
  type ToolHost,
  createToolError,
  err,
  newRequestId,
  ok,
  originSchema,
  originsMatch,
  requestIdSchema,
} from '../../shared';

/**
 * The `environment_facts` tool, self-contained.
 *
 * Reports the AEM environments the application knows about: every configured
 * host as a label, an origin and its effective content/component roots, with
 * the host the browser pane is currently on flagged. The facts are resolved by
 * the application from the settings document and the live pane URL (see
 * `ToolHost.configuredHosts` / `ToolHost.environmentFacts`), so this tool takes
 * no arguments - the model can never name a host. It performs no AEM request.
 *
 * Hand-rolled rather than built on `createToolExecutor`: that builder binds an
 * AEM envelope to a live server, but this tool must still list the configured
 * hosts when the pane is on an unmatched origin (or nothing at all).
 */

export const environmentFactsArgsSchema = z.object({}).strict();

export type EnvironmentFactsArgs = z.infer<typeof environmentFactsArgsSchema>;

export const ENVIRONMENT_FACTS_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: 'environment_facts',
  description:
    'Reports the AEM environments the application knows about: every configured host with its ' +
    'label, its origin, and the content/component roots to scope searches to, marking the host ' +
    'the browser pane is currently on. Use it to resolve an environment a user names (for ' +
    'example "HPE DEV") to the host to act on. Content roots default to `/content` and ' +
    'component roots to `/apps` when a host configures none. Takes no arguments - the ' +
    'application supplies the hosts.',
  parameters: z.toJSONSchema(environmentFactsArgsSchema, { io: 'input' }),
};

/** The key `sdkAgentService.ts`'s `toolHandlers` registers this executor under. */
export const ENVIRONMENT_FACTS_TOOL_NAME: string = ENVIRONMENT_FACTS_TOOL_DESCRIPTOR.name;

/** The `environment_facts` allowlist entry. */
export const ENVIRONMENT_FACTS_ALLOWLIST_ENTRY = 'custom:environment_facts';

export const environmentFactsRequestSchema = z
  .object({
    operation: z.literal('environment_facts'),
    requestId: requestIdSchema,
    args: environmentFactsArgsSchema,
  })
  .strict();

export type EnvironmentFactsRequest = z.infer<typeof environmentFactsRequestSchema>;

/** One configured host as the model sees it, with the live pane's host flagged. */
export const configuredHostFactSchema = z
  .object({
    label: z.string().min(1),
    origin: originSchema,
    contentRoots: z.array(z.string().min(1)),
    componentRoots: z.array(z.string().min(1)),
    current: z.boolean(),
  })
  .strict();

export type ConfiguredHostFact = z.infer<typeof configuredHostFactSchema>;

export const environmentFactsSuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('environment_facts'),
    requestId: requestIdSchema,
    hosts: z.array(configuredHostFactSchema),
    fetchedAt: z.number().int().nonnegative(),
  })
  .strict();

export type EnvironmentFactsSuccess = z.infer<typeof environmentFactsSuccessSchema>;

export function renderEnvironmentFactsSuccess(result: EnvironmentFactsSuccess): string {
  if (result.hosts.length === 0) {
    return 'No AEM hosts are configured. Add one in Settings, then try again.';
  }
  const lines = ['Configured AEM hosts:'];
  for (const host of result.hosts) {
    lines.push(
      `- ${host.label}${host.current ? ' (current)' : ''}: ${host.origin}; ` +
        `content roots: ${host.contentRoots.join(', ')}; ` +
        `component roots: ${host.componentRoots.join(', ')}`,
    );
  }
  return lines.join('\n');
}

/**
 * The structured success *plus* the SDK's render fields, so the transcript can
 * render the hosts from the result itself. Mirrors `ask_user`'s
 * `toSuccessPayload`.
 */
function toSuccessPayload(result: EnvironmentFactsSuccess): JsonValue {
  return {
    ...result,
    textResultForLlm: renderEnvironmentFactsSuccess(result),
    resultType: 'success',
  };
}

const ERROR_MESSAGES = {
  no_hosts: 'No AEM host is configured. Add one in Settings, then try again',
  invalid_arguments: 'Invalid environment_facts arguments',
} as const;

type ErrorMessageKey = keyof typeof ERROR_MESSAGES;

const ERROR_MAPPINGS: Readonly<Record<ErrorMessageKey, ToolErrorCode>> = {
  no_hosts: 'PRECONDITION_FAILED',
  invalid_arguments: 'INVALID_ARGUMENT',
};

function toolError(key: ErrorMessageKey, requestId: RequestId): Result<JsonValue, ToolError> {
  return err(createToolError(ERROR_MAPPINGS[key], ERROR_MESSAGES[key], requestId));
}

export interface EnvironmentFactsDeps {
  readonly configuredHosts: () => readonly {
    readonly label: string;
    readonly origin: string;
    readonly contentRoots: readonly string[];
    readonly componentRoots: readonly string[];
  }[];
  readonly currentOrigin: () => string | undefined;
  readonly now: () => number;
}

/**
 * Builds the success payload from the injected host catalogue. Exported so the
 * projection is unit-testable without a `ToolHost`.
 */
export function executeEnvironmentFacts(
  requestId: RequestId,
  deps: EnvironmentFactsDeps,
): Result<JsonValue, ToolError> {
  const hosts = deps.configuredHosts();
  if (hosts.length === 0) return toolError('no_hosts', requestId);
  const currentOrigin = deps.currentOrigin();

  const payload: EnvironmentFactsSuccess = {
    ok: true,
    operation: 'environment_facts',
    requestId,
    hosts: hosts.map((host) => ({
      label: host.label,
      origin: host.origin,
      contentRoots: [...host.contentRoots],
      componentRoots: [...host.componentRoots],
      current: currentOrigin !== undefined && originsMatch(currentOrigin, host.origin),
    })),
    fetchedAt: deps.now(),
  };
  return ok(toSuccessPayload(payload));
}

/**
 * Builds the executor. It validates the (empty) arguments and reads the host
 * catalogue and the live pane's origin fresh on every call - the model never
 * supplies a host.
 */
export function createEnvironmentFactsExecutor(host: ToolHost): AemToolExecutor {
  return (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);
    const parsed = environmentFactsArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return Promise.resolve(toolError('invalid_arguments', requestId));
    if (context.signal?.aborted === true) {
      return Promise.resolve(
        err(createToolError('CANCELLED', 'The request was cancelled', requestId)),
      );
    }
    return Promise.resolve(
      executeEnvironmentFacts(requestId, {
        configuredHosts: host.configuredHosts,
        currentOrigin: () => host.environmentFacts()?.origin,
        now: host.clock,
      }),
    );
  };
}
