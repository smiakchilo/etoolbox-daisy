import { z } from 'zod';
import {
  type AemToolExecutor,
  type ConfiguredHostInfo,
  type JsonValue,
  type OpenPageOutcome,
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
  originsMatch,
  requestIdSchema,
  validateBrowserPath,
} from '../../shared';

/**
 * The `browser_navigate` tool, self-contained.
 *
 * Opens a page in the browser pane on a configured AEM host. The model supplies
 * a host *label* (or omits it for the host the pane is on) and a verbatim
 * browser path; the application resolves the label to a configured host and
 * builds the URL from that host's own origin, so no scheme, port or origin can
 * reach the pane from a tool argument.
 *
 * Hand-rolled rather than built on `createToolExecutor`: it must work with no
 * active AEM server (an explicit host is enough), and it performs no AEM read.
 *
 * No `aem_` prefix: navigating a browser pane is not AEM-specific
 * (AGENTS.md section 5).
 */

export const BROWSER_NAVIGATE_TOOL_NAME = 'browser_navigate';
export const BROWSER_NAVIGATE_ALLOWLIST_ENTRY = 'custom:browser_navigate';

export const browserNavigateArgsObjectSchema = z
  .object({
    /**
     * A configured host's label (e.g. "HPE DEV"). Omit it to target the host
     * the browser pane is currently on.
     */
    host: z.string().min(1).max(200).optional(),
    /** A verbatim browser path beginning with `/` (e.g. `/content/wkend.html`, `/crx/de`). */
    path: z.string().min(1).max(2000),
  })
  .strict();

export type BrowserNavigateArgs = z.infer<typeof browserNavigateArgsObjectSchema>;

const PATH_REJECTION_MESSAGES = {
  empty: 'the path must not be empty',
  not_absolute: "the path must begin with '/'",
  protocol_relative: "the path must not begin with '//'",
  too_long: 'the path is too long',
  unsafe_characters: 'the path must not contain whitespace or control characters',
} as const;

export const browserNavigateArgsSchema = browserNavigateArgsObjectSchema.superRefine(
  (value, ctx) => {
    const check = validateBrowserPath(value.path);
    if (!check.ok) {
      ctx.addIssue({
        code: 'custom',
        message: PATH_REJECTION_MESSAGES[check.error],
        path: ['path'],
      });
    }
  },
);

export const BROWSER_NAVIGATE_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: BROWSER_NAVIGATE_TOOL_NAME,
  description:
    'Opens a page in the browser pane. `host` names a configured AEM host by its label (get the ' +
    'labels with environment_facts); omit it to use the host the pane is already on. `path` is ' +
    "the verbatim browser path, beginning with '/': a content page's rendered view " +
    '(`/content/site/page.html`), its editor (`/editor.html/content/site/page.html`), or any ' +
    'other path on the host such as `/crx/de`. Never include a scheme, host or port. The ' +
    'application resolves the label to the configured host and builds the URL itself.',
  // The base object, not the refined schema: `z.toJSONSchema` cannot describe a
  // `.superRefine` side-constraint, and the path rules are enforced by the
  // executor's validation, not by the model-facing JSON schema.
  parameters: z.toJSONSchema(browserNavigateArgsObjectSchema, { io: 'input' }),
};

export const browserNavigateRequestSchema = z
  .object({
    operation: z.literal('browser_navigate'),
    requestId: requestIdSchema,
    args: browserNavigateArgsObjectSchema,
  })
  .strict();

export type BrowserNavigateRequest = z.infer<typeof browserNavigateRequestSchema>;

export const browserNavigateSuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('browser_navigate'),
    requestId: requestIdSchema,
    hostLabel: z.string().min(1),
    origin: z.string().min(1),
    path: z.string().min(1),
    url: z.string().min(1),
    switched: z.boolean(),
  })
  .strict();

export type BrowserNavigateSuccess = z.infer<typeof browserNavigateSuccessSchema>;

export function renderBrowserNavigateSuccess(result: BrowserNavigateSuccess): string {
  return (
    `Opened ${result.url} on host ${result.hostLabel}` +
    (result.switched ? ' (switched hosts)' : '') +
    '.'
  );
}

function toSuccessPayload(result: BrowserNavigateSuccess): JsonValue {
  return {
    ...result,
    textResultForLlm: renderBrowserNavigateSuccess(result),
    resultType: 'success',
  };
}

const ERROR_MESSAGES = {
  invalid_arguments: 'Invalid browser_navigate arguments',
  no_hosts: 'No AEM host is configured. Add one in Settings, then try again',
  unknown_host: 'No configured host has that label',
  ambiguous_host: 'More than one configured host has that label',
  no_current_host:
    'The browser pane is not on a configured host, so no host could be inferred. Name one, or ' +
    'open a configured host first',
  server_not_found: 'That configured host no longer exists',
  no_view: 'The browser pane is not available, so nothing could be opened',
  invalid_path: 'The page path could not be used to build a URL for that host',
  cancelled: 'The navigation was replaced before it loaded',
  storage_error: 'The application could not read its settings',
  network_error: 'The page could not be loaded',
} as const;

