import { z } from 'zod';
import {
  type AemToolExecutor,
  type BrokerOutcome,
  type CurrentAemToolContext,
  type IdGenerator,
  type JsonValue,
  type RequestId,
  type RequiredAction,
  type Result,
  type ToolDescriptor,
  type ToolErrorCode,
  type ToolOutcome,
  brokerErrorKey,
  createToolExecutor,
  envelopeCommonShape,
  err,
  jcrPathSchema,
  ok,
  originSchema,
  parseJcrPath,
  parseOrigin,
  requestIdSchema,
} from '../../shared';

/**
 * The `aem_create_page` tool: the application's **single** write path to AEM.
 *
 * Owner decision (2026-09-22): EToolbox Daisy is otherwise strictly read-only
 * against AEM (`AGENTS.md` §7.4). This one tool is the deliberate, narrowly
 * scoped exception. It can do exactly one thing - create one `cq:Page` under an
 * existing parent, through AEM's own `/bin/wcmcommand` `createPage` command -
 * and nothing else: no property edits, no deletes, no moves, no activation,
 * no package/user/permission operations. The endpoint is a module constant and
 * the command name is a module constant: there is no code path by which this
 * tool can reach any other AEM write, so "one capability" is a structural
 * property rather than a promise.
 *
 * Mirrors `./aemGetJson.ts`'s shape: argument schema and validation, model
 * descriptor, success result and model rendering, URL/body building, the error
 * wording, and the executor - all in this file. Shared, tool-agnostic pieces
 * come from their own modules; the transport is injected as
 * `fetchThroughBridge`, so this module stays pure and unit-testable.
 *
 * Two bridge round trips, in order:
 *
 *  1. `GET /libs/granite/csrf/token.json` - AEM's CSRF filter requires a token
 *     on a state-changing `POST`. Best-effort: a missing endpoint or an
 *     unreadable body proceeds without a token (an instance with the filter
 *     disabled accepts the request anyway), while an unauthenticated/redirect
 *     answer aborts before any write is attempted.
 *  2. `POST /bin/wcmcommand` with the form-encoded `createPage` command.
 *
 * The created path is read from the response body when AEM reports one, and
 * otherwise derived from `parentPath + '/' + name`; the application never
 * trusts the model to tell it where the page ended up.
 */

// ---------------------------------------------------------------------------
// Page name and title
// ---------------------------------------------------------------------------

/** AEM's own practical bound for a page name under MongoMK; well above any sensible slug. */
const PAGE_NAME_MAX_LENGTH = 150;
/** AEM derives a name from at most the first 64 characters of a title. */
const DERIVED_NAME_MAX_LENGTH = 64;
const PAGE_TITLE_MAX_LENGTH = 300;

/**
 * A JCR node name usable as a page's `label`. Deliberately conservative: it
 * permits the characters AEM itself uses for page names and rejects a slash,
 * a dot, whitespace, and control characters, any of which would let a name
 * escape the parent path, masquerade as an extension, or smuggle markup into
 * the request. This is an absolute allowlist rather than a sanitizer - a name
 * that does not fit is rejected, never silently rewritten.
 */
export const PAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const pageNameSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(PAGE_NAME_MAX_LENGTH, `must be at most ${String(PAGE_NAME_MAX_LENGTH)} characters`)
  .regex(
    PAGE_NAME_PATTERN,
    'must contain only letters, digits, hyphens, and underscores, and must not start with a hyphen or underscore',
  );

const pageTitleSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(PAGE_TITLE_MAX_LENGTH, `must be at most ${String(PAGE_TITLE_MAX_LENGTH)} characters`)
  .refine(
    (value) => ![...value].some((char) => char.codePointAt(0)! < 0x20 || char === '\u007f'),
    'must not contain control characters',
  );

/**
 * Derives a page name from a title, following AEM's own convention (lowercase
 * words joined by hyphens, invalid runs collapsed), bounded to the 64
 * characters AEM itself would use. Never returns an empty string: an
 * all-punctuation title yields `"page"`, so the derived name is always a name
 * the server will accept.
 */
export function deriveNameFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, DERIVED_NAME_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'page';
}

/**
 * Derives a human title from a page name by splitting on its separators and
 * capitalising each word (`my-new-page` -> `My New Page`). The inverse is
 * intentionally lossy - it cannot know the original casing - which is exactly
 * why `deriveNameFromTitle` is only used when the user gave no name.
 */