type ErrorMessageKey = keyof typeof ERROR_MESSAGES;

const ERROR_MAPPINGS: Readonly<Record<ErrorMessageKey, ToolErrorCode>> = {
  invalid_arguments: 'INVALID_ARGUMENT',
  no_hosts: 'PRECONDITION_FAILED',
  unknown_host: 'INVALID_ARGUMENT',
  ambiguous_host: 'INVALID_ARGUMENT',
  no_current_host: 'PRECONDITION_FAILED',
  server_not_found: 'PRECONDITION_FAILED',
  no_view: 'PRECONDITION_FAILED',
  invalid_path: 'INVALID_ARGUMENT',
  cancelled: 'CANCELLED',
  storage_error: 'STORAGE_ERROR',
  network_error: 'NETWORK_ERROR',
};

/** Maps a Chromium `ERR_*` code to the narrowest justified tool error code. */
function networkErrorCode(errorCode: string): ToolErrorCode {
  if (/CERT/i.test(errorCode)) return 'TLS_ERROR';
  if (/PROXY/i.test(errorCode)) return 'PROXY_ERROR';
  return 'NETWORK_ERROR';
}

function toolError(
  key: ErrorMessageKey,
  requestId: RequestId,
  message = ERROR_MESSAGES[key],
): Result<JsonValue, ToolError> {
  return err(createToolError(ERROR_MAPPINGS[key], message, requestId));
}

function listLabels(hosts: readonly ConfiguredHostInfo[]): string {
  return hosts.length > 0 ? hosts.map((host) => host.label).join(', ') : '(none)';
}

/** Resolves the model's `host` label (or the pane's current host) to a configured host. */
export function resolveNavigateHost(
  args: BrowserNavigateArgs,
  hosts: readonly ConfiguredHostInfo[],
  currentOrigin: string | undefined,
): Result<ConfiguredHostInfo, { key: ErrorMessageKey; message?: string }> {
  if (hosts.length === 0) return err({ key: 'no_hosts' });

  const requested = args.host?.trim();
  if (requested !== undefined && requested.length > 0) {
    const matches = hosts.filter((host) => host.label.toLowerCase() === requested.toLowerCase());
    if (matches.length === 0) {
      return err({
        key: 'unknown_host',
        message: `No configured host is labelled "${requested}". Configured hosts: ${listLabels(hosts)}`,
      });
    }
    if (matches.length > 1) {
      return err({
        key: 'ambiguous_host',
        message:
          `More than one configured host is labelled "${requested}". ` +
          `Configured hosts: ${listLabels(hosts)}`,
      });
    }
    return ok(matches[0] as ConfiguredHostInfo);
  }

  if (currentOrigin === undefined) return err({ key: 'no_current_host' });
  const current = hosts.find((host) => originsMatch(host.origin, currentOrigin));
  if (current === undefined) return err({ key: 'no_current_host' });
  return ok(current);
}

function outcomeToResult(
  outcome: OpenPageOutcome,
  host: ConfiguredHostInfo,
  args: BrowserNavigateArgs,
  requestId: RequestId,
): Result<JsonValue, ToolError> {
  switch (outcome.kind) {
    case 'opened':
      return ok(
        toSuccessPayload({
          ok: true,
          operation: BROWSER_NAVIGATE_TOOL_NAME,
          requestId,
          hostLabel: host.label,
          origin: host.origin,
          path: args.path,
          url: outcome.url,
          switched: outcome.switched,
        }),
      );
    case 'network_error':
      return err(
        createToolError(
          networkErrorCode(outcome.errorCode),
          ERROR_MESSAGES.network_error,
          requestId,
        ),
      );
    case 'invalid_path':
      return toolError('invalid_path', requestId);
    case 'server_not_found':
      return toolError('server_not_found', requestId);
    case 'storage_error':
      return toolError('storage_error', requestId);
    case 'no_view':
      return toolError('no_view', requestId);
    case 'cancelled':
      return toolError('cancelled', requestId);
  }
}

export function createBrowserNavigateExecutor(host: ToolHost): AemToolExecutor {
  return async (rawArgs, context) => {
    const requestId = newRequestId(host.idGenerator);

    const parsed = browserNavigateArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? ERROR_MESSAGES.invalid_arguments;
      return toolError('invalid_arguments', requestId, message);
    }
    if (context.signal?.aborted === true) {
      return err(createToolError('CANCELLED', ERROR_MESSAGES.cancelled, requestId));
    }

    const resolved = resolveNavigateHost(
      parsed.data,
      host.configuredHosts(),
      host.environmentFacts()?.origin,
    );
    if (!resolved.ok) {
      return toolError(resolved.error.key, requestId, resolved.error.message);
    }

    const outcome = await host.openPage({
      serverId: resolved.value.serverId,
      path: parsed.data.path,
    });
    return outcomeToResult(outcome, resolved.value, parsed.data, requestId);
  };
}