export function deriveTitleFromName(name: string): string {
  const words = name.split(/[-_]+/).filter((word) => word.length > 0);
  if (words.length === 0) return name;
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

// ---------------------------------------------------------------------------
// Arguments, descriptor, request envelope
// ---------------------------------------------------------------------------

export const aemCreatePageArgsSchema = z
  .object({
    parentPath: jcrPathSchema,
    name: pageNameSchema.optional(),
    title: pageTitleSchema.optional(),
    template: jcrPathSchema,
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.name === undefined && args.title === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: "at least one of 'name' or 'title' is required; the other is derived from it",
      });
    }
  });

export type AemCreatePageArgs = z.infer<typeof aemCreatePageArgsSchema>;

/**
 * The fully resolved request: every field the tool acts on, with `name` and
 * `title` both present. A distinct shape from the tool arguments so the
 * "one of these was absent" case is impossible past validation.
 */
export interface ResolvedCreatePageTarget {
  readonly parentPath: string;
  readonly name: string;
  readonly title: string;
  readonly template: string;
}

/**
 * Resolves the derived/missing pair. A name the caller supplied is used
 * verbatim; otherwise it is derived from the title. Likewise for the title.
 */
export function resolveCreatePageTarget(args: AemCreatePageArgs): ResolvedCreatePageTarget {
  const name = args.name ?? deriveNameFromTitle(args.title!);
  const title = args.title ?? deriveTitleFromName(name);
  return { parentPath: args.parentPath, name, title, template: args.template };
}

export const AEM_CREATE_PAGE_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: 'aem_create_page',
  description:
    'Creates one new AEM page (a `cq:Page`) under an existing parent path, using AEM\u2019s ' +
    'own page-creation command. THIS IS THE ONLY TOOL THAT WRITES TO AEM: use it only when ' +
    'the user explicitly asks to create a page, and only after you have every value below. ' +
    '`parentPath` must be a bare absolute repository path to the *existing* parent page (no ' +
    'scheme, host, query, or trailing slash). `template` must be the absolute repository path ' +
    'of an existing page template (e.g. `/conf/<site>/settings/wcm/templates/<template>`). ' +
    'Supply `title` (the human-readable page title) and/or `name` (the URL segment / node ' +
    'name). At least one is required: if `name` is omitted it is derived from the title; if ' +
    '`title` is omitted it is derived from the name. `name` accepts only letters, digits, ' +
    'hyphens, and underscores. The tool returns the created page path; it cannot edit, move, ' +
    'delete, or publish anything, and it cannot create a page whose parent does not already ' +
    'exist.',
  parameters: z.toJSONSchema(aemCreatePageArgsSchema, { io: 'input' }),
};

/** The key `sdkAgentService.ts`'s `toolHandlers` registers this executor under. */
export const AEM_CREATE_PAGE_TOOL_NAME: string = AEM_CREATE_PAGE_TOOL_DESCRIPTOR.name;

/** The source-qualified allowlist entry this tool is registered under. */
export const AEM_CREATE_PAGE_ALLOWLIST_ENTRY = 'custom:aem_create_page';

export const aemCreatePageRequestSchema = z
  .object({
    operation: z.literal('aem_create_page'),
    ...envelopeCommonShape,
    args: aemCreatePageArgsSchema,
  })
  .strict();

export type AemCreatePageRequest = z.infer<typeof aemCreatePageRequestSchema>;

// ---------------------------------------------------------------------------
// Success result and model rendering
// ---------------------------------------------------------------------------

export const aemCreatePageSuccessSchema = z
  .object({
    ok: z.literal(true),
    operation: z.literal('aem_create_page'),
    requestId: requestIdSchema,
    sourceOrigin: originSchema,
    serverRevision: z.number().int().nonnegative(),
    parentPath: jcrPathSchema,
    name: pageNameSchema,
    title: pageTitleSchema,
    template: jcrPathSchema,
    path: jcrPathSchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type AemCreatePageSuccess = z.infer<typeof aemCreatePageSuccessSchema>;

/** What `executeAemCreatePage` resolves: this tool's success shape, or the shared error arm. */
export type AemCreatePageResult = ToolOutcome<AemCreatePageSuccess>;

/**
 * Renders the created page for the model. The bare repository path is stated
 * on its own line **without** code-span or link syntax: the renderer's message
 * linkifier turns a bare `/content/...` path into an edit-mode link, so writing
 * it plainly is what makes the result clickable.
 */
export function renderCreatePageSuccess(result: AemCreatePageSuccess): string {
  return [
    `Created AEM page ${result.path} (origin ${result.sourceOrigin}, revision ` +
      `${String(result.serverRevision)}, created at ${String(result.createdAt)}).`,
    `Title: ${result.title}; name: ${result.name}; template: ${result.template}.`,
    `Bare path: ${result.path}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Request URLs and body
// ---------------------------------------------------------------------------

const WCM_COMMAND_ENDPOINT_PATH = '/bin/wcmcommand';
const CSRF_TOKEN_ENDPOINT_PATH = '/libs/granite/csrf/token.json';
const CREATE_PAGE_COMMAND = 'createPage';
const CSRF_PARAMETER_NAME = ':cq_csrf_token';

export type BuildCreatePageUrlError = { readonly kind: 'invalid_origin' };

/** The one URL this tool ever writes to: `{origin}/bin/wcmcommand`, re-parsed and checked. */
export function buildWcmCommandUrl(origin: string): Result<string, BuildCreatePageUrlError> {
  return buildFixedEndpointUrl(origin, WCM_COMMAND_ENDPOINT_PATH);
}

/** The read that mints the CSRF token the `POST` must carry. */
export function buildCsrfTokenUrl(origin: string): Result<string, BuildCreatePageUrlError> {
  return buildFixedEndpointUrl(origin, CSRF_TOKEN_ENDPOINT_PATH);
}

function buildFixedEndpointUrl(
  origin: string,
  path: string,
): Result<string, BuildCreatePageUrlError> {
  const originResult = parseOrigin(origin);
  if (!originResult.ok) return err({ kind: 'invalid_origin' });

  let url: URL;
  try {
    url = new URL(`${originResult.origin}${path}`);
  } catch {
    return err({ kind: 'invalid_origin' });
  }
  if (
    url.origin !== originResult.origin ||
    url.pathname !== path ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return err({ kind: 'invalid_origin' });
  }
  return ok(url.toString());
}

/**
 * Builds the form-encoded `/bin/wcmcommand` body for one `createPage` command.
 *
 * Serialization goes through `URLSearchParams`, so a title containing `&`, `=`,
 * `#`, or a newline cannot introduce a parameter or truncate the body. The
 * parameter names are the ones AEM's own page-creation command reads
 * (`AGENTS.md`/plan: `cmd`, `parentPath`, `label`, `title`, `template`), and
 * none of them is caller-chosen: the command name is a constant and the rest
 * are the validated, resolved target.
 */
export function buildCreatePageBody(
  target: ResolvedCreatePageTarget,
  csrfToken: string | undefined,
): Result<string, { readonly kind: 'unencodable_body' }> {
  try {
    const params = new URLSearchParams();
    params.append('cmd', CREATE_PAGE_COMMAND);
    params.append('parentPath', target.parentPath);
    params.append('label', target.name);
    params.append('title', target.title);
    params.append('template', target.template);
    if (csrfToken !== undefined && csrfToken.length > 0) {
      params.append(CSRF_PARAMETER_NAME, csrfToken);
    }
    return ok(params.toString());
  } catch {
    return err({ kind: 'unencodable_body' });
  }
}

/**
 * Reads the CSRF token out of a `/libs/granite/csrf/token.json` body:
 * `{ "token": "..." }`. Returns `undefined` for anything else - a missing
 * endpoint, a non-JSON body, a token of the wrong type - because the caller
 * treats "no token" as "proceed without one" and lets the write itself be the
 * thing that fails if the instance really did require one.
 */
export function readCsrfToken(bodyText: string): string | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  const token = (candidate as Record<string, unknown>)['token'];
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Reads the created path out of a `/bin/wcmcommand` response body when the
 * instance reports one (`{ "path": "/content/..." }` or a `location` field),
 * and `undefined` otherwise. Only a bare absolute repository path is accepted;
 * anything else falls back to the deterministic `parentPath/name` derivation in
 * `executeAemCreatePage`.
 */
export function readCreatedPath(bodyText: string): string | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  for (const key of ['path', 'location'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.startsWith('/') && parseJcrPath(value).ok) {
      return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Handler: error taxonomy and HTTP -> result
// ---------------------------------------------------------------------------

const ERROR_MESSAGES = {
  invalid_origin: 'The current server address could not be used to build a request.',
  unencodable_body: 'The page-creation request could not be encoded.',
  cross_origin: 'The request was refused because it would have left the current server.',
  redirect_blocked:
    'AEM redirected the request away from the server, which usually means the session has expired.',
  create_redirected:
    'AEM redirected the page-creation request. The session may have expired; sign in again ' +
    'and check the parent path for the page before retrying.',
  no_view: 'The AEM browser pane is not available, so no request could be made.',
  bridge_unavailable:
    'The AEM browser pane is present but its request bridge is not available, so no request ' +
    'could be made. This is an application problem, not an AEM one.',
  network_error: 'The request to AEM could not be completed.',
  cancelled: 'The request was cancelled.',
  timeout: 'AEM did not respond before the request deadline.',
  stale_server_revision: 'The server configuration changed while the request was in flight.',
  stale_navigation_epoch: 'The browser left the page this request was made for.',
  unauthorized: 'AEM did not accept the current session. Sign in again in the browser pane.',
  forbidden:
    'AEM refused to create the page. The account may not be allowed to create pages under ' +
    'that parent, or the request\u2019s CSRF token was rejected.',
  not_found:
    'AEM does not offer the page-creation command at that path, or the parent page does not exist.',
  bad_request: 'AEM rejected the page-creation request as malformed.',
  server_error: 'AEM returned a server error while creating the page.',
  unexpected_status: 'AEM returned an unexpected status for the page-creation request.',
} as const;

type ErrorMessageKey = keyof typeof ERROR_MESSAGES;

interface ErrorMapping {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly requiredAction: RequiredAction;
}

const ERROR_MAPPINGS: Readonly<Record<ErrorMessageKey, ErrorMapping>> = {
  invalid_origin: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'select_server' },
  unencodable_body: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  cross_origin: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  redirect_blocked: {
    code: 'REDIRECT_BLOCKED',
    retryable: false,
    requiredAction: 'sign_in_to_aem',
  },
  create_redirected: {
    code: 'REDIRECT_BLOCKED',
    retryable: false,
    requiredAction: 'sign_in_to_aem',
  },
  no_view: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'select_server' },
  bridge_unavailable: { code: 'ACCESS_DENIED', retryable: false, requiredAction: 'none' },
  network_error: { code: 'NETWORK_ERROR', retryable: true, requiredAction: 'none' },
  cancelled: { code: 'CANCELLED', retryable: true, requiredAction: 'none' },
  timeout: { code: 'TIMEOUT', retryable: true, requiredAction: 'none' },
  stale_server_revision: { code: 'STALE_CONTEXT', retryable: true, requiredAction: 'none' },
  stale_navigation_epoch: { code: 'STALE_CONTEXT', retryable: true, requiredAction: 'none' },
  unauthorized: { code: 'AUTH_REQUIRED', retryable: false, requiredAction: 'sign_in_to_aem' },
  forbidden: { code: 'NOT_AUTHORIZED', retryable: false, requiredAction: 'none' },
  not_found: { code: 'NOT_FOUND', retryable: false, requiredAction: 'none' },
  bad_request: { code: 'INVALID_ARGUMENT', retryable: false, requiredAction: 'none' },
  server_error: { code: 'UNEXPECTED_RESPONSE', retryable: true, requiredAction: 'none' },
  unexpected_status: { code: 'UNEXPECTED_RESPONSE', retryable: false, requiredAction: 'none' },
};

function toolError(key: ErrorMessageKey, requestId: RequestId): AemCreatePageResult {
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

/** The HTTP statuses `/bin/wcmcommand` `createPage` answers with on success. */
const SUCCESS_STATUSES = new Set([200, 201]);

/** One bridge round trip's HTTP shape; see `BrokerRequestInit` in `bridgeBroker.ts`. */
export interface CreatePageRequestInit {
  readonly method: 'GET' | 'POST';
  readonly body?: string;
}

export interface AemCreatePageDeps {
  readonly origin: string;
  /**
   * Performs one bridge round trip. Two-argument (unlike the read tools') so
   * the write can carry a method and form body through the same transport.
   */
  readonly fetchThroughBridge: (
    url: string,
    init?: CreatePageRequestInit,
  ) => Promise<BrokerOutcome>;
  readonly now: () => number;
}

type CsrfReadOutcome =
  | { readonly kind: 'proceed'; readonly token: string | undefined }
  | { readonly kind: 'failure'; readonly key: ErrorMessageKey };

/**
 * Decides what the CSRF read means for the write that follows.
 *
 * `404` means the token endpoint does not exist, which is how an instance with
 * the CSRF filter disabled presents itself - the write proceeds without a token.
 * A redirect, a 401, or a transport failure aborts, because the write cannot
 * succeed if the same session cannot even read the token.
 */
function readCsrfOutcome(outcome: BrokerOutcome): CsrfReadOutcome {
  if (outcome.kind !== 'response') {
    return { kind: 'failure', key: brokerErrorKey(outcome) };
  }
  const { status } = outcome;
  if (status === 200) return { kind: 'proceed', token: readCsrfToken(outcome.bodyText) };
  if (status === 404) return { kind: 'proceed', token: undefined };
  if (status === 401) return { kind: 'failure', key: 'unauthorized' };
  if (status === 403) return { kind: 'failure', key: 'forbidden' };
  if (status >= 300 && status < 400) return { kind: 'failure', key: 'redirect_blocked' };
  if (status >= 500) return { kind: 'failure', key: 'server_error' };
  return { kind: 'proceed', token: undefined };
}

function classifyCreateResponse(
  outcome: BrokerOutcome,
): Result<string | undefined, ErrorMessageKey> {
  if (outcome.kind !== 'response') {
    return err(brokerErrorKey(outcome));
  }
  const { status } = outcome;
  if (SUCCESS_STATUSES.has(status)) {
    return ok(readCreatedPath(outcome.bodyText));
  }
  if (status === 401) return err('unauthorized');
  if (status === 403) return err('forbidden');
  if (status === 404) return err('not_found');
  if (status === 400) return err('bad_request');
  if (status >= 300 && status < 400) return err('create_redirected');
  if (status >= 500) return err('server_error');
  return err('unexpected_status');
}

/** `parentPath` without a trailing slash (the JCR validator already rejects one), plus the name. */
function deriveCreatedPath(target: ResolvedCreatePageTarget): string {
  return `${target.parentPath}/${target.name}`;
}

export async function executeAemCreatePage(
  envelope: AemCreatePageRequest,
  deps: AemCreatePageDeps,
): Promise<AemCreatePageResult> {
  const target = resolveCreatePageTarget(envelope.args);

  const commandUrl = buildWcmCommandUrl(deps.origin);
  if (!commandUrl.ok) return toolError(commandUrl.error.kind, envelope.requestId);

  const tokenUrl = buildCsrfTokenUrl(deps.origin);
  if (!tokenUrl.ok) return toolError(tokenUrl.error.kind, envelope.requestId);

  const csrfOutcome = readCsrfOutcome(await deps.fetchThroughBridge(tokenUrl.value));
  if (csrfOutcome.kind === 'failure') {
    return toolError(csrfOutcome.key, envelope.requestId);
  }

  const body = buildCreatePageBody(target, csrfOutcome.token);
  if (!body.ok) return toolError(body.error.kind, envelope.requestId);

  const createOutcome = await deps.fetchThroughBridge(commandUrl.value, {
    method: 'POST',
    body: body.value,
  });
  const classified = classifyCreateResponse(createOutcome);
  if (!classified.ok) return toolError(classified.error, envelope.requestId);

  const path = classified.value ?? deriveCreatedPath(target);

  return {
    ok: true,
    operation: 'aem_create_page',
    requestId: envelope.requestId,
    sourceOrigin: deps.origin,
    serverRevision: envelope.serverRevision,
    parentPath: target.parentPath,
    name: target.name,
    title: target.title,
    template: target.template,
    path,
    createdAt: deps.now(),
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export type AemCreatePageRequestEnvelope = AemCreatePageRequest;

export interface AemCreatePageExecutorConfig<TRuntimeDeps extends Record<string, unknown>> {
  readonly execute: (
    envelope: AemCreatePageRequest,
    deps: { readonly origin: string } & TRuntimeDeps,
  ) => Promise<AemCreatePageResult>;
  readonly runtimeDeps: TRuntimeDeps;
  readonly currentContext: () => CurrentAemToolContext;
  readonly clock: () => number;
  readonly idGenerator: IdGenerator;
}

/**
 * The full structured success, *plus* the SDK's own render fields.
 *
 * Unlike the read tools - whose executed result and `tool.result` payload are
 * only `{ textResultForLlm, resultType }` - this tool keeps its structured
 * fields in the payload (`path`, `sourceOrigin`, ...). That is what lets the
 * transcript render the created path as a clickable link from the result
 * itself, on the real SDK path, rather than depending on the model to repeat
 * the path in its prose. `textResultForLlm` is also present, so the SDK's
 * `isToolResultObject()` check still sees the standard shape.
 */
function toSuccessPayload(result: AemCreatePageSuccess): JsonValue {
  return {
    ...result,
    textResultForLlm: renderCreatePageSuccess(result),
    resultType: 'success',
  };
}

export function createAemCreatePageExecutor<TRuntimeDeps extends Record<string, unknown>>(
  config: AemCreatePageExecutorConfig<TRuntimeDeps>,
): AemToolExecutor {
  return createToolExecutor({
    operation: 'aem_create_page',
    argsSchema: aemCreatePageArgsSchema,
    requestSchema: aemCreatePageRequestSchema,
    render: renderCreatePageSuccess,
    toPayload: toSuccessPayload,
    failureFallbackMessage: 'AEM page creation failed.',
    ...config,
  });
}
